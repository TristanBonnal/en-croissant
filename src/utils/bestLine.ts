import type { Color } from "chessops";
import { Chess } from "chessops/chess";
import { makeFen, parseFen } from "chessops/fen";
import { parseSan } from "chessops/san";
import { z } from "zod";
import type { BestMoves, Score } from "@/bindings";
import type { Annotation } from "./annotation";
import { formatScore, getWinChance, normalizeScore } from "./score";
import { sanKey } from "./bestLine/position";
import { getNodeAtPath, type TreeNode } from "./treeReducer";

/** Number of engine lines analysed for each position. */
export const BEST_LINE_MULTIPV = 5;

/** A trap must be punished in practice: games after it, and score gained by the studied side. */
export const TRAP_MIN_GAMES = 30;
export const TRAP_MIN_GAIN = 0.03;

export const bestLineSettingsSchema = z.object({
    color: z.enum(["white", "black"]).default("white"),
    engine: z.string().default(""),
    depth: z.number().int().min(1).default(18),
    fastDepth: z.number().int().min(1).default(14),
    verifyFastChoice: z.boolean().default(true),
    fullMoves: z.number().int().min(1).default(6),
    mode: z.enum(["line", "tree"]).default("line"),
    /** Share of the games a line must be reached in to be searched. */
    reachThreshold: z.number().min(0.001).max(0.5).default(0.02),
    trapBranching: z.boolean().default(false),
    trapMinShare: z.number().min(0).max(1).default(0.05),
    toleranceMode: z.enum(["pawns", "winChance"]).default("pawns"),
    engineTolerance: z.number().min(0).default(0.3),
    winChanceTolerance: z.number().min(0).default(3),
    metric: z.enum(["wins", "score"]).default("wins"),
    useCloudEval: z.boolean().default(true),
    minimumGames: z.number().int().min(0).default(5000),
    minGamesPerMove: z.number().int().min(0).default(100),
});

export type BestLineSettings = z.infer<typeof bestLineSettingsSchema>;

export type ExplorerMove = {
    san: string;
    uci: string;
    white: number;
    draws: number;
    black: number;
};

export type ExplorerPosition = {
    white: number;
    draws: number;
    black: number;
    moves: ExplorerMove[];
};

/** Maximum evaluation loss accepted vs the best move, in pawns or in win chance points (%). */
export type Tolerance = { mode: "pawns" | "winChance"; value: number };

/**
 * How a move's results are measured: "wins" counts the games won by the side
 * playing it (draws count as nothing), "score" counts draws as half a point.
 */
export type Metric = "wins" | "score";

/** Which criterion played in choosing a move. */
export type MoveReason =
    /** Best expected result among the candidates. */
    | "score"
    /** Candidates too close to tell apart: the most played one won. */
    | "mostPlayed"
    /** The only candidate with enough games. */
    | "onlyMove"
    /** No candidate had enough games, so the engine chose. */
    | "engineChoice"
    /** The explorer knows too little about the position: the engine plays on. */
    | "outOfBook"
    /** The opponent's most played reply. */
    | "popular"
    /** A mistake the opponent plays often and loses after. */
    | "trap"
    /** Played instead of the search's own choice. */
    | "manual"
    /** Results stored by an older version. */
    | "stats"
    | "engine";

/** Win chance points (%) lost by a dubious move, a mistake and a blunder (as in game reports). */
const MISTAKE_THRESHOLDS: [number, Annotation][] = [
    [20, "??"],
    [10, "?"],
    [5, "?!"],
];

export type MoveStats = {
    /** Result of the move for the side playing it, measured with the search's metric. */
    score: number;
    /** Same measure for the other side. */
    opponentScore: number;
    games: number;
    /** Share of the position's games where this move was played. */
    share: number;
};

export type MoveChoice = {
    san: string;
    reason: MoveReason;
    score?: Score;
    /** Whether `score` comes from the precise depth. */
    precise?: boolean;
    stats?: MoveStats;
    /** Expected result of the move once its continuations are taken into account. */
    value?: number;
    /** `value` minus the risk penalty: the number the choice was made on. */
    bound?: number;
};

export type CandidateStatus = "chosen" | "outOfTolerance" | "fewGames" | "lowerScore" | "other";

/** A move considered in a position, and why it was (not) played. */
export type Candidate = {
    san: string;
    score?: Score;
    /** Whether `score` comes from the precise depth. */
    precise?: boolean;
    stats?: MoveStats;
    /** Expected result of the move once its continuations are taken into account. */
    value?: number;
    /** `value` minus the risk penalty: the number the choice was made on. */
    bound?: number;
    status: CandidateStatus;
};

export type BestLineNode = MoveChoice & {
    uci: string;
    color: Color;
    /** "?!", "?" or "??" for an opponent move losing win chances. */
    annotation?: Annotation;
    /** An opponent mistake that is frequent enough and punished in practice. */
    trap?: boolean;
    /** Position before the move. */
    fen: string;
    candidates: Candidate[];
    children: BestLineNode[];
};

