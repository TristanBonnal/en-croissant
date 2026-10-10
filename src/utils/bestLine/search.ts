import type { Color } from "chessops";
import type { BestMoves } from "@/bindings";
import {
    admissibleMoves,
    mistakeAnnotation,
    type AnalysisRequest,
    type ExplorerMove,
    type ExplorerPosition,
    TRAP_MIN_GAIN,
    TRAP_MIN_GAMES,
    type Tolerance,
} from "@/utils/bestLine";
import {
    backup,
    backupOptionsOf,
    type Edge,
    type EdgeStatus,
    isLive,
    type SearchNode,
} from "./node";
import { legalMoveCount, playSan, positionOf, sanKey, uciOf } from "./position";
import { keptEdges } from "./project";
import type { Frontier } from "./frontier";
import { type Lookahead, nextPositions } from "./optimism";
import { moveProbabilities } from "./probability";
import {
    addOutcome,
    drawWeightOf,
    expectedScore,
    type Metric,
    type Outcome,
    outcomeOf,
    type Rates,
    ratesOf,
    shrinkRates,
    subtractOutcome,
    totalGames,
} from "./stats";
import { DEFAULT_DRAW_RATE, engineValue, statsValue, terminalValue, type Value } from "./value";

/**
 * The search. It grows a tree whose value is, at every position, the result the
 * studied side can expect *while playing the moves this tree recommends* — not
 * the average result of everyone who reached it. Positions are opened where
 * they can still change a decision (`nextPositions`), and a branch is never
 * opened when a game reaches it less often than `minReach`.
 */

/** Uncertainty of the root before it is opened. */
const SIGMA_FLOOR = 0.01;
/** Last-resort stop, for a search that would otherwise run for hours. */
const MAX_EXPANDED = 3000;
/** Lines of the engine's first analysis of a studied position: its candidates. */
const MAX_CANDIDATES = 5;
/** Moves played often enough that the engine ranks lower, checked in a second analysis. */
const MAX_EXTRA_CANDIDATES = 5;
/** Frequent mistakes of the opponent examined per position when branching on traps. */
const MAX_TRAPS = 3;
/** Opponent replies listed but not searched, for the result table. */
const LISTED_REPLIES = 5;
/** What choosing a move is hoped to add before any studied position was opened. */
const FIRST_CHOICE_GAIN = 0.05;
/** Positions next in line whose explorer data is fetched ahead of their turn. */
const LOOKAHEAD = 4;

/**
 * Games from which the results of a position stand against the engine's
 * evaluation of it, however few the explorer has to follow its moves. A move
 * needs as many to be ranked on its results; fewer are not worth more than the
 * engine's word.
 */
const TRUST_FLOOR = 50;

/** Games the rates of a position are worth when shrinking the moves played from it. */
export const DEFAULT_SHRINKAGE = 100;
/** Standard errors taken off a value before comparing it. */
export const DEFAULT_RISK = 1;
/** Smoothing of the opponent's shares, in fictitious games per legal move. */
export const DEFAULT_SMOOTHING = 1;

const EVEN: Rates = { win: 0.25, draw: 0.5, loss: 0.25 };

export type SearchParams = {
    fen: string;
    color: Color;
    /** Maximum number of moves played from the starting position. */
    maxPlies: number;
    /** Evaluation loss accepted against the engine's best move. */
    tolerance: Tolerance;
    metric: Metric;
    /** Games a position needs for the search to follow the explorer. */
    minimumGames: number;
    /** Games a candidate needs to be ranked on its results. */
    minGamesPerMove: number;
    /** Share of the position's games a candidate needs to be ranked on its results. */
    minMoveShare: number;
    /**
     * When set, an opponent mistake played at least this often is opened even
     * below `minReach`, if the studied side scores well after it.
     */
    trapMinShare?: number;
    /** Share of the games a position must be reached in to be opened. */
    minReach: number;
    /** How likely the starting position is to be reached, when the search continues a line. */
    reach?: number;
    /** Games the rates of a position are worth when shrinking its moves. */
    shrinkage: number;
    /** Standard errors taken off a value before comparing it. */
    risk: number;
    /** Smoothing of the opponent's shares. */
    smoothing: number;
    /** Move played first instead of the one the search would choose. */
    forcedMove?: string;
    /**
     * What of the tree is kept: the engine's line below the positions the
     * explorer leaves is only played out for that. Defaults to the whole tree.
     */
    mode?: "line" | "tree";
    /** Plies of the tree that are kept, the engine's line being played out that far only. */
    keepPlies?: number;
};

