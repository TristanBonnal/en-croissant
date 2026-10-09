import { INITIAL_FEN } from "chessops/fen";
import { expect, test } from "vitest";
import { legalSans, playSan, uciOf } from "@/utils/bestLine/position";
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

// --- candidates --------------------------------------------------------------

test("searchBestLine takes its candidates from the explorer, beyond the engine's first lines", async () => {
    // The most played move is the engine's sixth, still within tolerance.
    const book = fakeBook({ shares: [0.05, 0.05, 0.05, 0.05, 0.05, 0.7] });
    const engine = fakeEngine([30, 25, 20, 15, 10, 5]);
    const { root } = await searchBestLine(params({ maxPlies: 1 }), {
        explore: book.explore,
        analyze: engine.analyze,
    });

    const sixth = legalSans(INITIAL_FEN, 6)[5];
    expect(root.edges?.find((e) => e.status === "chosen")?.san).toBe(sixth);
});

test("searchBestLine only checks the move it plays, with the engine's best line alone when it is the same", async () => {
    // The most played move is the engine's best: one line is all it takes.
    const book = fakeBook({ shares: [0.6, 0.3] });
    const engine = fakeEngine([30, 20]);
    const { root } = await searchBestLine(params({ maxPlies: 1 }), {
        explore: book.explore,
        analyze: engine.analyze,
    });

    expect(engine.analysed).toEqual([{ fen: INITIAL_FEN, purpose: "candidates", multipv: 1 }]);
    // The other candidate was never checked.
    expect(root.edges?.filter((e) => e.checked)).toHaveLength(1);
});

test("searchBestLine checks the move it plays on its own when the engine plays another", async () => {
    const book = fakeBook({ shares: [0.3, 0.6] });
    const engine = fakeEngine([30, 20]);
    await searchBestLine(params({ maxPlies: 1 }), {
        explore: book.explore,
        analyze: engine.analyze,
    });

    const played = legalSans(INITIAL_FEN, 2)[1];
    expect(engine.analysed).toEqual([
        { fen: INITIAL_FEN, purpose: "candidates", multipv: 1 },
        {
            fen: INITIAL_FEN,
            purpose: "candidates",
            multipv: 1,
            searchMoves: [uciOf(INITIAL_FEN, played)],
        },
    ]);
});

test("searchBestLine checks the next candidate when the one it plays is rejected", async () => {
    const book = fakeBook({ shares: [0.3, 0.6] });
    const engine = fakeEngine([30, -70]);
    const { root } = await searchBestLine(params({ maxPlies: 1 }), {
        explore: book.explore,
        analyze: engine.analyze,
    });

    const [best, bad] = legalSans(INITIAL_FEN, 2);
    expect(root.edges?.find((e) => e.san === bad)?.status).toBe("outOfTolerance");
    expect(root.edges?.find((e) => e.status === "chosen")?.san).toBe(best);
    expect(root.edges?.find((e) => e.san === best)?.checked).toBe(true);
});

test("searchBestLine drops a candidate out of tolerance before searching below it", async () => {
    // The most played move loses a pawn.
    const book = fakeBook({ shares: [0.3, 0.6] });
    const engine = fakeEngine([30, -70]);
    const { root } = await searchBestLine(params({ maxPlies: 3 }), {
        explore: book.explore,
        analyze: engine.analyze,
    });

    const [best, bad] = legalSans(INITIAL_FEN, 2);
    expect(root.edges?.find((e) => e.san === bad)?.status).toBe("outOfTolerance");
    expect(root.edges?.find((e) => e.status === "chosen")?.san).toBe(best);
    expect(book.explored).not.toContain(playSan(INITIAL_FEN, bad)?.fen);
});

test("searchBestLine never analyses a position it does not search below", async () => {
    const book = fakeBook();
    const engine = fakeEngine();
    const { root } = await searchBestLine(params({ maxPlies: 6, minReach: 0.05 }), {
        explore: book.explore,
        analyze: engine.analyze,
    });

    const searchedBelow = new Set<string>();
    const walk = (node: typeof root) => {
        const below = (node.edges ?? []).some((edge) => edge.child?.edges);
        if (node.studied && (below || node.ply + 1 >= 6)) searchedBelow.add(node.fen);
        for (const edge of node.edges ?? []) if (edge.child) walk(edge.child);
    };
    walk(root);
    for (const { fen } of engine.analysed) expect(searchedBelow.has(fen)).toBe(true);
});

test("searchBestLine checks candidates at the precise depth and searches on below the replacement", async () => {
    // The most played move is rejected by the engine: the line goes on below the other.
    const book = fakeBook({ shares: [0.3, 0.6] });
    const engine = fakeEngine([30, 25], { precise: [30, -70] });
    const { root } = await searchBestLine(params({ maxPlies: 4 }), {
        explore: book.explore,
        analyze: engine.analyze,
    });

    const [best, rejected] = legalSans(INITIAL_FEN, 2);
    expect(root.edges?.find((e) => e.san === rejected)?.status).toBe("outOfTolerance");
    const chosen = root.edges?.find((e) => e.status === "chosen");
    expect(chosen?.san).toBe(best);
    // The line goes on to the last ply below the replacement.
    let depth = 0;
    for (let node = chosen?.child; node?.edges; depth++) {
        const next = node.edges.find((e) => e.status === "chosen" || e.status === "reply");
        node = next?.child;
    }
    expect(depth).toBe(3);
});

