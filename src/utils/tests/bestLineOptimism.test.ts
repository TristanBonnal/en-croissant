import { expect, test } from "vitest";
import { type BackupOptions, type Edge, type SearchNode } from "../bestLine/node";
import { type Lookahead, nextPositions } from "../bestLine/optimism";
import type { Value } from "../bestLine/value";

const options: BackupOptions = { risk: 1, pruneZ: 2.5, indifference: 0.005 };
const lookahead: Lookahead = { maxPlies: 6, choiceGain: 0.02 };

const value = (mean: number, sigma = 0.005): Value => ({ mean, sigma, source: "stats" });

function node(partial: Partial<SearchNode> = {}): SearchNode {
    return {
        fen: "fen",
        studied: true,
        ply: 0,
        reach: 1,
        outcome: { wins: 500, draws: 0, losses: 500 },
        value: value(0.5),
        ...partial,
    };
}

/** A move from `parent` to a position not opened yet, as an expansion leaves it. */
function move(
    parent: SearchNode,
    san: string,
    v: Value,
    status: Edge["status"],
    probability = 0,
): Edge {
    const edge: Edge = {
        san,
        uci: san,
        outcome: { wins: 50, draws: 0, losses: 50 },
        probability,
        status,
        value: v,
        expansions: 0,
    };
    const child = node({
        fen: `${parent.fen} ${san}`,
        studied: !parent.studied,
        ply: parent.ply + 1,
        reach: parent.reach * (parent.studied ? 1 : probability),
        value: v,
        parent: { node: parent, edge },
    });
    edge.child = child;
    parent.edges = [...(parent.edges ?? []), edge];
    return edge;
}

test("the next position is below the chosen move when no other move can catch up", () => {
    const root = node();
    const e4 = move(root, "e4", value(0.56), "chosen");
    move(root, "d4", value(0.5), "contender");

    const next = nextPositions(root, options, lookahead).peek(10);
    expect(next).toEqual([e4.child]);
});

test("the next position is below a contender whose hopes beat the chosen move", () => {
    const root = node();
    const e4 = move(root, "e4", value(0.56), "chosen");
    const d4 = move(root, "d4", value(0.55), "contender");
    // Below e4, every choice was made: d4 still has two to hope from.
    e4.child!.stopped = "maxPly";

    expect(nextPositions(root, options, lookahead).pop()).toBe(d4.child);
});

test("positions below a move that cannot win even with every hope stay closed", () => {
    const root = node();
    const e4 = move(root, "e4", value(0.56), "chosen");
    const d4 = move(root, "d4", value(0.5), "contender");
    // e4 is searched to the end: nothing is left to hope for below it.
    e4.child!.stopped = "maxPly";

    expect(nextPositions(root, options, lookahead).size).toBe(0);
    expect(d4.child?.edges).toBeUndefined();
});

test("the replies that add the most hope come first", () => {
    const root = node();
    const e4 = move(root, "e4", value(0.55), "chosen");
    const opponent = e4.child!;
    opponent.edges = [];
    const e5 = move(opponent, "e5", value(0.55), "reply", 0.6);
    const c5 = move(opponent, "c5", value(0.55), "reply", 0.3);
    opponent.rest = { weight: 0.1, value: value(0.55) };

    expect(nextPositions(root, options, lookahead).peek(2)).toEqual([e5.child, c5.child]);
});

test("the replies only listed are never opened", () => {
    const root = node({ studied: false });
    move(root, "e5", value(0.55), "other", 0.02);
    root.rest = { weight: 1, value: value(0.55) };

    expect(nextPositions(root, options, lookahead).size).toBe(0);
});

test("the chosen moves are searched to the end once the candidate tree is", () => {
    const root = node();
    const e4 = move(root, "e4", value(0.56, 0.001), "chosen");
    // d4 is hoped to be better, but was searched to the end and is not.
    const d4 = move(root, "d4", value(0.55, 0.03), "contender");
    d4.child!.stopped = "maxPly";

    expect(nextPositions(root, { ...options, risk: 0 }, lookahead).peek(10)).toEqual([e4.child]);
});