export type SearchStats = {
    /** Positions opened (one explorer request each). */
    expanded: number;
    /** Candidates dropped because they could not catch up. */
    pruned: number;
    /** Replies left closed because they are reached too rarely. */
    lowReach: number;
    /** Positions the explorer knows too little about. */
    outOfBook: number;
    cancelled: boolean;
    /** Whether the last-resort stop was reached. */
    exhausted: boolean;
};

export type SearchDeps = {
    analyze: (fen: string, request: AnalysisRequest) => Promise<BestMoves[]>;
    explore: (fen: string) => Promise<ExplorerPosition>;
    /**
     * Starts fetching, without waiting, the explorer data of a position the
     * search will probably open soon, so that `explore` finds it ready. Returns
     * false when it can't start now, to be offered again later.
     */
    prefetch?: (fen: string) => boolean;
    isCancelled?: () => boolean;
    onProgress?: (stats: SearchStats, root: SearchNode) => void;
};

function turnOf(fen: string): Color {
    return fen.split(" ")[1] === "b" ? "black" : "white";
}

function moveOutcome(explorer: ExplorerPosition, san: string, studied: Color): Outcome {
    const move = explorer.moves.find((m) => sanKey(m.san) === sanKey(san));
    return move ? outcomeOf(move, studied) : { wins: 0, draws: 0, losses: 0 };
}

/** Draw rate known around a position, which converts an evaluation to the metric. */
function drawRateOf(node: SearchNode): number {
    for (let current: SearchNode | undefined = node; current; current = current.parent?.node) {
        if (current.rates && totalGames(current.outcome) > 0) return current.rates.draw;
    }
    return DEFAULT_DRAW_RATE;
}

