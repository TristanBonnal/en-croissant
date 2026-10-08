import { expect, test } from "vitest";
import type { Score } from "@/bindings";
import {
    drawWeightOf,
    expectedScore,
    outcomeOf,
    type Rates,
    ratesOf,
    scoreVariance,
    shrinkRates,
    standardError,
    totalGames,
} from "../bestLine/stats";
import {
    bestValue,
    engineValue,
    lowerBound,
    mixValue,
    statsValue,
    terminalValue,
    upperBound,
    type Value,
} from "../bestLine/value";

const games = (white: number, draws: number, black: number) => ({ white, draws, black });
const cp = (value: number): Score => ({ value: { type: "cp", value }, wdl: null });
const mate = (value: number): Score => ({ value: { type: "mate", value }, wdl: null });

const SCORE = drawWeightOf("score");
const WINS = drawWeightOf("wins");

/** A position where the pool scores 65%: half wins, 30% draws. */
const POOL: Rates = { win: 0.5, draw: 0.3, loss: 0.2 };

// --- counts ------------------------------------------------------------------

test("outcomeOf reads the games from the studied side's point of view", () => {
    expect(outcomeOf(games(55, 10, 35), "white")).toEqual({ wins: 55, draws: 10, losses: 35 });
    expect(outcomeOf(games(55, 10, 35), "black")).toEqual({ wins: 35, draws: 10, losses: 55 });
    expect(totalGames(outcomeOf(games(55, 10, 35), "white"))).toBe(100);
});

test("ratesOf has no rates without a game", () => {
    expect(ratesOf({ wins: 55, draws: 10, losses: 35 })).toEqual({
        win: 0.55,
        draw: 0.1,
        loss: 0.35,
    });
    expect(ratesOf({ wins: 0, draws: 0, losses: 0 })).toBeUndefined();
});

// --- shrinkage ---------------------------------------------------------------

test("shrinkRates leaves a move with many games almost untouched", () => {
    const shrunk = shrinkRates({ wins: 5500, draws: 1000, losses: 3500 }, POOL, 100);
    expect(shrunk.win).toBeCloseTo(0.5495, 4);
    expect(shrunk.draw).toBeCloseTo(0.102, 4);
});

test("shrinkRates pulls a move with few games to the rates of its position", () => {
    const shrunk = shrinkRates({ wins: 1, draws: 0, losses: 0 }, POOL, 100);
    expect(shrunk.win).toBeCloseTo(0.505, 3);
    expect(shrunk.draw).toBeCloseTo(0.297, 3);
    expect(shrunk.win + shrunk.draw + shrunk.loss).toBeCloseTo(1, 10);
});

test("shrinkRates without games returns the rates of the position", () => {
    expect(shrinkRates({ wins: 0, draws: 0, losses: 0 }, POOL, 100)).toEqual(POOL);
});

test("shrinkRates with no shrinkage returns the raw rates", () => {
    expect(shrinkRates({ wins: 55, draws: 10, losses: 35 }, POOL, 0)).toEqual({
        win: 0.55,
        draw: 0.1,
        loss: 0.35,
    });
});

// --- score and variance ------------------------------------------------------

test("expectedScore counts a draw as half a point, or as nothing", () => {
    const rates: Rates = { win: 0.55, draw: 0.1, loss: 0.35 };
    expect(expectedScore(rates, SCORE)).toBeCloseTo(0.6, 10);
    expect(expectedScore(rates, WINS)).toBeCloseTo(0.55, 10);
});

test("scoreVariance of games that are all drawn is zero with the score metric", () => {
    const allDraws: Rates = { win: 0, draw: 1, loss: 0 };
    expect(scoreVariance(allDraws, SCORE)).toBeCloseTo(0, 10);
    // With the wins metric a draw is a loss, so there is no variance either.
    expect(scoreVariance(allDraws, WINS)).toBeCloseTo(0, 10);
});

test("scoreVariance with the wins metric is the Bernoulli variance", () => {
    const rates: Rates = { win: 0.55, draw: 0.1, loss: 0.35 };
    expect(scoreVariance(rates, WINS)).toBeCloseTo(0.55 * 0.45, 10);
    expect(scoreVariance(rates, SCORE)).toBeCloseTo(0.215, 10);
});

test("standardError falls as the square root of the number of games", () => {
    expect(standardError(0.25, 100, 0)).toBeCloseTo(0.05, 10);
    expect(standardError(0.25, 10000, 0)).toBeCloseTo(0.005, 10);
    // The fictitious games of the shrinkage count as observations.
    expect(standardError(0.25, 0, 100)).toBeCloseTo(0.05, 10);
});

// --- values ------------------------------------------------------------------

