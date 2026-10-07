import type { Color } from "chessops";
import { makeUci } from "chessops";
import { Chess } from "chessops/chess";
import { makeFen, parseFen } from "chessops/fen";
import { makeSanAndPlay, parseSan } from "chessops/san";
import { z } from "zod";
import type { BestMoves, Score } from "@/bindings";
import { formatScore, getWinChance, normalizeScore } from "./score";

/** Score gap (as a fraction) under which the move with more games is preferred (raw ranking). */
export const SCORE_TIE_THRESHOLD = 0.01;

/** Number of engine lines analysed for each position. */
export const BEST_LINE_MULTIPV = 5;

/** z-score of the Wilson ranking (95% confidence). */
export const WILSON_Z = 1.96;

/** Number of opponent replies listed as alternatives. */
const LISTED_REPLIES = 5;

export const bestLineSettingsSchema = z.object({
    color: z.enum(["white", "black"]).default("white"),
    engine: z.string().default(""),
    depth: z.number().int().min(1).default(18),
    fullMoves: z.number().int().min(1).default(6),
    mode: z.enum(["line", "tree"]).default("line"),
    branchMinShare: z.number().min(0).max(1).default(0.15),
    branchMaxReplies: z.number().int().min(1).default(3),
    branchDepth: z.number().int().min(1).default(1),
    toleranceMode: z.enum(["pawns", "winChance"]).default("pawns"),
    engineTolerance: z.number().min(0).default(0.3),
    winChanceTolerance: z.number().min(0).default(3),
    ranking: z.enum(["wilson", "raw"]).default("wilson"),
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

export type Ranking = "wilson" | "raw";

export type Branching = {
    /** Minimum share of the position's games for an opponent reply to get its own branch. */
    minShare: number;
    /** Maximum number of opponent replies explored per position (1 = single line). */
    maxReplies: number;
    /** Number of opponent moves that can branch; later ones follow the most played reply. */
    maxDepth: number;
};

export type MoveReason = "stats" | "popular" | "engine" | "manual";

export type MoveStats = {
    /** Score of the move for the side playing it: (wins + draws / 2) / games. */
    score: number;
    games: number;
    /** Share of the position's games where this move was played. */
    share: number;
};

export type MoveChoice = {
    san: string;
    reason: MoveReason;
    score?: Score;
    stats?: MoveStats;
};

export type CandidateStatus = "chosen" | "outOfTolerance" | "fewGames" | "lowerScore" | "other";

/** A move considered in a position, and why it was (not) played. */
export type Candidate = {
    san: string;
    score?: Score;
    stats?: MoveStats;
    status: CandidateStatus;
};

export type BestLineNode = MoveChoice & {
    uci: string;
    color: Color;
    /** Position before the move. */
    fen: string;
    candidates: Candidate[];
    children: BestLineNode[];
};

export type BestLineParams = {
    fen: string;
    color: Color;
    plies: number;
    tolerance: Tolerance;
    ranking: Ranking;
    /** Minimum games in a position to follow the opponent's most played moves. */
    minimumGames: number;
    /** Minimum games for a studied side's candidate to be ranked by its stats. */
    minGamesPerMove: number;
    branching: Branching;
    /** Move played first instead of the one the search would choose. */
    forcedMove?: string;
};

export type BestLineDeps = {
    analyze: (fen: string) => Promise<BestMoves[]>;
    explore: (fen: string) => Promise<ExplorerPosition>;
    isCancelled?: () => boolean;
    /** Called for each move added to the line. */
    onPosition?: () => void;
};

function games(move: { white: number; draws: number; black: number }) {
    return move.white + move.draws + move.black;
}

export function moveScore(move: ExplorerMove, color: Color): number {
    const total = games(move);
    if (total === 0) return 0;
    const wins = color === "white" ? move.white : move.black;
    return (wins + move.draws * 0.5) / total;
}

/** Lower bound of the Wilson score interval: a score that accounts for the sample size. */
export function wilsonLowerBound(score: number, n: number, z = WILSON_Z): number {
    if (n === 0) return 0;
    const z2 = z * z;
    const center = score + z2 / (2 * n);
    const margin = z * Math.sqrt((score * (1 - score)) / n + z2 / (4 * n * n));
    return (center - margin) / (1 + z2 / n);
}

function sanKey(san: string) {
    return san.replace(/[+#!?]/g, "");
}

function moveStats(move: ExplorerMove, position: ExplorerPosition, color: Color): MoveStats {
    const total = games(position);
    return {
        score: moveScore(move, color),
        games: games(move),
        share: total === 0 ? 0 : games(move) / total,
    };
}

function findStats(position: ExplorerPosition, san: string, color: Color): MoveStats | undefined {
    const move = position.moves.find((m) => sanKey(m.san) === sanKey(san));
    return move && moveStats(move, position, color);
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

function bestLine(lines: BestMoves[], color: Color): BestMoves {
    return [...lines].sort(
        (a, b) => normalizeScore(b.score.value, color) - normalizeScore(a.score.value, color),
    )[0];
}

type Entry = { line: BestMoves; stats?: MoveStats; admissible: boolean };

function rank(eligible: (Entry & { stats: MoveStats })[], ranking: Ranking) {
    if (ranking === "wilson") {
        const bound = (e: Entry & { stats: MoveStats }) =>
            wilsonLowerBound(e.stats.score, e.stats.games);
        return eligible.reduce((a, b) => (bound(b) > bound(a) ? b : a));
    }
    const bestScore = Math.max(...eligible.map((e) => e.stats.score));
    return eligible
        .filter((e) => e.stats.score >= bestScore - SCORE_TIE_THRESHOLD - Number.EPSILON)
        .reduce((a, b) => (b.stats.games > a.stats.games ? b : a));
}

export function selectStudiedMove(
    lines: BestMoves[],
    explorer: ExplorerPosition,
    color: Color,
    options: { tolerance: Tolerance; ranking: Ranking; minGamesPerMove: number },
): { choice: MoveChoice; candidates: Candidate[] } {
    const admissible = admissibleMoves(lines, color, options.tolerance);
    const entries: Entry[] = lines.map((line) => ({
        line,
        stats: findStats(explorer, line.sanMoves[0], color),
        admissible: admissible.includes(line),
    }));
    const eligible = entries.filter(
        (e): e is Entry & { stats: MoveStats } =>
            e.admissible && !!e.stats && e.stats.games >= options.minGamesPerMove,
    );

    const chosen =
        eligible.length > 0
            ? rank(eligible, options.ranking)
            : entries.find((e) => e.line === bestLine(admissible, color))!;
    const choice: MoveChoice = {
        san: chosen.line.sanMoves[0],
        reason: eligible.length > 0 ? "stats" : "engine",
        score: chosen.line.score,
        stats: chosen.stats,
    };
    const candidates = entries.map(
        (e): Candidate => ({
            san: e.line.sanMoves[0],
            score: e.line.score,
            stats: e.stats,
            status:
                e === chosen
                    ? "chosen"
                    : !e.admissible
                      ? "outOfTolerance"
                      : eligible.includes(e as Entry & { stats: MoveStats })
                        ? "lowerScore"
                        : "fewGames",
        }),
    );
    return { choice, candidates };
}

export function selectOpponentReplies(
    position: ExplorerPosition,
    color: Color,
    minimumGames: number,
    branching: Pick<Branching, "minShare" | "maxReplies">,
): { replies: MoveChoice[]; candidates: Candidate[] } {
    const total = games(position);
    if (position.moves.length === 0 || total < minimumGames) {
        return { replies: [], candidates: [] };
    }
    const sorted = [...position.moves].sort((a, b) => games(b) - games(a));
    const chosen = sorted.filter(
        (m, i) => i === 0 || (i < branching.maxReplies && games(m) / total >= branching.minShare),
    );
    return {
        replies: chosen.map((m) => ({
            san: m.san,
            reason: "popular",
            stats: moveStats(m, position, color),
        })),
        candidates: sorted.slice(0, Math.max(LISTED_REPLIES, chosen.length)).map((m) => ({
            san: m.san,
            stats: moveStats(m, position, color),
            status: chosen.includes(m) ? "chosen" : "other",
        })),
    };
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
    if (node.reason === "stats" && node.stats) {
        return { text: labels.winrate(formatPercent(node.stats.score)), color: "green" };
    }
    if (node.reason === "popular" && node.stats) {
        return { text: labels.played(formatPercent(node.stats.share), node.stats.games) };
    }
    if (node.reason === "engine" && node.score) {
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

/** Moves chosen in a position, the alternatives considered, and the position's evaluation. */
type Choices = { moves: MoveChoice[]; candidates: Candidate[]; evaluation?: Score };

async function chooseMoves(
    fen: string,
    turn: Color,
    params: BestLineParams,
    deps: BestLineDeps,
    canBranch: boolean,
    forcedMove?: string,
): Promise<Choices> {
    const branching = canBranch ? params.branching : { ...params.branching, maxReplies: 1 };
    const studied = turn === params.color;
    const options = {
        tolerance: params.tolerance,
        ranking: params.ranking,
        minGamesPerMove: params.minGamesPerMove,
    };

    if (forcedMove) {
        const explorer = await deps.explore(fen);
        const lines = studied ? await deps.analyze(fen) : [];
        const candidates = studied
            ? lines.length > 0
                ? selectStudiedMove(lines, explorer, turn, options).candidates
                : []
            : selectOpponentReplies(explorer, turn, 0, branching).candidates;
        return {
            moves: [
                {
                    san: forcedMove,
                    reason: "manual",
                    score: lines.find((l) => sanKey(l.sanMoves[0]) === sanKey(forcedMove))?.score,
                    stats: findStats(explorer, forcedMove, turn),
                },
            ],
            candidates: candidates.map((c) => ({
                ...c,
                status:
                    sanKey(c.san) === sanKey(forcedMove)
                        ? "chosen"
                        : c.status === "chosen"
                          ? "other"
                          : c.status,
            })),
            evaluation: lines.length > 0 ? bestLine(lines, turn).score : undefined,
        };
    }

    if (studied) {
        const lines = await deps.analyze(fen);
        if (lines.length === 0) return { moves: [], candidates: [] };
        const explorer = await deps.explore(fen);
        const { choice, candidates } = selectStudiedMove(lines, explorer, turn, options);
        return { moves: [choice], candidates, evaluation: bestLine(lines, turn).score };
    }

    const explorer = await deps.explore(fen);
    const { replies, candidates } = selectOpponentReplies(
        explorer,
        turn,
        params.minimumGames,
        branching,
    );
    if (replies.length > 0) return { moves: replies, candidates };

    const lines = await deps.analyze(fen);
    if (lines.length === 0) return { moves: [], candidates: [] };
    const best = bestLine(lines, turn);
    return {
        moves: [
            {
                san: best.sanMoves[0],
                reason: "engine",
                score: best.score,
                stats: findStats(explorer, best.sanMoves[0], turn),
            },
        ],
        candidates: lines.map((l) => ({
            san: l.sanMoves[0],
            score: l.score,
            stats: findStats(explorer, l.sanMoves[0], turn),
            status: l === best ? "chosen" : "other",
        })),
        evaluation: best.score,
    };
}

/**
 * Builds the moves for `params.plies` plies from `params.fen`.
 * The studied side plays the best scoring move among the engine moves close
 * enough to the best one; the opponent plays its most played moves (one per
 * position, or several with branching), or the engine move when the position
 * has too few games. Moves played without the engine get the evaluation of
 * the resulting position.
 * When cancelled, returns the moves found so far.
 */
export async function findBestLine(
    params: BestLineParams,
    deps: BestLineDeps,
): Promise<BestLineNode[]> {
    const cancelled = () => deps.isCancelled?.() ?? false;

    async function evaluate(pos: Chess): Promise<Score | undefined> {
        if (cancelled() || pos.isEnd()) return undefined;
        try {
            const lines = await deps.analyze(makeFen(pos.toSetup()));
            return lines.length > 0 ? bestLine(lines, pos.turn).score : undefined;
        } catch (e) {
            if (cancelled()) return undefined;
            throw e;
        }
    }

    async function expand(
        pos: Chess,
        plies: number,
        opponentMoves: number,
        forcedMove?: string,
    ): Promise<{ nodes: BestLineNode[]; evaluation?: Score }> {
        if (plies <= 0 || cancelled() || pos.isEnd()) return { nodes: [] };

        const fen = makeFen(pos.toSetup());
        const turn = pos.turn;
        const isOpponent = turn !== params.color;
        const canBranch = opponentMoves < params.branching.maxDepth;
        let choices: Choices;
        try {
            choices = await chooseMoves(fen, turn, params, deps, canBranch, forcedMove);
        } catch (e) {
            if (cancelled()) return { nodes: [] };
            throw e;
        }

        const nodes: BestLineNode[] = [];
        for (const choice of choices.moves) {
            if (cancelled()) break;
            const child = pos.clone();
            const move = parseSan(child, choice.san);
            if (!move) continue;
            const uci = makeUci(move);
            const san = makeSanAndPlay(child, move);
            const node: BestLineNode = {
                ...choice,
                san,
                uci,
                color: turn,
                fen,
                candidates: choices.candidates,
                children: [],
            };
            nodes.push(node);
            deps.onPosition?.();

            const next = await expand(child, plies - 1, opponentMoves + (isOpponent ? 1 : 0));
            node.children = next.nodes;
            if (!node.score) {
                node.score = next.evaluation ?? (await evaluate(child));
            }
        }
        return { nodes, evaluation: choices.evaluation };
    }

    const pos = Chess.fromSetup(parseFen(params.fen).unwrap()).unwrap();
    return (await expand(pos, params.plies, 0, params.forcedMove)).nodes;
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
