import { expect, test } from "vitest";
import { Frontier } from "../bestLine/frontier";
import { moveProbabilities, uncoveredWeight } from "../bestLine/probability";

// --- opponent move probabilities ---------------------------------------------

test("moveProbabilities smooth the explorer counts over the legal moves", () => {
    const p = moveProbabilities([500, 300, 100], 1000, 20, 1);
    expect(p[0]).toBeCloseTo(501 / 1020, 10);
    expect(p[1]).toBeCloseTo(301 / 1020, 10);
    expect(p[2]).toBeCloseTo(101 / 1020, 10);
});

test("moveProbabilities keep a share for the moves the explorer did not list", () => {
    // 900 of the 1000 games are listed: the rest covers both the 100 games
    // played elsewhere and the legal moves nobody ever played.
    expect(uncoveredWeight(moveProbabilities([500, 300, 100], 1000, 20, 1))).toBeCloseTo(
        117 / 1020,
        10,
    );
});

test("moveProbabilities of a position nobody played are uniform", () => {
    const p = moveProbabilities([0, 0], 0, 20, 1);
    expect(p[0]).toBeCloseTo(1 / 20, 10);
    expect(uncoveredWeight(p)).toBeCloseTo(18 / 20, 10);
});

test("moveProbabilities without smoothing follow the counts exactly", () => {
    const p = moveProbabilities([500, 300, 200], 1000, 20, 0);
    expect(p).toEqual([0.5, 0.3, 0.2]);
    expect(uncoveredWeight(p)).toBeCloseTo(0, 10);
});

test("moveProbabilities never report more legal moves than the explorer lists", () => {
    // A position where every legal move was played at least once.
    const p = moveProbabilities([600, 400], 1000, 1, 1);
    expect(p[0] + p[1]).toBeCloseTo(1, 10);
});

// --- frontier ----------------------------------------------------------------

test("the frontier pops the most urgent entry first", () => {
    const frontier = new Frontier<string>();
    frontier.push("rare", 0.01);
    frontier.push("main", 0.5);
    frontier.push("sideline", 0.1);
    expect([frontier.pop(), frontier.pop(), frontier.pop()]).toEqual(["main", "sideline", "rare"]);
    expect(frontier.pop()).toBeUndefined();
    expect(frontier.size).toBe(0);
});

test("the frontier peeks at the next entries without popping them", () => {
    const frontier = new Frontier<string>();
    frontier.push("a", 0.2);
    frontier.push("b", 0.9);
    frontier.push("c", 0.5);
    expect(frontier.peek(2)).toEqual(["b", "c"]);
    expect(frontier.size).toBe(3);
});

test("the frontier keeps entries pushed with the same priority", () => {
    const frontier = new Frontier<number>();
    frontier.push(1, 0.5);
    frontier.push(2, 0.5);
    expect(frontier.size).toBe(2);
    expect([frontier.pop(), frontier.pop()].sort()).toEqual([1, 2]);
});

test("the frontier peeks only at the entries it is asked to keep", () => {
    const frontier = new Frontier<string>();
    frontier.push("a", 0.2);
    frontier.push("b", 0.9);
    frontier.push("c", 0.5);
    frontier.push("d", 0.1);
    expect(frontier.peek(2, (item) => item !== "b")).toEqual(["c", "a"]);
    expect(frontier.peek(10)).toEqual(["b", "c", "a", "d"]);
});
