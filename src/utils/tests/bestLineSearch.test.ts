import { INITIAL_FEN } from "chessops/fen";
import { expect, test } from "vitest";
import { legalSans, playSan } from "@/utils/bestLine/position";
import { coverageOf, searchBestLine } from "@/utils/bestLine/search";
import { toBestLineNodes } from "@/utils/bestLine/project";
import { mainBranch } from "@/utils/bestLine/tree";
import { fakeBook, fakeEngine, searchParams as params } from "./bestLineFixtures";

// --- expansion ---------------------------------------------------------------

test("searchBestLine plays a move at the root and values it", async () => {
    const book = fakeBook();
    const engine = fakeEngine();
    const { root } = await searchBestLine(params({ maxPlies: 1 }), {
        explore: book.explore,
        analyze: engine.analyze,
    });

    const chosen = root.edges?.find((e) => e.status === "chosen");
    expect(chosen).toBeDefined();
    expect(root.value.mean).toBeGreaterThan(0);
    expect(root.value.mean).toBeLessThan(1);
    expect(root.value.source).toBe("stats");
});

test("searchBestLine asks the explorer once per position, whatever the branching", async () => {
    const book = fakeBook();
    const engine = fakeEngine();
    const { stats } = await searchBestLine(params(), {
        explore: book.explore,
        analyze: engine.analyze,
    });

    expect(new Set(book.explored).size).toBe(book.explored.length);
    expect(book.explored.length).toBe(stats.expanded);
});

test("searchBestLine only asks the engine at the studied side's positions", async () => {
    const book = fakeBook();
    const engine = fakeEngine();
    const { root } = await searchBestLine(params(), {
        explore: book.explore,
        analyze: engine.analyze,
    });

    // The opponent's replies come from the explorer alone.
    const studiedFens = new Set<string>();
    const walk = (node: typeof root) => {
        if (node.studied && node.edges) studiedFens.add(node.fen);
        for (const edge of node.edges ?? []) if (edge.child) walk(edge.child);
    };
    walk(root);
    expect(engine.analysed.length).toBeGreaterThan(0);
    for (const { fen } of engine.analysed) expect(studiedFens.has(fen)).toBe(true);
});

test("searchBestLine stops at the maximum number of plies", async () => {
    const book = fakeBook();
    const engine = fakeEngine();
    const { root } = await searchBestLine(params({ maxPlies: 3 }), {
        explore: book.explore,
        analyze: engine.analyze,
    });

    expect(mainBranch(root).length).toBe(3);
    const deepest = mainBranch(root).at(-1)!;
    expect(deepest.child?.stopped).toBe("maxPly");
});

test("searchBestLine leaves the book when a position has too few games", async () => {
    const afterFirst = playSan(INITIAL_FEN, legalSans(INITIAL_FEN, 1)[0])!.fen;
    const book = fakeBook({ thin: { [afterFirst]: 10 } });
    const engine = fakeEngine();
    const { root, stats } = await searchBestLine(params({ maxPlies: 2 }), {
        explore: book.explore,
        analyze: engine.analyze,
    });

    const thin = root.edges?.find((e) => e.child?.fen === afterFirst)?.child;
    expect(thin?.stopped).toBe("outOfBook");
    expect(stats.outOfBook).toBeGreaterThan(0);
    // Out of book the engine decides, so the line keeps going.
    expect(thin?.edges?.length).toBe(1);
});

test("searchBestLine never opens a position it would reach too rarely", async () => {
    const book = fakeBook({ shares: [0.6, 0.3, 0.05] });
    const engine = fakeEngine();
    // 0.05 of the games at the first reply, 0.03 after two: under the threshold.
    const { stats, root } = await searchBestLine(params({ maxPlies: 4, minReach: 0.04 }), {
        explore: book.explore,
        analyze: engine.analyze,
    });

    expect(stats.lowReach).toBeGreaterThan(0);
    const reaches: number[] = [];
    const walk = (node: typeof root) => {
        if (node.edges) reaches.push(node.reach);
        for (const edge of node.edges ?? []) if (edge.child) walk(edge.child);
    };
    walk(root);
    for (const reach of reaches) expect(reach).toBeGreaterThanOrEqual(0.04);
});