/** What the search needs an engine analysis for, which sets the depth it runs at. */
export type AnalysisPurpose =
    /** Lists the moves the stats can choose from, at the fast depth. */
    | "candidates"
    /** Evaluates a position whose move was played without the engine, at the fast depth. */
    | "evaluation"
    /** Chooses the move when the stats can't, at the precise depth. */
    | "decision"
    /** Checks at the precise depth a move chosen on the stats. */
    | "verification";

/** Whether an analysis for `purpose` runs at the precise depth. */
export function isPreciseAnalysis(purpose: AnalysisPurpose) {
    return purpose === "decision" || purpose === "verification";
}

/**
 * Engine analysis asked by the search. `multipv` defaults to the search's
 * number of lines; `searchMoves` restricts the analysis to some moves (UCI).
 */
export type AnalysisRequest = {
    purpose: AnalysisPurpose;
    multipv?: number;
    searchMoves?: string[];
};

/** Annotation of a move that turns the evaluation `before` into `after` for `color`. */
export function mistakeAnnotation(
    before: Score,
    after: Score,
    color: Color,
): Annotation | undefined {
    const lost =
        getWinChance(normalizeScore(before.value, color)) -
        getWinChance(normalizeScore(after.value, color));
    return MISTAKE_THRESHOLDS.find(([threshold]) => lost > threshold)?.[1];
}

function isMistake(annotation: Annotation | undefined) {
    return annotation === "?" || annotation === "??";
}

/**
 * Whether an opponent mistake is a trap worth preparing: played often enough,
 * and the studied side actually scores better after it than in the position.
 * `stats` are the opponent's stats of the move.
 */
export function isTrapMistake(
    annotation: Annotation | undefined,
    stats: MoveStats | undefined,
    positionScore: number | undefined,
): boolean {
    if (!isMistake(annotation) || !stats || positionScore === undefined) return false;
    return stats.games >= TRAP_MIN_GAMES && stats.opponentScore - positionScore >= TRAP_MIN_GAIN;
}

export function isTrap(node: Pick<BestLineNode, "trap">): boolean {
    return node.trap === true;
}

/** Whether cloud lines can replace a local analysis. */
export function cloudLinesUsable(lines: BestMoves[], minDepth: number, expectedLines: number) {
    return (
        lines.length > 0 && lines.length >= expectedLines && lines.every((l) => l.depth >= minDepth)
    );
}

export function formatPercent(value: number) {
    return `${(value * 100).toFixed(1)}%`;
}

export function admissibleMoves(
    lines: BestMoves[],
    color: Color,
    tolerance: Tolerance,
): BestMoves[] {
    const evals = lines.map((l) => normalizeScore(l.score.value, color));
    const best = Math.max(...evals);
    if (tolerance.mode === "winChance") {
        const bestChance = getWinChance(best);
        return lines.filter((_, i) => getWinChance(evals[i]) >= bestChance - tolerance.value);
    }
    return lines.filter((_, i) => evals[i] >= best - tolerance.value * 100);
}

/** The line followed by the first move of each position. */
export function mainLine(nodes: BestLineNode[]): BestLineNode[] {
    const line: BestLineNode[] = [];
    let current = nodes[0];
    while (current) {
        line.push(current);
        current = current.children[0];
    }
    return line;
}

export function nodeAt(nodes: BestLineNode[], path: number[]): BestLineNode | undefined {
    let current: BestLineNode | undefined;
    let level = nodes;
    for (const index of path) {
        current = level[index];
        if (!current) return undefined;
        level = current.children;
    }
    return current;
}

/** Copy of `nodes` where the node at `path` is replaced by `node`. */
export function replaceNodeAt(
    nodes: BestLineNode[],
    path: number[],
    node: BestLineNode,
): BestLineNode[] {
    const [index, ...rest] = path;
    return nodes.map((n, i) => {
        if (i !== index) return n;
        return rest.length === 0 ? node : { ...n, children: replaceNodeAt(n.children, rest, node) };
    });
}

/** Number of plies of the deepest branch starting with `node`. */
export function subtreeHeight(node: BestLineNode): number {
    return 1 + Math.max(0, ...node.children.map(subtreeHeight));
}

/** Moves from the first position to the node at `path`. */
export function sansAlong(nodes: BestLineNode[], path: number[]): string[] {
    return path.flatMap((_, i) => nodeAt(nodes, path.slice(0, i + 1))?.san ?? []);
}

/** Moves from the first position to the node at `path`, then down its main line. */
export function sansTo(nodes: BestLineNode[], path: number[]): string[] {
    const node = nodeAt(nodes, path);
    return [...sansAlong(nodes, path), ...mainLine(node?.children ?? []).map((n) => n.san)];
}

