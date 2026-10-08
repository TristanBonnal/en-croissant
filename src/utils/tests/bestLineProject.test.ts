import { INITIAL_FEN } from "chessops/fen";
import { expect, test } from "vitest";
import { mainLine } from "@/utils/bestLine";
import { legalSans, playSan } from "@/utils/bestLine/position";
import { toBestLineNodes, trapFlag } from "@/utils/bestLine/project";
import { searchBestLine } from "@/utils/bestLine/search";
import { fakeBook, fakeEngine, searchParams } from "./bestLineFixtures";

async function tree(overrides = {}) {
    const book = fakeBook({ shares: [0.6, 0.3] });
    const engine = fakeEngine();
    const { root } = await searchBestLine(searchParams(overrides), {
        explore: book.explore,
        analyze: engine.analyze,
    });
    return root;
}

test("toBestLineNodes keeps one reply per position in line mode", async () => {
    const nodes = toBestLineNodes(await tree({ maxPlies: 4 }), { mode: "line" });
    expect(nodes).toHaveLength(1);
    expect(mainLine(nodes)).toHaveLength(4);
    for (const node of mainLine(nodes)) expect(node.children.length).toBeLessThanOrEqual(1);
});

test("toBestLineNodes keeps every searched reply in tree mode", async () => {
    const nodes = toBestLineNodes(await tree({ maxPlies: 2 }), { mode: "tree" });
    // Our move is unique, the opponent's answers are not.
    expect(nodes).toHaveLength(1);
    expect(nodes[0].children.length).toBeGreaterThan(1);
    // The most played reply comes first, so the main line follows it.
    const [first, second] = nodes[0].children;
    expect(first.stats!.share).toBeGreaterThan(second.stats!.share);
});

test("toBestLineNodes carries the value backed up for each move", async () => {
    const nodes = toBestLineNodes(await tree({ maxPlies: 2 }), { mode: "line" });
    const chosen = nodes[0].candidates.find((c) => c.status === "chosen");
    expect(chosen?.value).toBeGreaterThan(0);
    expect(chosen?.value).toBeLessThan(1);
});

test("toBestLineNodes lists the alternatives of our move with their status", async () => {
    const nodes = toBestLineNodes(await tree({ maxPlies: 1 }), { mode: "line" });
    const statuses = nodes[0].candidates.map((c) => c.status);
    expect(statuses.filter((s) => s === "chosen")).toHaveLength(1);
    expect(statuses.length).toBeGreaterThan(1);
    expect(nodes[0].candidates.every((c) => c.san.length > 0)).toBe(true);
});

test("toBestLineNodes reads the statistics from the point of view of whoever plays", async () => {
    const nodes = toBestLineNodes(await tree({ maxPlies: 2 }), { mode: "line" });
    const ours = nodes[0];
    const theirs = ours.children[0];
    // The book scores 50/20/30, so the side playing white scores 60%.
    expect(ours.stats!.score).toBeCloseTo(0.6, 2);
    expect(ours.stats!.opponentScore).toBeCloseTo(0.4, 2);
    expect(theirs.stats!.score).toBeCloseTo(0.4, 2);
    expect(theirs.stats!.opponentScore).toBeCloseTo(0.6, 2);
});

test("toBestLineNodes says why each move was played", async () => {
    const nodes = toBestLineNodes(await tree({ maxPlies: 2 }), { mode: "line" });
    expect(nodes[0].reason).toBe("stats");
    expect(nodes[0].children[0].reason).toBe("popular");
    expect(nodes[0].color).toBe("white");
    expect(nodes[0].children[0].color).toBe("black");
});

test("toBestLineNodes marks a forced move as played by hand", async () => {
    const book = fakeBook();
    const engine = fakeEngine();
    const { root } = await searchBestLine(searchParams({ maxPlies: 1, forcedMove: "Nf3" }), {
        explore: book.explore,
        analyze: engine.analyze,
    });
    const nodes = toBestLineNodes(root, { mode: "line" });
    expect(nodes[0].san).toBe("Nf3");
    expect(nodes[0].reason).toBe("manual");
});

test("toBestLineNodes of a position the engine decided reports an engine move", async () => {
    // Nobody played this position: no statistics, the engine decides.
    const book = fakeBook({ games: 10 });
    const engine = fakeEngine();
    const { root } = await searchBestLine(searchParams({ maxPlies: 1 }), {
        explore: book.explore,
        analyze: engine.analyze,
    });
    const nodes = toBestLineNodes(root, { mode: "line" });
    expect(nodes[0].reason).toBe("engine");
    expect(nodes[0].score).toBeDefined();
});

test("toBestLineNodes of a root nobody searched returns no move", async () => {
    const nodes = toBestLineNodes(
        {
            fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            studied: true,
            ply: 0,
            reach: 1,
            outcome: { wins: 0, draws: 0, losses: 0 },
            value: { mean: 0.5, sigma: 0, source: "engine" },
        },
        { mode: "line" },
    );
    expect(nodes).toEqual([]);
});

// --- annotations and traps ---------------------------------------------------

test("toBestLineNodes grades an opponent move that gives away win chances", async () => {
    const book = fakeBook({ shares: [0.6, 0.3] });
    const ours = playSan(INITIAL_FEN, legalSans(INITIAL_FEN, 1)[0])!.fen;
    const blunder = playSan(ours, legalSans(ours, 1)[0])!.fen;
    // Our evaluation jumps from +0.30 to +3.00 after the opponent's reply.
    const engine = fakeEngine([30, 20], { cpsOf: (fen) => (fen === blunder ? [300] : undefined) });
    const { root } = await searchBestLine(searchParams({ maxPlies: 3 }), {
        explore: book.explore,
        analyze: engine.analyze,
    });

    const nodes = toBestLineNodes(root, { mode: "line" });
    expect(nodes[0].annotation).toBeUndefined();
    expect(nodes[0].children[0].annotation).toBe("??");
});

test("toBestLineNodes leaves a sound opponent reply unannotated", async () => {
    const nodes = toBestLineNodes(await tree({ maxPlies: 3 }), { mode: "line" });
    expect(nodes[0].children[0].annotation).toBeUndefined();
});

test("trapFlag only keeps a frequent mistake the studied side punishes", () => {
    const mistake = { score: 0.3, opponentScore: 0.7, games: 500, share: 0.08 };
    // Played 8% of the time, and the studied side scores 0.70 after it instead
    // of 0.55 in the position: worth preparing.
    expect(trapFlag("?", mistake, 0.55, 0.05)).toBe(true);
    // Too rare to be worth a branch.
    expect(trapFlag("?", { ...mistake, share: 0.01 }, 0.55, 0.05)).toBe(false);
    // Nobody punishes it in practice.
    expect(trapFlag("?", mistake, 0.69, 0.05)).toBe(false);
    // Not a mistake at all.
    expect(trapFlag("?!", mistake, 0.55, 0.05)).toBe(false);
    // The option is off.
    expect(trapFlag("?", mistake, 0.55, undefined)).toBe(false);
});
