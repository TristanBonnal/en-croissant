import type { Color } from "chessops";

/**
 * Arithmetic of the explorer counts, always from the studied side's point of
 * view. Nothing here knows about the engine: these are the only numbers the
 * search is allowed to average, shrink or compare between moves.
 */

/** How a move's results are measured: "wins" counts a draw as nothing. */
export type Metric = "wins" | "score";

/** Points a draw is worth for a metric. */
export function drawWeightOf(metric: Metric): number {
    return metric === "score" ? 0.5 : 0;
}

/** Games of a position or of a move, for the studied side. */
export type Outcome = { wins: number; draws: number; losses: number };

/** Shares of wins, draws and losses; they sum to 1. */
export type Rates = { win: number; draw: number; loss: number };

export function outcomeOf(
    games: { white: number; draws: number; black: number },
    studied: Color,
): Outcome {
    const wins = studied === "white" ? games.white : games.black;
    const losses = studied === "white" ? games.black : games.white;
    return { wins, draws: games.draws, losses };
}

export function totalGames(outcome: Outcome): number {
    return outcome.wins + outcome.draws + outcome.losses;
}

/** Rates of an outcome, or undefined when it has no game at all. */
export function ratesOf(outcome: Outcome): Rates | undefined {
    const total = totalGames(outcome);
    if (total === 0) return undefined;
    return {
        win: outcome.wins / total,
        draw: outcome.draws / total,
        loss: outcome.losses / total,
    };
}

/** Difference of two outcomes, floored at zero (replies left uncovered). */
export function subtractOutcome(whole: Outcome, part: Outcome): Outcome {
    return {
        wins: Math.max(0, whole.wins - part.wins),
        draws: Math.max(0, whole.draws - part.draws),
        losses: Math.max(0, whole.losses - part.losses),
    };
}

export function addOutcome(a: Outcome, b: Outcome): Outcome {
    return { wins: a.wins + b.wins, draws: a.draws + b.draws, losses: a.losses + b.losses };
}

/**
 * Rates of an outcome regularized towards those of its position, `k` standing
 * for the number of games the position's rates are worth. The whole
 * distribution is shrunk, not only the score: shrinking the score alone would
 * leave a move won on its single game with no variance at all, i.e. certain.
 */
export function shrinkRates(outcome: Outcome, target: Rates, k: number): Rates {
    const total = totalGames(outcome);
    if (total === 0) return target;
    if (k === 0) return ratesOf(outcome) ?? target;
    return {
        win: (outcome.wins + k * target.win) / (total + k),
        draw: (outcome.draws + k * target.draw) / (total + k),
        loss: (outcome.losses + k * target.loss) / (total + k),
    };
}

/** Expected result of one game, in [0, 1]. */
export function expectedScore(rates: Rates, drawWeight: number): number {
    return rates.win + drawWeight * rates.draw;
}

/** Variance of the result of one game. */
export function scoreVariance(rates: Rates, drawWeight: number): number {
    const mean = expectedScore(rates, drawWeight);
    return Math.max(0, rates.win + drawWeight * drawWeight * rates.draw - mean * mean);
}

/** Standard error of a mean measured on `games` games plus `k` fictitious ones. */
export function standardError(variance: number, games: number, k: number): number {
    const total = games + k;
    return total <= 0 ? 0 : Math.sqrt(variance / total);
}