/** Number of opponent moves on the way to the node at `path` (the node itself if `inclusive`). */
export function opponentMovesTo(
    nodes: BestLineNode[],
    path: number[],
    studiedColor: Color,
    inclusive = false,
): number {
    const end = inclusive ? path.length : path.length - 1;
    let count = 0;
    for (let i = 1; i <= end; i++) {
        if (nodeAt(nodes, path.slice(0, i))?.color !== studiedColor) count++;
    }
    return count;
}

/** Numbered moves (SAN) from the root to `path`, keeping only the last `maxPlies`. */
export function movesTo(root: TreeNode, path: number[], maxPlies = 10): string {
    const nodes = path.map((_, i) => ({
        before: getNodeAtPath(root, path.slice(0, i)),
        node: getNodeAtPath(root, path.slice(0, i + 1)),
    }));
    const shown = nodes.slice(-maxPlies);
    const parts = shown.map(({ before, node }, i) => {
        const [, turn, , , , fullMove] = before.fen.split(" ");
        if (turn === "w") return `${fullMove}. ${node.san}`;
        return i === 0 ? `${fullMove}... ${node.san}` : (node.san ?? "");
    });
    return `${shown.length < nodes.length ? "… " : ""}${parts.join(" ")}`;
}

/** Moves (SAN) from the node at `from` to its descendant at `to`, or null if it isn't one. */
export function sansBetween(root: TreeNode, from: number[], to: number[]): string[] | null {
    if (to.length < from.length || from.some((index, i) => to[i] !== index)) return null;
    return to
        .slice(from.length)
        .map((_, i) => getNodeAtPath(root, to.slice(0, from.length + i + 1)).san ?? "");
}

/** Path in the result of the moves `sans` played from its first position, or null. */
export function resultPathOf(nodes: BestLineNode[], sans: string[]): number[] | null {
    if (sans.length === 0) return null;
    const path: number[] = [];
    let level = nodes;
    for (const san of sans) {
        const index = level.findIndex((n) => sanKey(n.san) === sanKey(san));
        if (index === -1) return null;
        path.push(index);
        level = level[index].children;
    }
    return path;
}

/** Position after the node's move. */
export function fenAfter(node: BestLineNode): string {
    const pos = Chess.fromSetup(parseFen(node.fen).unwrap()).unwrap();
    pos.play(parseSan(pos, node.san)!);
    return makeFen(pos.toSetup());
}

export type LineCommentLabels = {
    winrate: (score: string) => string;
    played: (share: string, games: number) => string;
    engine: (evaluation: string) => string;
};

/** Reasons whose move was decided on the statistics, and on the engine. */
const STATS_REASONS: MoveReason[] = ["score", "mostPlayed", "onlyMove", "stats"];
const ENGINE_REASONS: MoveReason[] = ["engineChoice", "outOfBook", "engine"];

/**
 * Annotation of a move of the line: the score (green) or the evaluation (blue)
 * for the studied side, how often the move was played for a popular opponent
 * reply, and the evaluation for an opponent engine move.
 */
export function lineComment(
    node: BestLineNode,
    studiedColor: Color,
    labels: LineCommentLabels,
): { text: string; color?: "green" | "blue" } {
    const studied = node.color === studiedColor;
    if (STATS_REASONS.includes(node.reason) && node.stats) {
        return { text: labels.winrate(formatPercent(node.stats.score)), color: "green" };
    }
    if ((node.reason === "popular" || node.reason === "trap") && node.stats) {
        return { text: labels.played(formatPercent(node.stats.share), node.stats.games) };
    }
    if (ENGINE_REASONS.includes(node.reason) && node.score) {
        const text = labels.engine(formatScore(node.score.value));
        return studied ? { text, color: "blue" } : { text };
    }
    if (node.reason === "manual") {
        if (node.stats) {
            return {
                text: studied
                    ? labels.winrate(formatPercent(node.stats.score))
                    : labels.played(formatPercent(node.stats.share), node.stats.games),
            };
        }
        if (node.score) {
            return { text: formatScore(node.score.value) };
        }
    }
    return { text: "" };
}

/** Retries `fn` when it is rate-limited, waiting `delayMs` before each new try. */
export async function withRateLimitRetry<T>(
    fn: () => Promise<T>,
    {
        isRateLimited,
        sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        delayMs = 60_000,
        retries = 3,
        onWait,
        isCancelled,
    }: {
        isRateLimited: (error: unknown) => boolean;
        sleep?: (ms: number) => Promise<void>;
        delayMs?: number;
        retries?: number;
        onWait?: (ms: number) => void;
        isCancelled?: () => boolean;
    },
): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await fn();
        } catch (e) {
            if (!isRateLimited(e) || attempt >= retries || isCancelled?.()) throw e;
            onWait?.(delayMs);
            await sleep(delayMs);
            if (isCancelled?.()) throw e;
        }
    }
}