test("statsValue of a move won once is not a certainty", () => {
    const value = statsValue({ wins: 1, draws: 0, losses: 0 }, POOL, 100, SCORE);
    expect(value.mean).toBeCloseTo(0.6535, 4);
    expect(value.sigma).toBeCloseTo(0.0388, 4);
    expect(value.source).toBe("stats");
});

test("statsValue of a move without games is the value of its position", () => {
    const value = statsValue({ wins: 0, draws: 0, losses: 0 }, POOL, 100, SCORE);
    expect(value.mean).toBeCloseTo(0.65, 10);
});

test("engineValue turns an evaluation into an expected score", () => {
    expect(engineValue(cp(0), "white", SCORE, 0.3).mean).toBeCloseTo(0.5, 10);
    expect(engineValue(cp(100), "white", SCORE, 0.3).mean).toBeCloseTo(0.591, 3);
    // Mirrored evaluations of the same position sum to one.
    expect(
        engineValue(cp(100), "white", SCORE, 0.3).mean +
            engineValue(cp(100), "black", SCORE, 0.3).mean,
    ).toBeCloseTo(1, 10);
});

test("engineValue drops the draws of the position with the wins metric", () => {
    // Expected score and expected wins differ by half the draw rate: without
    // this, an engine leaf would outscore a statistical one by about 0.15.
    expect(engineValue(cp(100), "white", WINS, 0.3).mean).toBeCloseTo(0.591 - 0.15, 3);
    expect(engineValue(cp(-800), "white", WINS, 0.3).mean).toBeGreaterThanOrEqual(0);
});

test("engineValue of a mate is a certainty, not the evaluation ceiling", () => {
    // getWinChance caps at 0.976 because evaluations are clamped to 1000cp.
    expect(engineValue(mate(3), "white", SCORE, 0.3).mean).toBe(1);
    expect(engineValue(mate(-3), "white", SCORE, 0.3).mean).toBe(0);
    expect(engineValue(mate(3), "white", SCORE, 0.3).sigma).toBe(0);
});

test("terminalValue scores a draw by the metric", () => {
    expect(terminalValue("win", SCORE)).toEqual({ mean: 1, sigma: 0, source: "terminal" });
    expect(terminalValue("loss", SCORE)).toEqual({ mean: 0, sigma: 0, source: "terminal" });
    expect(terminalValue("draw", SCORE).mean).toBe(0.5);
    expect(terminalValue("draw", WINS).mean).toBe(0);
});

// --- comparison and mixing ---------------------------------------------------

const value = (mean: number, sigma: number): Value => ({ mean, sigma, source: "stats" });

test("lowerBound and upperBound move by z standard deviations", () => {
    expect(lowerBound(value(0.6, 0.02), 2)).toBeCloseTo(0.56, 10);
    expect(upperBound(value(0.6, 0.02), 2)).toBeCloseTo(0.64, 10);
    expect(lowerBound(value(0.6, 0.02), 0)).toBeCloseTo(0.6, 10);
});

test("bestValue prefers the solid candidate to the flattering one", () => {
    // 60% on a large sample against 62% on a small one.
    const solid = value(0.6, 0.01);
    const flattering = value(0.62, 0.03);
    expect(bestValue([solid, flattering], 2).index).toBe(0);
    expect(bestValue([solid, flattering], 0).index).toBe(1);
});

test("bestValue keeps the mean of the candidate it picks, not its lower bound", () => {
    // Backing up the lower bound would stack the penalty at every ply.
    expect(bestValue([value(0.6, 0.01), value(0.62, 0.03)], 2).value).toEqual({
        mean: 0.6,
        sigma: 0.01,
        source: "stats",
    });
});

test("mixValue weights each reply by its probability", () => {
    const mixed = mixValue(
        [
            { weight: 0.5, value: value(0.6, 0.02) },
            { weight: 0.5, value: value(0.4, 0.02) },
        ],
        Number.POSITIVE_INFINITY,
    );
    expect(mixed.mean).toBeCloseTo(0.5, 10);
    expect(mixed.sigma).toBeCloseTo(Math.sqrt(2 * 0.25 * 0.0004), 10);
});

test("mixValue adds the uncertainty of the probabilities themselves", () => {
    const parts = [
        { weight: 0.5, value: value(0.6, 0.02) },
        { weight: 0.5, value: value(0.4, 0.02) },
    ];
    // 100 games only: how often each reply is played is uncertain too.
    expect(mixValue(parts, 100).sigma).toBeCloseTo(Math.sqrt(0.0003), 10);
    expect(mixValue(parts, 100).sigma).toBeGreaterThan(
        mixValue(parts, Number.POSITIVE_INFINITY).sigma,
    );
});

test("mixValue of a single reply keeps its value", () => {
    const mixed = mixValue([{ weight: 1, value: value(0.6, 0.02) }], Number.POSITIVE_INFINITY);
    expect(mixed).toEqual({ mean: 0.6, sigma: 0.02, source: "stats" });
});
