import type { Color } from "chessops";
import { makeFen, parseFen } from "chessops/fen";
import { makeSanAndPlay, parseSan } from "chessops/san";
import { Chess } from "chessops/chess";
import { makeUci } from "chessops";
import { z } from "zod";
import type { BestMoves, Score } from "@/bindings";
import { formatScore, normalizeScore } from "./score";

/** Score gap (as a fraction) under which the move with more games is preferred. */
export const SCORE_TIE_THRESHOLD = 0.01;

/** Number of engine lines analysed for each position. */
export const BEST_LINE_MULTIPV = 5;

export const bestLineSettingsSchema = z.object({
    color: z.enum(["white", "black"]).default("white"),
    engine: z.string().default(""),
    depth: z.number().int().min(1).default(18),
    fullMoves: z.number().int().min(1).default(6),
    engineTolerance: z.number().min(0).default(0.3),
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

export type MoveReason = "stats" | "popular" | "engine";

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

export type BestLineStep = MoveChoice & {
    uci: string;
    color: Color;
};

export type BestLineParams = {
    fen: string;
    color: Color;
    fullMoves: number;
    /** Maximum evaluation loss accepted, in pawns. */
    tolerance: number;
    /** Minimum games in a position to follow the opponent's most played move. */
    minimumGames: number;
    /** Minimum games for a studied side's candidate to be ranked by its stats. */
    minGamesPerMove: number;
};

export type BestLineDeps = {
    analyze: (fen: string) => Promise<BestMoves[]>;
    explore: (fen: string) => Promise<ExplorerPosition>;
    isCancelled?: () => boolean;
    onProgress?: (done: number, total: number) => void;
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

export function admissibleMoves(lines: BestMoves[], color: Color, tolerance: number): BestMoves[] {
    const evals = lines.map((l) => normalizeScore(l.score.value, color));
    const best = Math.max(...evals);
    return lines.filter((_, i) => evals[i] >= best - tolerance * 100);
}

export function selectStudiedMove(
    admissible: BestMoves[],
    explorer: ExplorerPosition,
    color: Color,
    minGamesPerMove: number,
): MoveChoice {
    const candidates = admissible.flatMap((line) => {
        const stats = findStats(explorer, line.sanMoves[0], color);
        if (!stats || stats.games < minGamesPerMove) return [];
        return [{ line, stats }];
    });

    if (candidates.length === 0) {
        const [best] = [...admissible].sort(
            (a, b) => normalizeScore(b.score.value, color) - normalizeScore(a.score.value, color),
        );
        return {
            san: best.sanMoves[0],
            reason: "engine",
            score: best.score,
            stats: findStats(explorer, best.sanMoves[0], color),
        };
    }

    const bestScore = Math.max(...candidates.map((c) => c.stats.score));
    const chosen = candidates
        .filter((c) => c.stats.score >= bestScore - SCORE_TIE_THRESHOLD - Number.EPSILON)
        .reduce((a, b) => (b.stats.games > a.stats.games ? b : a));
    return {
        san: chosen.line.sanMoves[0],
        reason: "stats",
        score: chosen.line.score,
        stats: chosen.stats,
    };
}

export function selectOpponentMove(
    position: ExplorerPosition,
    color: Color,
    minimumGames: number,
): MoveChoice | null {
    if (position.moves.length === 0 || games(position) < minimumGames) return null;
    const mostPlayed = position.moves.reduce((a, b) => (games(b) > games(a) ? b : a));
    return {
        san: mostPlayed.san,
        reason: "popular",
        stats: moveStats(mostPlayed, position, color),
    };
}

/**
 * Annotation of a move of the line: the score (green) or the evaluation (blue)
 * for the studied side, how often the move was played for a popular opponent
 * reply, and the evaluation for an opponent engine move.
 */
export type LineCommentLabels = {
    winrate: (score: string) => string;
    played: (share: string, games: number) => string;
    engine: (evaluation: string) => string;
};

export function lineComment(
    step: BestLineStep,
    studiedColor: Color,
    labels: LineCommentLabels,
): { text: string; color?: "green" | "blue" } {
    if (step.reason === "stats" && step.stats) {
        return { text: labels.winrate(formatPercent(step.stats.score)), color: "green" };
    }
    if (step.reason === "popular" && step.stats) {
        return { text: labels.played(formatPercent(step.stats.share), step.stats.games) };
    }
    if (step.reason === "engine" && step.score) {
        const text = labels.engine(formatScore(step.score.value));
        return step.color === studiedColor ? { text, color: "blue" } : { text };
    }
    return { text: "" };
}

function bestScore(lines: BestMoves[], turn: Color): Score {
    return admissibleMoves(lines, turn, 0)[0].score;
}

/** The chosen move, and the evaluation of the position when it was analysed. */
type Choice = { move: MoveChoice | null; evaluation?: Score };

async function chooseMove(
    fen: string,
    turn: Color,
    params: BestLineParams,
    deps: BestLineDeps,
): Promise<Choice> {
    if (turn === params.color) {
        const lines = await deps.analyze(fen);
        if (lines.length === 0) return { move: null };
        const admissible = admissibleMoves(lines, turn, params.tolerance);
        const explorer = await deps.explore(fen);
        return {
            move: selectStudiedMove(admissible, explorer, turn, params.minGamesPerMove),
            evaluation: bestScore(lines, turn),
        };
    }

    const explorer = await deps.explore(fen);
    const popular = selectOpponentMove(explorer, turn, params.minimumGames);
    if (popular) return { move: popular };

    const lines = await deps.analyze(fen);
    if (lines.length === 0) return { move: null };
    const [best] = admissibleMoves(lines, turn, 0);
    return {
        move: {
            san: best.sanMoves[0],
            reason: "engine",
            score: best.score,
            stats: findStats(explorer, best.sanMoves[0], turn),
        },
        evaluation: best.score,
    };
}

/**
 * Builds a line of `fullMoves` moves for each side from `params.fen`.
 * The studied side plays the best scoring move among the engine moves close
 * enough to the best one; the opponent plays its most played move, or the
 * engine move when the position has too few games.
 * When cancelled, returns the moves found so far.
 */
export async function findBestLine(
    params: BestLineParams,
    deps: BestLineDeps,
): Promise<BestLineStep[]> {
    const pos = Chess.fromSetup(parseFen(params.fen).unwrap()).unwrap();
    const total = params.fullMoves * 2;
    const steps: BestLineStep[] = [];
    const cancelled = () => deps.isCancelled?.() ?? false;

    for (let ply = 0; ply < total; ply++) {
        if (cancelled() || pos.isEnd()) break;

        const fen = makeFen(pos.toSetup());
        const turn = pos.turn;
        let choice: MoveChoice | null;
        try {
            const { move, evaluation } = await chooseMove(fen, turn, params, deps);
            // A move played without the engine is evaluated by the next analysis.
            const previous = steps.at(-1);
            if (previous && !previous.score && evaluation) {
                previous.score = evaluation;
            }
            choice = move;
        } catch (e) {
            if (cancelled()) break;
            throw e;
        }
        if (cancelled() || !choice) break;

        const move = parseSan(pos, choice.san);
        if (!move) break;
        const uci = makeUci(move);
        const san = makeSanAndPlay(pos, move);
        steps.push({ ...choice, san, uci, color: turn });
        deps.onProgress?.(ply + 1, total);
    }

    const last = steps.at(-1);
    if (last && !last.score && !cancelled() && !pos.isEnd()) {
        try {
            const lines = await deps.analyze(makeFen(pos.toSetup()));
            if (lines.length > 0) {
                last.score = bestScore(lines, pos.turn);
            }
        } catch (e) {
            if (!cancelled()) throw e;
        }
    }

    return steps;
}