test("uciOf writes castling as the engine expects it", () => {
    const fen = "r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4";
    expect(uciOf(fen, "O-O")).toBe("e1g1");
    expect(uciOf(fen, "Nc3")).toBe("b1c3");
});

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

// --- candidates --------------------------------------------------------------

test("searchBestLine drops a move played in too small a share of the position's games", async () => {
    // 60% and 3% of 100 000 games: both have far more than the minimum per move.
    const book = fakeBook({ shares: [0.6, 0.03] });
    const engine = fakeEngine();
    const options = { explore: book.explore, analyze: engine.analyze };
    const [common, rare] = legalSans(INITIAL_FEN, 2);

    const open = await searchBestLine(params({ maxPlies: 1 }), options);
    expect(open.root.edges?.find((e) => e.san === rare)?.status).not.toBe("fewGames");

    const strict = await searchBestLine(params({ maxPlies: 1, minMoveShare: 0.05 }), options);
    expect(strict.root.edges?.find((e) => e.san === rare)?.status).toBe("fewGames");
    expect(strict.root.edges?.find((e) => e.status === "chosen")?.san).toBe(common);
});

test("searchBestLine ranks every move played often enough, not only the four most played", async () => {
    const shares = [0.3, 0.2, 0.15, 0.1, 0.08, 0.05];
    const book = fakeBook({ shares });
    const engine = fakeEngine([30, 29, 28, 27, 26, 25]);
    const { root } = await searchBestLine(params({ maxPlies: 1, minMoveShare: 0.01 }), {
        explore: book.explore,
        analyze: engine.analyze,
    });

    const ranked = root.edges?.filter((e) => e.status !== "fewGames") ?? [];
    expect(ranked).toHaveLength(shares.length);
    // Only the move it plays is compared with the engine.
    expect(engine.analysed.length).toBeLessThanOrEqual(2);
});

// --- traps -------------------------------------------------------------------

/**
 * A book where the second reply of the opponent is a mistake the studied side
 * scores well after (90% wins), and the engine says so. Replies are too rare to
 * be searched at `minReach` 0.5 except the most played one.
 */
function trapSetting() {
    const base = fakeBook({ shares: [0.6, 0.3] });
    const trapFen = new Set<string>();
    const explore = async (fen: string) => {
        const position = await base.explore(fen);
        return {
            ...position,
            moves: position.moves.map((move, i) =>
                i === 1 && fen !== INITIAL_FEN
                    ? { ...move, white: move.white * 2, black: Math.round(move.black / 3) }
                    : move,
            ),
        };
    };
    const [first] = legalSans(INITIAL_FEN, 1);
    const afterFirst = playSan(INITIAL_FEN, first)!.fen;
    const [, trap] = legalSans(afterFirst, 2);
    trapFen.add(playSan(afterFirst, trap)!.fen);
    const engine = fakeEngine([30], {
        cpsOf: (fen) => (trapFen.has(fen) ? [320] : undefined),
    });
    return { explore, engine, afterFirst, trap };
}

test("searchBestLine opens a frequent opponent mistake below the reach threshold when asked to", async () => {
    const { explore, engine, afterFirst, trap } = trapSetting();
    const withTraps = await searchBestLine(
        params({ maxPlies: 3, minReach: 0.5, trapMinShare: 0.05 }),
        { explore, analyze: engine.analyze },
    );
    const opponent = withTraps.root.edges?.find((e) => e.status === "chosen")?.child;
    expect(opponent?.fen).toBe(afterFirst);
    const reply = opponent?.edges?.find((e) => e.san === trap);
    expect(reply?.status).toBe("reply");
    expect(reply?.child?.edges).toBeDefined();

    const without = await searchBestLine(params({ maxPlies: 3, minReach: 0.5 }), {
        explore,
        analyze: engine.analyze,
    });
    const closed = without.root.edges?.find((e) => e.status === "chosen")?.child;
    expect(closed?.edges?.find((e) => e.san === trap)?.status).toBe("other");
});

test("searchBestLine does not open a frequent reply that is not a mistake", async () => {
    const base = fakeBook({ shares: [0.6, 0.3] });
    const engine = fakeEngine([30]);
    const { root } = await searchBestLine(
        params({ maxPlies: 3, minReach: 0.5, trapMinShare: 0.05 }),
        { explore: base.explore, analyze: engine.analyze },
    );
    const opponent = root.edges?.find((e) => e.status === "chosen")?.child;
    expect(opponent?.edges?.filter((e) => e.status === "reply")).toHaveLength(1);
});

// --- length of the line ------------------------------------------------------

test("searchBestLine plays the line to its full length even where the replies are rare", async () => {
    // Each reply is played in 40% of the games, so the line is below the reach
    // threshold after two of them: it still has to go the whole way.
    const book = fakeBook({ shares: [0.4, 0.3] });
    const engine = fakeEngine();
    const { root } = await searchBestLine(params({ maxPlies: 8, minReach: 0.2 }), {
        explore: book.explore,
        analyze: engine.analyze,
    });

    expect(mainBranch(root)).toHaveLength(8);
});
