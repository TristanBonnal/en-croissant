import { expect, test } from "vitest";
import { backup, type BackupOptions, type Edge, isLive, type SearchNode } from "../bestLine/node";
import type { Value } from "../bestLine/value";

const options: BackupOptions = { risk: 1, pruneZ: 2.5, indifference: 0.005 };

const value = (mean: number, sigma = 0.01): Value => ({ mean, sigma, source: "stats" });

function edge(san: string, v: Value, games = 1000, expansions = 1): Edge {
    return {
        san,
        uci: san,
        outcome: { wins: games / 2, draws: 0, losses: games / 2 },
        probability: 0,
        status: "contender",
        value: v,
        expansions,
    };
}

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

/** Links a child under an edge, as an expansion does. */
function attach(parent: SearchNode, e: Edge, child: SearchNode) {
    e.child = child;
    child.parent = { node: parent, edge: e };
    return child;
}

// --- backing up values -------------------------------------------------------

test("backup of a studied node takes the value of its best candidate", () => {
    const edges = [edge("e4", value(0.55)), edge("d4", value(0.6))];
    const root = node({ edges });
    backup(root, options);
    expect(root.value.mean).toBeCloseTo(0.6, 10);
    expect(edges[1].status).toBe("chosen");
    expect(edges[0].status).toBe("contender");
});

test("backup of a studied node compares the candidates on their lower bound", () => {
    // 62% measured on few games (σ 0.04) against 60% on many (σ 0.005).
    const edges = [edge("e4", value(0.6, 0.005)), edge("d4", value(0.62, 0.04))];
    const root = node({ edges });
    backup(root, options);
    expect(edges[0].status).toBe("chosen");
    // The value kept is the move's own, not its penalized one.
    expect(root.value).toEqual(edges[0].value);
});

test("backup of an opponent node mixes its replies and the games they leave out", () => {
    const replies = [
        { ...edge("e5", value(0.4)), probability: 0.5 },
        { ...edge("c5", value(0.6)), probability: 0.25 },
    ];
    const root = node({
        studied: false,
        edges: replies,
        rest: { weight: 0.25, value: value(0.8) },
        weightSamples: Number.POSITIVE_INFINITY,
    });
    backup(root, options);
    expect(root.value.mean).toBeCloseTo(0.5 * 0.4 + 0.25 * 0.6 + 0.25 * 0.8, 10);
});

test("backup walks up to the root", () => {
    const deep = node({ studied: false, value: value(0.7) });
    const chosen = edge("e4", value(0.55));
    const root = node({ edges: [chosen, edge("d4", value(0.5))] });
    attach(root, chosen, deep);
    deep.value = value(0.7);

    backup(deep, options);

    expect(chosen.value.mean).toBeCloseTo(0.7, 10);
    expect(root.value.mean).toBeCloseTo(0.7, 10);
});

// --- pruning -----------------------------------------------------------------

test("a candidate whose best case falls under the leader is pruned", () => {
    const edges = [edge("e4", value(0.6, 0.002)), edge("d4", value(0.55, 0.002))];
    const root = node({ edges });
    backup(root, options);
    expect(edges[1].status).toBe("pruned");
    expect(edges[0].status).toBe("chosen");
});

test("a candidate is not pruned before its subtree was expanded once", () => {
    // Expanding a move raises its value, so a move judged on its raw
    // statistics alone has not had its chance yet.
    const edges = [edge("e4", value(0.6, 0.002)), edge("d4", value(0.55, 0.002), 1000, 0)];
    backup(node({ edges }), options);
    expect(edges[1].status).toBe("contender");
});

test("pruning never removes the last candidate", () => {
    const edges = [edge("e4", value(0.6, 0.002))];
    backup(node({ edges }), options);
    expect(edges[0].status).toBe("chosen");
});

test("candidates that cannot be told apart settle on the most played one", () => {
    const edges = [edge("e4", value(0.6, 0.002), 1000), edge("d4", value(0.602, 0.002), 50000)];
    const root = node({ edges });
    backup(root, options);
    // 0.002 apart, under the indifference margin: the move with 50 times more
    // games wins, and the other stops being searched.
    expect(edges[1].status).toBe("chosen");
    expect(edges[0].status).toBe("pruned");
});

test("isLive is false under a pruned move", () => {
    const pruned = { ...edge("d4", value(0.5)), status: "pruned" as const };
    const root = node({ edges: [pruned] });
    const child = attach(root, pruned, node({ studied: false }));
    expect(isLive(root)).toBe(true);
    expect(isLive(child)).toBe(false);
});
