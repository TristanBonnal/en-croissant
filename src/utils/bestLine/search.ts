import type { Color } from "chessops";
import type { Chess } from "chessops/chess";
import type { BestMoves } from "@/bindings";
import {
    admissibleMoves,
    type AnalysisRequest,
    type ExplorerPosition,
    type Tolerance,
} from "@/utils/bestLine";
import { Frontier } from "./frontier";
import {
    backup,
    backupOptionsOf,
    type Edge,
    type EdgeStatus,
    isLive,
    type SearchNode,
} from "./node";
import { legalMoveCount, playSan, positionOf, sanKey } from "./position";
import { moveProbabilities } from "./probability";
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
 * the average result of everyone who reached it. Positions are opened most
 * likely first, so the tree is usable at any moment, and a branch is never
 * opened when a game reaches it less often than `minReach`.
 */

/** Keeps the order of the frontier readable when every value is certain. */
const SIGMA_FLOOR = 0.01;
/** Last-resort stop, for a search that would otherwise run for hours. */
const MAX_EXPANDED = 3000;
/** Opponent replies listed but not searched, for the result table. */
const LISTED_REPLIES = 5;

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
    };
    const frontier = new Frontier<SearchNode>();

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
        if (child.ply >= params.maxPlies) {
            child.stopped = "maxPly";
            return;
        }
        frontier.push(child, reach * (edge.value.sigma + SIGMA_FLOOR));
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
        node.value = edge.value;
        attachChild(node, edge, node.reach);
    }

    /** The move the search plays for the studied side, and the alternatives. */
    async function expandStudied(node: SearchNode, position: Chess, explorer: ExplorerPosition) {
        const lines = await deps.analyze(node.fen, { purpose: "candidates" });
        if (lines.length === 0) {
            node.stopped = "noMove";
            return;
        }
        const admissible = admissibleMoves(lines, position.turn, params.tolerance);
        const edges = lines.map((line): Edge => {
            const san = line.sanMoves[0];
            const outcome = moveOutcome(explorer, san, params.color);
            const enough = totalGames(outcome) >= params.minGamesPerMove;
            const status: EdgeStatus = !admissible.includes(line)
                ? "outOfTolerance"
                : enough
                  ? "contender"
                  : "fewGames";
            return {
                san,
                uci: line.uciMoves[0],
                outcome,
                probability: 0,
                score: line.score,
                status,
                depth: line.depth,
                value:
                    enough && node.rates
                        ? statsValue(outcome, node.rates, params.shrinkage, drawWeight)
                        : engineValue(line.score, params.color, drawWeight, drawRateOf(node)),
                expansions: 0,
            };
        });
        node.edges = edges;

        const contenders = edges.filter((edge) => edge.status === "contender");
        if (contenders.length === 0) {
            // No move has enough games: the engine decides, at the precise depth.
            const deepEnough =
                params.preciseDepth !== undefined &&
                lines.every((line) => line.depth >= params.preciseDepth!);
            const [precise] = deepEnough
                ? lines
                : await deps.analyze(node.fen, { purpose: "decision", multipv: 1 });
            const best = precise ?? lines[0];
            const chosen =
                edges.find((edge) => sanKey(edge.san) === sanKey(best.sanMoves[0])) ??
                edges[edges.length - 1];
            chosen.score = best.score;
            chosen.value = engineValue(best.score, params.color, drawWeight, drawRateOf(node));
            chosen.status = "chosen";
            chosen.decidedBy = "engineChoice";
            attachChild(node, chosen, node.reach);
            return;
        }
        for (const edge of contenders) attachChild(node, edge, node.reach);
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
        if (node.studied) await expandStudied(node, position, explorer);
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

    async function visit(node: SearchNode) {
        await expand(node);
        countExpansion(node);
        stats.pruned += backup(node, options).pruned;
        deps.onProgress?.({ ...stats }, root);
    }

    await visit(root);
    while (frontier.size > 0) {
        if (deps.isCancelled?.()) {
            stats.cancelled = true;
            break;
        }
        if (stats.expanded >= MAX_EXPANDED) {
            stats.exhausted = true;
            break;
        }
        const node = frontier.pop();
        if (!node || !isLive(node)) continue;
        await visit(node);
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
