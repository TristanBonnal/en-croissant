import type { Color } from "chessops";
import type { Score } from "@/bindings";
import type { Annotation } from "@/utils/annotation";
import { normalizeScore } from "@/utils/score";
import {
    type BestLineNode,
    type Candidate,
    type CandidateStatus,
    isTrapMistake,
    mistakeAnnotation,
    type MoveReason,
    type MoveStats,
} from "@/utils/bestLine";
import type { Edge, EdgeStatus, SearchNode } from "./node";
import { drawWeightOf, expectedScore, type Metric, ratesOf, totalGames } from "./stats";

/**
 * Turns the search tree into the result the rest of the app already knows: a
 * move, the alternatives considered at that point, and the moves that follow.
 * The search always explores a tree; `mode` only decides how much of it is
 * kept — a single line, or every reply worth preparing.
 */

export type OutputOptions = {
    mode: "line" | "tree";
    metric?: Metric;
    /** When set, an opponent mistake played at least this often is a trap. */
    trapMinShare?: number;
};

/**
 * Whether an opponent mistake is worth preparing: played often enough, and the
 * studied side really does score better after it than in the position.
 */
export function trapFlag(
    annotation: Annotation | undefined,
    stats: MoveStats | undefined,
    positionScore: number | undefined,
    minShare: number | undefined,
): boolean {
    if (minShare === undefined || stats === undefined) return false;
    if (stats.share < minShare) return false;
    return isTrapMistake(annotation, stats, positionScore);
}

/** Engine evaluation of a position, from the candidates analysed there. */
function evaluationOf(node: SearchNode | undefined): Score | undefined {
    if (!node) return undefined;
    const mover = turnOf(node.fen);
    const scores = (node.edges ?? []).flatMap((edge) => (edge.score ? [edge.score] : []));
    if (scores.length === 0) return node.parent?.edge.score;
    return scores.reduce((best, score) =>
        normalizeScore(score.value, mover) > normalizeScore(best.value, mover) ? score : best,
    );
}

/** How a candidate of the search appears in the result table. */
function candidateStatus(status: EdgeStatus): CandidateStatus {
    switch (status) {
        case "chosen":
        case "reply":
            return "chosen";
        case "outOfTolerance":
            return "outOfTolerance";
        case "fewGames":
            return "fewGames";
        case "contender":
        case "pruned":
            return "lowerScore";
        default:
            return "other";
    }
}

/** Results of a move for the side that played it, and for the other one. */
function statsOf(edge: Edge, node: SearchNode, mover: Color, studied: Color, metric: Metric) {
    const games = totalGames(edge.outcome);
    if (games === 0) return undefined;
    const drawWeight = drawWeightOf(metric);
    const rates = ratesOf(edge.outcome)!;
    const mirrored = { win: rates.loss, draw: rates.draw, loss: rates.win };
    const forStudied = expectedScore(rates, drawWeight);
    const forOther = expectedScore(mirrored, drawWeight);
    const positionGames = totalGames(node.outcome);
    return {
        score: mover === studied ? forStudied : forOther,
        opponentScore: mover === studied ? forOther : forStudied,
        games,
        share: positionGames === 0 ? 0 : games / positionGames,
    } satisfies MoveStats;
}

function reasonOf(edge: Edge, node: SearchNode): MoveReason {
    if (edge.forced) return "manual";
    if (!node.studied) return node.stopped === "outOfBook" ? "engine" : "popular";
    return edge.value.source === "stats" ? "stats" : "engine";
}

/** Moves of a node kept in the result, the one it plays first. */
export function keptEdges(node: SearchNode, mode: "line" | "tree"): Edge[] {
    const edges = node.edges ?? [];
    if (node.studied) {
        const chosen = edges.find((edge) => edge.status === "chosen");
        return chosen ? [chosen] : [];
    }
    const replies = edges
        .filter((edge) => edge.status === "reply")
        .sort((a, b) => b.probability - a.probability);
    return mode === "line" ? replies.slice(0, 1) : replies;
}

export function toBestLineNodes(root: SearchNode, options: OutputOptions): BestLineNode[] {
    const metric = options.metric ?? "score";
    const studied: Color = root.studied ? turnOf(root.fen) : other(turnOf(root.fen));

    const convert = (node: SearchNode): BestLineNode[] => {
        const mover = turnOf(node.fen);
        const candidates: Candidate[] = (node.edges ?? []).map((edge) => ({
            san: edge.san,
            score: edge.score,
            stats: statsOf(edge, node, mover, studied, metric),
            value: edge.value.mean,
            status: candidateStatus(edge.status),
        }));
        const before = node.studied ? undefined : evaluationOf(node);
        const positionScore =
            node.rates && !node.studied
                ? expectedScore(node.rates, drawWeightOf(metric))
                : undefined;
        return keptEdges(node, options.mode).map((edge) => {
            const stats = statsOf(edge, node, mover, studied, metric);
            const annotation: Annotation | undefined =
                node.studied || !before
                    ? undefined
                    : mistakeAnnotationOf(before, evaluationOf(edge.child), mover);
            const trap = trapFlag(annotation, stats, positionScore, options.trapMinShare);
            return {
                san: edge.san,
                uci: edge.uci,
                color: mover,
                fen: node.fen,
                reason: trap ? ("trap" as MoveReason) : reasonOf(edge, node),
                score: edge.score,
                stats,
                annotation,
                trap: trap || undefined,
                candidates,
                children: edge.child ? convert(edge.child) : [],
            };
        });
    };
    return convert(root);
}

/** Win chances an opponent move gave away, when both evaluations are known. */
function mistakeAnnotationOf(
    before: Score,
    after: Score | undefined,
    mover: Color,
): Annotation | undefined {
    return after ? mistakeAnnotation(before, after, mover) : undefined;
}

function turnOf(fen: string): Color {
    return fen.split(" ")[1] === "b" ? "black" : "white";
}

function other(color: Color): Color {
    return color === "white" ? "black" : "white";
}

/** Number of moves a result holds. */
export function countNodes(nodes: BestLineNode[]): number {
    return nodes.reduce((acc, node) => acc + 1 + countNodes(node.children), 0);
}