test("searchBestLine opens the most likely positions first", async () => {
    const book = fakeBook({ shares: [0.6, 0.3] });
    const engine = fakeEngine();
    const { root } = await searchBestLine(params({ maxPlies: 4 }), {
        explore: book.explore,
        analyze: engine.analyze,
    });

    // The first opponent reply explored is the most played one.
    const opponent = root.edges?.find((e) => e.status === "chosen")?.child;
    const replies = (opponent?.edges ?? []).filter((e) => e.status === "reply");
    expect(replies.length).toBeGreaterThan(1);
    const order = replies.map((e) => book.explored.indexOf(e.child?.fen ?? ""));
    expect(order[0]).toBeLessThan(order[1]);
    expect(replies[0].probability).toBeGreaterThan(replies[1].probability);
});

test("searchBestLine returns the tree it has when the search is cancelled", async () => {
    const book = fakeBook();
    const engine = fakeEngine();
    let calls = 0;
    const { root, stats } = await searchBestLine(params({ maxPlies: 6 }), {
        explore: book.explore,
        analyze: engine.analyze,
        isCancelled: () => ++calls > 6,
    });

    expect(stats.expanded).toBeGreaterThan(0);
    expect(mainBranch(root).length).toBeGreaterThan(0);
    expect(stats.cancelled).toBe(true);
});

test("searchBestLine plays a forced first move", async () => {
    const book = fakeBook();
    const engine = fakeEngine();
    const forced = legalSans(INITIAL_FEN, 3)[2];
    const { root } = await searchBestLine(params({ maxPlies: 2, forcedMove: forced }), {
        explore: book.explore,
        analyze: engine.analyze,
    });

    expect(root.edges?.length).toBe(1);
    expect(root.edges?.[0].san).toBe(forced);
    expect(root.edges?.[0].status).toBe("chosen");
});

test("searchBestLine reports the progress of the search", async () => {
    const book = fakeBook();
    const engine = fakeEngine();
    const progress: number[] = [];
    await searchBestLine(params(), {
        explore: book.explore,
        analyze: engine.analyze,
        onProgress: (stats) => progress.push(stats.expanded),
    });

    expect(progress.length).toBeGreaterThan(1);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
});

test("searchBestLine finds the same tree when it fetches positions ahead", async () => {
    const run = async (ahead: boolean) => {
        const book = fakeBook({ shares: [0.5, 0.3, 0.1] });
        const engine = fakeEngine([30, 25, 10, 0, -10]);
        const cache = new Map<string, ReturnType<typeof book.explore>>();
        const explore = (fen: string) => {
            if (!cache.has(fen)) cache.set(fen, book.explore(fen));
            return cache.get(fen)!;
        };
        const prefetched: string[] = [];
        const result = await searchBestLine(params({ maxPlies: 5, minReach: 0.01 }), {
            explore,
            analyze: engine.analyze,
            prefetch: ahead
                ? (fen) => {
                      prefetched.push(fen);
                      void explore(fen);
                      return true;
                  }
                : undefined,
        });
        return { ...result, prefetched };
    };
    const plain = await run(false);
    const ahead = await run(true);

    expect(ahead.prefetched.length).toBeGreaterThan(0);
    expect(ahead.stats).toEqual(plain.stats);
    expect(toBestLineNodes(ahead.root, { mode: "tree", metric: "score" })).toEqual(
        toBestLineNodes(plain.root, { mode: "tree", metric: "score" }),
    );
});

// --- coverage ----------------------------------------------------------------

test("coverageOf measures the share of games the tree accounts for", async () => {
    const book = fakeBook({ shares: [0.6, 0.3] });
    const engine = fakeEngine();
    const { root } = await searchBestLine(params({ maxPlies: 2 }), {
        explore: book.explore,
        analyze: engine.analyze,
    });

    // One opponent move deep, the two replies the search follows cover about
    // 90% of the games, the rest being moves it leaves out.
    expect(coverageOf(root)).toBeGreaterThan(0.8);
    expect(coverageOf(root)).toBeLessThanOrEqual(1);
});
