import type { Color } from "chessops";
import type { Score } from "@/bindings";
import { getWinChance, normalizeScore } from "@/utils/score";
import {
    expectedScore,
    type Outcome,
    type Rates,
    scoreVariance,
    shrinkRates,
    standardError,
    totalGames,
} from "./stats";

/**
 * Every value the search compares is an expected result for the studied side,
 * in [0, 1], measured with the search's metric. Statistics and evaluations are
 * never averaged together: an evaluation only *replaces* a value the explorer
 * cannot provide, and is converted to the same unit before it does.
 */

export type ValueSource = "stats" | "engine" | "terminal";

export type Value = {
    /** Expected result of the studied side, in [0, 1]. */
    mean: number;
    /** Standard error of `mean`; zero when the result is certain. */
    sigma: number;
    source: ValueSource;
};

/** Uncertainty given to an evaluation, in expected result. */
export const ENGINE_SIGMA = 0.02;

/** Draw rate assumed where the explorer knows nothing. */
export const DEFAULT_DRAW_RATE = 0.3;

/** Value of a move or a position measured on the games played from it. */
export function statsValue(
    outcome: Outcome,
    position: Rates,
    k: number,
    drawWeight: number,
): Value {
    const rates = shrinkRates(outcome, position, k);
    return {
        mean: expectedScore(rates, drawWeight),
        sigma: standardError(scoreVariance(rates, drawWeight), totalGames(outcome), k),
        source: "stats",
    };
}

/**
 * Value of a position nobody played, from the engine. The evaluation is a
 * win chance, i.e. an expected score with draws counted as half a point, so
 * with the "wins" metric half the draw rate has to come off — otherwise an
 * engine leaf would beat an equivalent statistical one by about 0.15, and the
 * search would systematically leave the book.
 */
export function engineValue(
    score: Score,
    studied: Color,
    drawWeight: number,
    drawRate: number,
): Value {
    if (score.value.type === "mate") {
        const won = studied === "white" ? score.value.value > 0 : score.value.value < 0;
        return { mean: won ? 1 : 0, sigma: 0, source: "terminal" };
    }
    const expected = getWinChance(normalizeScore(score.value, studied)) / 100;
    const mean = expected - (1 - 2 * drawWeight) * (drawRate / 2);
    return { mean: Math.min(1, Math.max(0, mean)), sigma: ENGINE_SIGMA, source: "engine" };
}

/** Value of a finished game. */
export function terminalValue(result: "win" | "loss" | "draw", drawWeight: number): Value {
    const mean = result === "win" ? 1 : result === "loss" ? 0 : drawWeight;
    return { mean, sigma: 0, source: "terminal" };
}

/** Pessimistic estimate of a value: `z` standard errors below its mean. */
export function lowerBound(value: Value, z: number): number {
    return value.mean - z * value.sigma;
}

/** Optimistic estimate of a value. */
export function upperBound(value: Value, z: number): number {
    return value.mean + z * value.sigma;
}

/**
 * Best of several values, compared on their lower bound so that a flattering
 * small sample has to beat a solid one by more than its own noise. The value
 * returned is the winner's own, unpenalized: subtracting `z·σ` again at every
 * ply would make the result of a deep search meaningless.
 */
export function bestValue(values: Value[], z: number): { index: number; value: Value } {
    let index = 0;
    for (let i = 1; i < values.length; i++) {
        if (lowerBound(values[i], z) > lowerBound(values[index], z)) index = i;
    }
    return { index, value: values[index] };
}

/**
 * Expected value over the opponent's replies. `weightSamples` is the number of
 * games the shares themselves are measured on: how often each reply is played
 * is uncertain too, and that uncertainty dominates at the edge of the book.
 */
export function mixValue(parts: { weight: number; value: Value }[], weightSamples: number): Value {
    const mean = parts.reduce((acc, p) => acc + p.weight * p.value.mean, 0);
    const fromValues = parts.reduce(
        (acc, p) => acc + p.weight * p.weight * p.value.sigma * p.value.sigma,
        0,
    );
    const spread = parts.reduce(
        (acc, p) => acc + p.weight * (p.value.mean - mean) * (p.value.mean - mean),
        0,
    );
    const fromWeights =
        weightSamples > 0 && Number.isFinite(weightSamples) ? spread / weightSamples : 0;
    const source = parts.every((p) => p.value.source === "terminal") ? "terminal" : "stats";
    return { mean, sigma: Math.sqrt(fromValues + fromWeights), source };
}
