import type { Color } from "chessops";
import type { BestMoves } from "@/bindings";
import {
    admissibleMoves,
    type AnalysisRequest,
    type ExplorerMove,
    type ExplorerPosition,
    type Tolerance,
} from "@/utils/bestLine";
import {
    backup,
    backupOptionsOf,
    type Edge,
    type EdgeStatus,
    isLive,
    liveEdges,
    type SearchNode,
} from "./node";
import { legalMoveCount, playSan, positionOf, sanKey, uciOf } from "./position";
import type { Frontier } from "./frontier";
import { type Lookahead, nextPositions } from "./optimism";
import { moveProbabilities } from "./probability";
import { verifyChoices } from "./verify";
import {
    addOutcome,
    drawWeightOf,
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
/** Most played moves of the studied side searched as candidates. */
const MAX_CANDIDATES = 4;
/** Opponent replies listed but not searched, for the result table. */
const LISTED_REPLIES = 5;
/** What choosing a move is hoped to add before any studied position was opened. */
const FIRST_CHOICE_GAIN = 0.05;
/** Positions next in line whose explorer data is fetched ahead of their turn. */
const LOOKAHEAD = 4;

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
    /** Share of the games a position must be reached in to be opened. */
    minReach: number;
    /** Games the rates of a position are worth when shrinking its moves. */
    shrinkage: number;
    /** Standard errors taken off a value before comparing it. */
    risk: number;
    /** Smoothing of the opponent's shares. */
    smoothing: number;
    /** Lines at least this deep need no precise analysis. */
    preciseDepth?: number;
    /** Move played first instead of the one the search would choose. */
    forcedMove?: string;
    /**
     * Checks at the precise depth the moves the result plays (as shown in this
     * mode), searching on below the moves that replace rejected ones.
     */
    verify?: "line" | "tree";
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
    /** Positions analysed again at the precise depth, and those whose move changed. */
    checked: number;
    changed: number;
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
    const stats: SearchStats = {
        expanded: 0,
        pruned: 0,
        lowReach: 0,
        outOfBook: 0,
        cancelled: false,
        exhausted: false,
        checked: 0,
        changed: 0,
    };

    const root: SearchNode = {
        fen: params.fen,
        studied: turnOf(params.fen) === params.color,
        ply: 0,
        reach: 1,
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
            value: engineValue(best.score, params.color, drawWeight, drawRateOf(node)),
            expansions: 0,
        };
        node.edges = [edge];
        node.value = edge.value;
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

    /**
     * The move the search plays for the studied side, and the alternatives.
     * Candidates are the moves played often enough to be ranked on their
     * results, wherever the engine ranks them: a strong practical move is not
     * left out for being the engine's sixth choice. Whether they are within
     * the engine's tolerance is only checked once the search goes on below
     * them (`checkCandidates`), so that positions it never gets to cost no
     * analysis at all.
     */
    async function expandStudied(node: SearchNode, explorer: ExplorerPosition) {
        const moveGames = (move: ExplorerMove) => totalGames(outcomeOf(move, params.color));
        const enough = (move: ExplorerMove) => moveGames(move) >= params.minGamesPerMove;
        const contenders = explorer.moves
            .filter(enough)
            .sort((a, b) => moveGames(b) - moveGames(a))
            .slice(0, MAX_CANDIDATES)
            .map((move) => explorerEdge(node, move, "contender"));
        const listed = explorer.moves
            .filter((move) => !enough(move))
            .slice(0, LISTED_REPLIES)
            .map((move) => explorerEdge(node, move, "fewGames"));
        node.edges = [...contenders, ...listed];
        if (contenders.length === 0) {
            await engineDecides(node);
            return;
        }
        for (const edge of contenders) attachChild(node, edge, node.reach);
        recordGain(node, contenders);
        // Nothing will be searched below these moves, which would have checked them.
        if (node.ply + 1 >= params.maxPlies) await checkCandidates(node);
    }

    /**
     * What choosing the move added at the studied positions opened so far, on
     * average: the best candidate against the position's own result. Searching
     * below a position is hoped to add as much at each studied position left.
     */
    const gains = { total: 0, count: 0 };
    function recordGain(node: SearchNode, candidates: Edge[]) {
        const best = Math.max(...candidates.map((edge) => edge.value.mean));
        gains.total += Math.max(0, best - node.value.mean);
        gains.count++;
    }
    function lookahead(): Lookahead {
        const choiceGain = gains.count > 0 ? gains.total / gains.count : FIRST_CHOICE_GAIN;
        return { maxPlies: params.maxPlies, choiceGain };
    }

    /** No candidate can be ranked on its results: the engine decides, at the precise depth. */
    async function engineDecides(node: SearchNode) {
        const [best] = await deps.analyze(node.fen, { purpose: "decision", multipv: 1 });
        if (!best) {
            node.stopped = "noMove";
            return;
        }
        const san = best.sanMoves[0];
        const edges = node.edges ?? [];
        const known = edges.find((edge) => sanKey(edge.san) === sanKey(san));
        const chosen: Edge = known ?? {
            san,
            uci: best.uciMoves[0],
            outcome: { wins: 0, draws: 0, losses: 0 },
            probability: 0,
            status: "chosen",
            value: node.value,
            expansions: 0,
        };
        chosen.score = best.score;
        chosen.depth = best.depth;
        chosen.checked = true;
        chosen.status = "chosen";
        chosen.value = engineValue(best.score, params.color, drawWeight, drawRateOf(node));
        if (!known) node.edges = [chosen, ...edges];
        attachChild(node, chosen, node.reach);
    }

    /**
     * Compares with the engine's best move the candidates still competing at a
     * studied node: one analysis of the position with as many lines as there
     * are candidates, which usually covers them all since popular moves tend to
     * be the engine's too, then one restricted to those it left out. A
     * candidate out of tolerance is dropped; when it was the chosen move, the
     * ones dropped only for being worse than it compete again.
     */
    async function checkCandidates(node: SearchNode) {
        const unchecked = liveEdges(node).filter((edge) => !edge.checked);
        if (unchecked.length === 0) return;
        node.engineLines ??= await deps.analyze(node.fen, {
            purpose: "candidates",
            multipv: unchecked.length,
        });
        const [best] = node.engineLines;
        if (!best) {
            for (const edge of unchecked) edge.checked = true;
            return;
        }
        const lineOf = (edge: Edge, lines: BestMoves[]) =>
            lines.find((line) => sanKey(line.sanMoves[0]) === sanKey(edge.san));
        const missing = unchecked.filter((edge) => !lineOf(edge, node.engineLines!));
        const restricted =
            missing.length > 0
                ? await deps.analyze(node.fen, {
                      purpose: "candidates",
                      multipv: missing.length,
                      searchMoves: missing.map((edge) => edge.uci),
                  })
                : [];
        const lines = [...node.engineLines, ...restricted];
        const admissible = admissibleMoves(lines, turnOf(node.fen), params.tolerance);

        let choiceDropped = false;
        for (const edge of unchecked) {
            edge.checked = true;
            const line = lineOf(edge, lines);
            // An engine that ignored the restriction tells us nothing about it.
            if (!line) continue;
            edge.score = line.score;
            edge.depth = line.depth;
            if (admissible.includes(line)) continue;
            if (edge.status === "chosen") choiceDropped = true;
            edge.status = "outOfTolerance";
        }
        if (choiceDropped) {
            for (const edge of node.edges ?? []) if (edge.status === "pruned") revive(edge);
        }
        if (liveEdges(node).length === 0) await engineDecides(node);
        stats.pruned += backup(node, options).pruned;
    }

    /** Puts back in competition a candidate dropped against a move that is now gone. */
    function revive(edge: Edge) {
        edge.status = "contender";
    }

    /**
     * Checks the candidates of the studied positions above a node about to be
     * opened, from the root down, so that no position is searched below a
     * move the engine rejects.
     */
    async function checkPath(node: SearchNode) {
        const path: SearchNode[] = [];
        for (let current = node; current.parent; current = current.parent.node) {
            const parent = current.parent.node;
            if (parent.studied && !current.parent.edge.checked) path.unshift(parent);
        }
        for (const studied of path) {
            if (!isLive(node)) return;
            await checkCandidates(studied);
        }
    }

    /** The precise check of the moves played, after which the search goes on below their replacements. */
    async function verifyPlayed() {
        if (!params.verify || deps.isCancelled?.()) return;
        const checks = await verifyChoices(root, { ...params, mode: params.verify }, deps);
        stats.checked += checks.checked;
        stats.changed += checks.changed;
    }

    /** Checks the moves the tree ends up playing that the search never had to. */
    async function checkPlayed(node: SearchNode) {
        if (deps.isCancelled?.()) return;
        if (node.studied && node.edges) {
            // Every candidate was rejected (at the precise depth): the engine decides.
            if (liveEdges(node).length === 0 && !node.stopped) await engineDecides(node);
            let chosen = node.edges.find((edge) => edge.status === "chosen");
            while (chosen && !chosen.checked) {
                await checkCandidates(node);
                chosen = node.edges.find((edge) => edge.status === "chosen");
            }
            if (chosen?.child) await checkPlayed(chosen.child);
            return;
        }
        for (const edge of node.edges ?? []) {
            if (edge.status === "reply" && edge.child) await checkPlayed(edge.child);
        }
    }

    /** The replies the opponent plays often enough to be worth preparing. */
    function expandOpponent(node: SearchNode, explorer: ExplorerPosition) {
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
        let covered = 0;
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
            if (reach >= params.minReach) {
                edges.push(edge);
                covered += probabilities[index];
                attachChild(node, edge, reach);
            } else {
                stats.lowReach++;
                if (listed < LISTED_REPLIES) {
                    edge.status = "other";
                    edges.push(edge);
                    listed++;
                }
            }
        }
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

    async function expand(node: SearchNode) {
        const position = positionOf(node.fen);
        if (!position) {
            node.stopped = "noMove";
            return;
        }
        if (position.isEnd()) {
            const result = position.isCheckmate()
                ? position.turn === params.color
                    ? "loss"
                    : "win"
                : "draw";
            node.stopped = position.isCheckmate() ? "checkmate" : "draw";
            node.value = terminalValue(result, drawWeight);
            return;
        }

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
            await followEngine(node);
            return;
        }
        if (node.studied) await expandStudied(node, explorer);
        else expandOpponent(node, explorer);
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
            checked: true,
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

    await visit(root);
    for (;;) {
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
            await checkPath(node);
            if (!isLive(node)) continue;
            await visit(node);
        }
        if (stats.cancelled) break;
        // A move rejected now brings back positions to search, budget allowing.
        await checkPlayed(root);
        await verifyPlayed();
        if (stats.exhausted || nextPositions(root, options, lookahead()).size === 0) break;
    }
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