export async function searchBestLine(
    params: SearchParams,
    deps: SearchDeps,
): Promise<{ root: SearchNode; stats: SearchStats }> {
    const drawWeight = drawWeightOf(params.metric);
    const options = backupOptionsOf(params.risk);
    const trustGames = Math.max(params.minGamesPerMove, TRUST_FLOOR);
    const keepPlies = params.keepPlies ?? Number.POSITIVE_INFINITY;
    const stats: SearchStats = {
        expanded: 0,
        pruned: 0,
        lowReach: 0,
        outOfBook: 0,
        cancelled: false,
        exhausted: false,
    };

    const root: SearchNode = {
        fen: params.fen,
        studied: turnOf(params.fen) === params.color,
        ply: 0,
        reach: params.reach ?? 1,
        outcome: { wins: 0, draws: 0, losses: 0 },
        value: { mean: 0.5, sigma: SIGMA_FLOOR, source: "engine" },
    };

    /** Value of a position as a leaf: its own games, or the engine. */
    function leafValue(node: SearchNode, lines: BestMoves[]): Value {
        if (totalGames(node.outcome) >= params.minimumGames && node.rates) {
            return statsValue(node.outcome, node.rates, params.shrinkage, drawWeight);
        }
        const [best] = lines;
        return best
            ? engineValue(best.score, params.color, drawWeight, drawRateOf(node))
            : node.value;
    }

    function attachChild(node: SearchNode, edge: Edge, reach: number) {
        const next = playSan(node.fen, edge.san);
        if (!next) return;
        const child: SearchNode = {
            fen: next.fen,
            studied: !node.studied,
            ply: node.ply + 1,
            reach,
            parent: { node, edge },
            outcome: edge.outcome,
            value: edge.value,
        };
        edge.child = child;
        if (child.ply >= params.maxPlies) child.stopped = "maxPly";
    }

    /** The single move the engine plays where the explorer knows too little. */
    async function followEngine(node: SearchNode) {
        const request: AnalysisRequest = node.studied
            ? { purpose: "decision", multipv: 1 }
            : { purpose: "evaluation", multipv: 1 };
        const [best] = await deps.analyze(node.fen, request);
        if (!best) {
            node.stopped = "noMove";
            return;
        }
        const san = best.sanMoves[0];
        const edge: Edge = {
            san,
            uci: best.uciMoves[0],
            outcome: { wins: 0, draws: 0, losses: 0 },
            probability: node.studied ? 0 : 1,
            score: best.score,
            status: node.studied ? "chosen" : "reply",
            decidedBy: "outOfBook",
            value: engineValue(best.score, params.color, drawWeight, drawRateOf(node)),
            expansions: 0,
        };
        node.edges = [edge];
        // A position valued on its own games keeps that value: the engine only plays on.
        if (!node.pinned) node.value = edge.value;
        attachChild(node, edge, node.reach);
    }

    /** A move of the explorer, as an edge of a studied node not compared with the engine yet. */
    function explorerEdge(node: SearchNode, move: ExplorerMove, status: EdgeStatus): Edge {
        const outcome = outcomeOf(move, params.color);
        return {
            san: move.san,
            uci: uciOf(node.fen, move.san) ?? move.uci,
            outcome,
            probability: 0,
            status,
            value: node.rates
                ? statsValue(outcome, node.rates, params.shrinkage, drawWeight)
                : node.value,
            expansions: 0,
        };
    }

    /** A line of the engine for a move the explorer has no games of, as an edge. */
    function engineEdge(node: SearchNode, line: BestMoves, status: EdgeStatus): Edge {
        return {
            san: line.sanMoves[0],
            uci: line.uciMoves[0],
            outcome: { wins: 0, draws: 0, losses: 0 },
            probability: 0,
            status,
            value: engineValue(line.score, params.color, drawWeight, drawRateOf(node)),
            expansions: 0,
        };
    }

    /**
     * The engine's first lines stop at its MultiPV. When the last one is still
     * within tolerance, moves it ranks lower may be too, and those played often
     * enough to be ranked on their results must not be left out for that: one
     * more analysis, restricted to the most played of them, checks them at the
     * same depth. Positions where the fifth line is already out of tolerance
     * pay nothing.
     */
    async function withPlayedMoves(
        node: SearchNode,
        lines: BestMoves[],
        explorer: ExplorerPosition,
        enough: (move: ExplorerMove) => boolean,
    ): Promise<BestMoves[]> {
        const last = lines[lines.length - 1];
        if (lines.length < MAX_CANDIDATES || !last) return lines;
        if (!admissibleMoves(lines, turnOf(node.fen), params.tolerance).includes(last)) {
            return lines;
        }
        const proposed = new Set(lines.map((line) => sanKey(line.sanMoves[0])));
        const left = explorer.moves
            .filter((move) => !proposed.has(sanKey(move.san)) && enough(move))
            .sort(
                (a, b) =>
                    totalGames(outcomeOf(b, params.color)) - totalGames(outcomeOf(a, params.color)),
            )
            .slice(0, MAX_EXTRA_CANDIDATES);
        if (left.length === 0) return lines;
        const more = await deps.analyze(node.fen, {
            purpose: "candidates",
            multipv: left.length,
            searchMoves: left.map((move) => uciOf(node.fen, move.san) ?? move.uci),
        });
        // An engine that ignored the restriction says nothing about those moves.
        const asked = new Set(left.map((move) => sanKey(move.san)));
        return [...lines, ...more.filter((line) => asked.has(sanKey(line.sanMoves[0])))];
    }

    /**
     * The move the search plays for the studied side, and the alternatives.
     * The engine proposes the candidates: its first lines at the precise depth,
     * those within its tolerance being kept, and the played moves it ranks lower
     * when it may have left some out (`withPlayedMoves`).
     * They are then ranked on the results of the games where they were played;
     * one with too few games is not, and when none can be, the engine's best
     * move is played.
     */
    async function expandStudied(node: SearchNode, explorer: ExplorerPosition) {
        const moveGames = (move: ExplorerMove) => totalGames(outcomeOf(move, params.color));
        const positionGames = totalGames(node.outcome);
        const enough = (move: ExplorerMove) =>
            moveGames(move) >= params.minGamesPerMove &&
            moveGames(move) >= params.minMoveShare * positionGames;
        const first = await deps.analyze(node.fen, {
            purpose: "candidates",
            multipv: MAX_CANDIDATES,
        });
        const lines = await withPlayedMoves(node, first, explorer, enough);
        const admissible = admissibleMoves(lines, turnOf(node.fen), params.tolerance);
        const byMove = new Map(explorer.moves.map((move) => [sanKey(move.san), move]));
        const edges: Edge[] = [];
        const proposed = new Set<string>();
        for (const line of lines) {
            const key = sanKey(line.sanMoves[0]);
            const move = byMove.get(key);
            proposed.add(key);
            const status: EdgeStatus = !admissible.includes(line)
                ? "outOfTolerance"
                : move && enough(move)
                  ? "contender"
                  : "fewGames";
            const edge = move ? explorerEdge(node, move, status) : engineEdge(node, line, status);
            edge.score = line.score;
            edge.depth = line.depth;
            edges.push(edge);
        }
        // An engine with no line proposes nothing: the most played moves stand in.
        const standIn = lines.length === 0;
        const rest = explorer.moves
            .filter((move) => !proposed.has(sanKey(move.san)))
            .sort((a, b) => moveGames(b) - moveGames(a));
        let standing = 0;
        let listed = 0;
        for (const move of rest) {
            if (standIn && enough(move) && standing < MAX_CANDIDATES) {
                edges.push(explorerEdge(node, move, "contender"));
                standing++;
            } else if (listed < LISTED_REPLIES) {
                edges.push(explorerEdge(node, move, enough(move) ? "other" : "fewGames"));
                listed++;
            }
        }
        node.edges = edges;
        const contenders = edges.filter((edge) => edge.status === "contender");
        if (contenders.length === 0) {
            engineDecides(node, lines);
            return;
        }
        for (const edge of contenders) attachChild(node, edge, node.reach);
        recordGain(node, contenders);
    }

    /**
     * What choosing the move added at the studied positions opened so far, on
     * average: the best candidate against the position's own result. Searching
     * below a position is hoped to add as much at each studied position left.
     */
    const gains = { total: 0, squares: 0, count: 0 };
    function recordGain(node: SearchNode, candidates: Edge[]) {
        const best = Math.max(...candidates.map((edge) => edge.value.mean));
        const gain = Math.max(0, best - node.value.mean);
        gains.total += gain;
        gains.squares += gain * gain;
        gains.count++;
    }
    /**
     * The hope is the average gain plus one standard deviation, not the
     * average alone: a branch whose gain is above average must not be closed
     * for having been judged on the typical one.
     */
    function lookahead(): Lookahead {
        let choiceGain = FIRST_CHOICE_GAIN;
        if (gains.count > 0) {
            const mean = gains.total / gains.count;
            const variance = Math.max(0, gains.squares / gains.count - mean * mean);
            choiceGain = mean + Math.sqrt(variance);
        }
        return { maxPlies: params.maxPlies, choiceGain };
    }

    /** No candidate can be ranked on its results: the engine's best move is played. */
    function engineDecides(node: SearchNode, lines: BestMoves[]) {
        const [best] = lines;
        if (!best) {
            node.stopped = "noMove";
            return;
        }
        const chosen = (node.edges ?? []).find(
            (edge) => sanKey(edge.san) === sanKey(best.sanMoves[0]),
        );
        if (!chosen) return;
        chosen.status = "chosen";
        chosen.value = engineValue(best.score, params.color, drawWeight, drawRateOf(node));
        chosen.decidedBy = "engineChoice";
        attachChild(node, chosen, node.reach);
    }

    /**
     * Whether a reply the search would leave closed is worth examining as a
     * trap: played often enough, in enough games, and the studied side scores
     * clearly better after it than in the position.
     */
    function isTrapCandidate(node: SearchNode, edge: Edge): boolean {
        if (params.trapMinShare === undefined || !node.rates) return false;
        const games = totalGames(edge.outcome);
        if (games < TRAP_MIN_GAMES || games < params.trapMinShare * totalGames(node.outcome)) {
            return false;
        }
        const rates = ratesOf(edge.outcome);
        if (!rates) return false;
        return (
            expectedScore(rates, drawWeight) - expectedScore(node.rates, drawWeight) >=
            TRAP_MIN_GAIN
        );
    }

    /**
     * Opens the candidates that really are mistakes: the engine judges the
     * position and the position after each reply, at the fast depth.
     */
    async function openTraps(node: SearchNode, pool: Edge[]): Promise<Edge[]> {
        if (pool.length === 0) return [];
        const [before] = await deps.analyze(node.fen, { purpose: "evaluation", multipv: 1 });
        if (!before) return [];
        node.evaluation = before.score;
        const opened: Edge[] = [];
        for (const edge of pool.slice(0, MAX_TRAPS)) {
            if (deps.isCancelled?.()) break;
            const next = playSan(node.fen, edge.san);
            if (!next) continue;
            const [after] = await deps.analyze(next.fen, { purpose: "evaluation", multipv: 1 });
            if (!after) continue;
            const annotation = mistakeAnnotation(before.score, after.score, turnOf(node.fen));
            if (annotation !== "?" && annotation !== "??") continue;
            edge.status = "reply";
            attachChild(node, edge, node.reach * edge.probability);
            if (edge.child) edge.child.evaluation = after.score;
            opened.push(edge);
        }
        return opened;
    }

    /** The replies the opponent plays often enough to be worth preparing. */
    async function expandOpponent(node: SearchNode, explorer: ExplorerPosition) {
        const games = totalGames(node.outcome);
        const outcomes = explorer.moves.map((move) => outcomeOf(move, params.color));
        const probabilities = moveProbabilities(
            outcomes.map(totalGames),
            games,
            legalMoveCount(node.fen),
            params.smoothing,
        );
        const order = explorer.moves
            .map((_, index) => index)
            .sort((a, b) => probabilities[b] - probabilities[a]);

        const edges: Edge[] = [];
        const traps: Edge[] = [];
        let listed = 0;
        for (const index of order) {
            const move = explorer.moves[index];
            const outcome = outcomes[index];
            const reach = node.reach * probabilities[index];
            const edge: Edge = {
                san: move.san,
                uci: move.uci,
                outcome,
                probability: probabilities[index],
                status: "reply",
                value: node.rates
                    ? statsValue(outcome, node.rates, params.shrinkage, drawWeight)
                    : node.value,
                expansions: 0,
            };
            // The most played reply is always followed: the line goes its whole length.
            if (reach >= params.minReach || index === order[0]) {
                edges.push(edge);
                attachChild(node, edge, reach);
            } else {
                stats.lowReach++;
                if (isTrapCandidate(node, edge)) traps.push(edge);
                if (listed < LISTED_REPLIES) {
                    edge.status = "other";
                    edges.push(edge);
                    listed++;
                }
            }
        }
        for (const edge of await openTraps(node, traps)) {
            stats.lowReach--;
            if (!edges.includes(edge)) edges.push(edge);
        }
        const covered = edges
            .filter((edge) => edge.status === "reply")
            .reduce((acc, edge) => acc + edge.probability, 0);
        node.edges = edges;
        node.weightSamples = games;
        const followed = edges
            .filter((edge) => edge.status === "reply")
            .reduce((acc, edge) => addOutcome(acc, edge.outcome), {
                wins: 0,
                draws: 0,
                losses: 0,
            });
        node.rest = {
            weight: Math.max(0, 1 - covered),
            value: node.rates
                ? statsValue(
                      subtractOutcome(node.outcome, followed),
                      node.rates,
                      params.shrinkage,
                      drawWeight,
                  )
                : node.value,
        };
    }

    /** Settles a position where the game is over, or that cannot be read. */
    function settleIfOver(node: SearchNode): boolean {
        const position = positionOf(node.fen);
        if (!position) {
            node.stopped = "noMove";
            return true;
        }
        if (!position.isEnd()) return false;
        const result = position.isCheckmate()
            ? position.turn === params.color
                ? "loss"
                : "win"
            : "draw";
        node.stopped = position.isCheckmate() ? "checkmate" : "draw";
        node.value = terminalValue(result, drawWeight);
        return true;
    }

    async function expand(node: SearchNode) {
        if (settleIfOver(node)) return;

        const explorer = await deps.explore(node.fen);
        stats.expanded++;
        node.outcome = outcomeOf(explorer, params.color);
        const parentRates = node.parent?.node.rates;
        node.rates = parentRates
            ? shrinkRates(node.outcome, parentRates, params.shrinkage)
            : (ratesOf(node.outcome) ?? EVEN);
        node.value = leafValue(node, []);

        if (node === root && params.forcedMove) {
            await forceMove(node, explorer, params.forcedMove);
            return;
        }
        if (totalGames(node.outcome) < params.minimumGames) {
            node.stopped = "outOfBook";
            stats.outOfBook++;
            if (totalGames(node.outcome) >= trustGames) {
                // The games say how the position goes; the engine only has to say how
                // the line goes on, which is settled for the lines kept (`playOutLines`).
                node.value = statsValue(node.outcome, node.rates, params.shrinkage, drawWeight);
                node.pinned = true;
                return;
            }
            await followEngine(node);
            return;
        }
        if (node.studied) await expandStudied(node, explorer);
        else await expandOpponent(node, explorer);
    }

    /** Plays a move the search did not choose, then searches on from there. */
    async function forceMove(node: SearchNode, explorer: ExplorerPosition, san: string) {
        const outcome = moveOutcome(explorer, san, params.color);
        const lines = node.studied ? await deps.analyze(node.fen, { purpose: "candidates" }) : [];
        const line = lines.find((l) => sanKey(l.sanMoves[0]) === sanKey(san));
        const edge: Edge = {
            san,
            uci: line?.uciMoves[0] ?? san,
            outcome,
            probability: node.studied ? 0 : 1,
            score: line?.score,
            status: "chosen",
            forced: true,
            value:
                totalGames(outcome) >= params.minGamesPerMove && node.rates
                    ? statsValue(outcome, node.rates, params.shrinkage, drawWeight)
                    : line
                      ? engineValue(line.score, params.color, drawWeight, drawRateOf(node))
                      : node.value,
            expansions: 0,
        };
        node.edges = [edge];
        attachChild(node, edge, node.reach);
    }

    /** Marks the branch that led to a node as searched, for the pruning rule. */
    function countExpansion(node: SearchNode) {
        for (let current = node; current.parent; current = current.parent.node) {
            current.parent.edge.expansions++;
        }
    }

    /**
     * Fetches ahead the positions next in line, so that their explorer requests
     * run while the search waits on the engine or on another request. The order
     * in which positions are opened is unchanged, and so is the result.
     */
    const prefetched = new WeakSet<SearchNode>();
    function prefetchAhead(frontier: Frontier<SearchNode>) {
        const prefetch = deps.prefetch;
        if (!prefetch) return;
        const next = frontier.peek(LOOKAHEAD, (node) => !prefetched.has(node));
        for (const node of next) {
            if (positionOf(node.fen)?.isEnd() !== false || prefetch(node.fen)) {
                prefetched.add(node);
            }
        }
    }

    async function visit(node: SearchNode) {
        await expand(node);
        countExpansion(node);
        stats.pruned += backup(node, options).pruned;
        deps.onProgress?.({ ...stats }, root);
    }

    /**
     * Plays the engine on from the positions valued on their games alone, in
     * the lines that are kept: nothing the engine plays there can change a
     * decision, so none of it was looked at while searching, and no explorer
     * request is needed (a position has fewer games than the one before it).
     */
    async function playOutLines() {
        const walk = async (node: SearchNode): Promise<void> => {
            if (deps.isCancelled?.() || node.ply >= keepPlies) return;
            if (node.pinned && !node.edges) {
                for (let current: SearchNode | undefined = node; current; ) {
                    if (deps.isCancelled?.() || current.stopped === "maxPly") return;
                    if (current.ply >= keepPlies) return;
                    if (current !== node) current.stopped ??= "outOfBook";
                    if (settleIfOver(current)) return;
                    await followEngine(current);
                    current = current.edges?.[0]?.child;
                }
                return;
            }
            for (const edge of keptEdges(node, params.mode ?? "tree")) {
                if (edge.child) await walk(edge.child);
            }
        };
        await walk(root);
    }

    /**
     * Runs a step of the search. One that fails because the search was stopped
     * (an analysis the engine gave up, a request waiting out a rate limit) is a
     * stop, not a failure: the tree found so far is returned.
     */
    async function stoppable(step: () => Promise<void>): Promise<boolean> {
        try {
            await step();
            return true;
        } catch (e) {
            if (!deps.isCancelled?.()) throw e;
            stats.cancelled = true;
            return false;
        }
    }

    if (!(await stoppable(() => visit(root)))) return { root, stats };
    for (;;) {
        if (deps.isCancelled?.()) {
            stats.cancelled = true;
            break;
        }
        if (stats.expanded >= MAX_EXPANDED) {
            stats.exhausted = true;
            break;
        }
        const frontier = nextPositions(root, options, lookahead());
        const node = frontier.pop();
        if (!node) break;
        prefetchAhead(frontier);
        if (!isLive(node)) continue;
        if (!(await stoppable(() => visit(node)))) break;
    }
    if (!stats.cancelled) await stoppable(playOutLines);
    if (deps.isCancelled?.()) stats.cancelled = true;
    return { root, stats };
}

/**
 * Share of the games the tree accounts for: it follows the move it plays at the
 * studied side's positions and every reply it searched at the opponent's, the
 * replies it left out being what is missing.
 */
export function coverageOf(root: SearchNode): number {
    let covered = 0;
    const walk = (node: SearchNode) => {
        const children = (node.edges ?? []).filter((edge) => edge.child);
        if (children.length === 0) {
            covered += node.reach;
            return;
        }
        if (node.studied) {
            const chosen = children.find((edge) => edge.status === "chosen") ?? children[0];
            if (chosen.child) walk(chosen.child);
            return;
        }
        for (const edge of children) if (edge.child) walk(edge.child);
    };
    walk(root);
    return Math.min(1, covered);
}
