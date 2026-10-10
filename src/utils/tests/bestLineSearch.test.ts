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

// --- out of book --------------------------------------------------------------

/**
 * A book where some positions have their own results (wins and draws as shares
 * of `games`, white's point of view) instead of the usual ones: what the
 * explorer says of a position nobody played much, whose moves are not looked at.
 */
function bookWith(
    results: Record<string, { wins: number; draws: number; games: number }>,
    base = fakeBook(),
) {
    const explore = async (fen: string) => {
        const position = await base.explore(fen);
        const own = results[fen];
        if (!own) return position;
        const white = Math.round(own.games * own.wins);
        const draws = Math.round(own.games * own.draws);
        return { ...position, white, draws, black: own.games - white - draws };
    };
    return { explore, explored: base.explored };
}

test("searchBestLine values a position it leaves the book at by its own games", async () => {
    // 2 000 games: too few to follow the explorer, plenty to say how the position goes.
    const [first] = legalSans(INITIAL_FEN, 1);
    const afterFirst = playSan(INITIAL_FEN, first)!.fen;
    const book = bookWith({ [afterFirst]: { wins: 0.6, draws: 0.2, games: 2000 } });
    const engine = fakeEngine([-80, -90]);
    const { root } = await searchBestLine(params({ maxPlies: 2 }), {
        explore: book.explore,
        analyze: engine.analyze,
    });

    const thin = root.edges?.find((e) => e.child?.fen === afterFirst)?.child;
    expect(thin?.stopped).toBe("outOfBook");
    // 0.6 + 0.2 / 2, whatever the engine thinks of the position.
    expect(thin?.value.source).toBe("stats");
    expect(thin?.value.mean).toBeGreaterThan(0.68);
});

test("searchBestLine prefers the better results to the better evaluation out of book", async () => {
    // Both replies lead to positions the explorer knows little about. The engine
    // likes the first better, but the games say the second scores more.
    const [one, two] = legalSans(INITIAL_FEN, 2);
    const afterOne = playSan(INITIAL_FEN, one)!.fen;
    const afterTwo = playSan(INITIAL_FEN, two)!.fen;
    const book = bookWith({
        [afterOne]: { wins: 0.35, draws: 0.2, games: 2000 },
        [afterTwo]: { wins: 0.55, draws: 0.2, games: 2000 },
    });
    const engine = fakeEngine([30, 25], {
        cpsOf: (fen) => (fen === afterOne ? [300] : fen === afterTwo ? [-300] : undefined),
    });
    const { root } = await searchBestLine(params({ maxPlies: 3, minGamesPerMove: 100 }), {
        explore: book.explore,
        analyze: engine.analyze,
    });

    expect(root.edges?.find((e) => e.status === "chosen")?.san).toBe(two);
});

test("searchBestLine leaves the engine's line below such a position to the end of the search", async () => {
    const [first] = legalSans(INITIAL_FEN, 1);
    const afterFirst = playSan(INITIAL_FEN, first)!.fen;
    const book = bookWith({ [afterFirst]: { wins: 0.5, draws: 0.2, games: 2000 } });
    const engine = fakeEngine();
    const { root } = await searchBestLine(params({ maxPlies: 6 }), {
        explore: book.explore,
        analyze: engine.analyze,
    });

    // The line still goes its whole length, with the engine's moves.
    expect(mainBranch(root)).toHaveLength(6);
    const thin = root.edges?.find((e) => e.child?.fen === afterFirst)?.child;
    expect(thin?.edges?.[0].decidedBy).toBe("outOfBook");
    // Nothing below the position was looked up: the games would not have changed a thing.
    const below = mainBranch(root)
        .slice(2)
        .map((edge) => edge.child?.fen);
    for (const fen of below) expect(book.explored).not.toContain(fen);
    // And the opponent's moves there are quick ones.
    const opponentAnalyses = engine.analysed.filter(
        (a) => a.fen !== INITIAL_FEN && a.fen.split(" ")[1] === "b",
    );
    for (const a of opponentAnalyses) expect(a.purpose).toBe("evaluation");
});

test("searchBestLine does not play the engine on below a position that is not kept", async () => {
    // Line mode keeps the most played reply only: the other one is left as it is.
    const [first] = legalSans(INITIAL_FEN, 1);
    const afterFirst = playSan(INITIAL_FEN, first)!.fen;
    const [likely, other] = legalSans(afterFirst, 2);
    const thinOther = playSan(afterFirst, other)!.fen;
    const thinLikely = playSan(afterFirst, likely)!.fen;
    const book = bookWith({
        [thinLikely]: { wins: 0.5, draws: 0.2, games: 2000 },
        [thinOther]: { wins: 0.5, draws: 0.2, games: 2000 },
    });
    const engine = fakeEngine();
    const run = (mode: "line" | "tree") =>
        searchBestLine(params({ maxPlies: 6, mode }), {
            explore: book.explore,
            analyze: engine.analyze,
        });

    const line = await run("line");
    const lineEdges = (fen: string) =>
        line.root.edges?.[0]?.child?.edges?.find((e) => e.child?.fen === fen)?.child?.edges;
    expect(lineEdges(thinLikely)).toBeDefined();
    expect(lineEdges(thinOther)).toBeUndefined();

    const tree = await run("tree");
    const treeEdges = (fen: string) =>
        tree.root.edges?.[0]?.child?.edges?.find((e) => e.child?.fen === fen)?.child?.edges;
    expect(treeEdges(thinOther)).toBeDefined();
});

test("searchBestLine only plays the engine on as far as the result is kept", async () => {
    // The result is the first move only (the live analysis): the line below is of no use.
    const [first] = legalSans(INITIAL_FEN, 1);
    const afterFirst = playSan(INITIAL_FEN, first)!.fen;
    const book = bookWith({ [afterFirst]: { wins: 0.5, draws: 0.2, games: 2000 } });
    const engine = fakeEngine();
    const { root } = await searchBestLine(params({ maxPlies: 6, keepPlies: 1 }), {
        explore: book.explore,
        analyze: engine.analyze,
    });

    const thin = root.edges?.find((e) => e.child?.fen === afterFirst)?.child;
    expect(thin?.edges).toBeUndefined();
    expect(engine.analysed.filter((a) => a.fen === afterFirst)).toHaveLength(0);
});

test("searchBestLine plays the engine's first move out of book even when only one move is kept", async () => {
    // The position searched is itself out of book: the move to play is the engine's.
    const book = fakeBook({ games: 2000 });
    const engine = fakeEngine();
    const { root } = await searchBestLine(params({ maxPlies: 3, keepPlies: 1 }), {
        explore: book.explore,
        analyze: engine.analyze,
    });

    expect(root.edges).toHaveLength(1);
    expect(root.edges?.[0].decidedBy).toBe("outOfBook");
    expect(root.edges?.[0].child?.edges).toBeUndefined();
});

test("searchBestLine does not play the engine on once the search is cancelled", async () => {
    const [first] = legalSans(INITIAL_FEN, 1);
    const afterFirst = playSan(INITIAL_FEN, first)!.fen;
    const book = bookWith({ [afterFirst]: { wins: 0.5, draws: 0.2, games: 2000 } });
    const engine = fakeEngine();
    let cancelled = false;
    const { root, stats } = await searchBestLine(params({ maxPlies: 6 }), {
        explore: book.explore,
        analyze: engine.analyze,
        onProgress: () => {
            cancelled = true;
        },
        isCancelled: () => cancelled,
    });

    expect(stats.cancelled).toBe(true);
    const thin = root.edges?.find((e) => e.child?.fen === afterFirst)?.child;
    expect(thin?.edges).toBeUndefined();
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

test("searchBestLine returns what it has when an analysis fails because the search was stopped", async () => {
    const book = fakeBook();
    const engine = fakeEngine();
    let stopped = false;
    const { root, stats } = await searchBestLine(params({ maxPlies: 6 }), {
        explore: book.explore,
        analyze: async (fen, request) => {
            // The engine gives up the analysis it was running when the user stops.
            if (fen !== INITIAL_FEN) {
                stopped = true;
                throw new Error("Analysis cancelled");
            }
            return engine.analyze(fen, request);
        },
        isCancelled: () => stopped,
    });

    expect(stats.cancelled).toBe(true);
    expect(root.edges?.length).toBeGreaterThan(0);
});

test("searchBestLine does not hide a failure the user did not ask for", async () => {
    const book = fakeBook();
    await expect(
        searchBestLine(params({ maxPlies: 2 }), {
            explore: book.explore,
            analyze: async () => {
                throw new Error("engine crashed");
            },
        }),
    ).rejects.toThrow("engine crashed");
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

// Only the first move is sound; the others lose at least a pawn.
const losing = [30, -70, ...Array(18).fill(-80)];

test("searchBestLine checks the played moves the engine ranks beyond its fifth line", async () => {
    // The most played move is the engine's sixth, and still within tolerance.
    const book = fakeBook({ shares: [0.05, 0.05, 0.05, 0.05, 0.05, 0.7] });
    const engine = fakeEngine([30, 25, 20, 15, 10, 5]);
    const { root } = await searchBestLine(params({ maxPlies: 1 }), {
        explore: book.explore,
        analyze: engine.analyze,
    });

    const sixth = legalSans(INITIAL_FEN, 6)[5];
    expect(root.edges?.find((e) => e.san === sixth)?.status).toBe("chosen");
    // One analysis for the first five lines, one restricted to the move left out.
    expect(engine.analysed).toEqual([
        { fen: INITIAL_FEN, purpose: "candidates", multipv: 5 },
        {
            fen: INITIAL_FEN,
            purpose: "candidates",
            multipv: 1,
            searchMoves: [uciOf(INITIAL_FEN, sixth)],
        },
    ]);
});

test("searchBestLine judges a move beyond the fifth line against the engine's best", async () => {
    // The sixth move is the most played, but loses a pawn.
    const book = fakeBook({ shares: [0.05, 0.05, 0.05, 0.05, 0.05, 0.7] });
    const engine = fakeEngine([30, 29, 28, 27, 26, -80]);
    const { root } = await searchBestLine(params({ maxPlies: 1 }), {
        explore: book.explore,
        analyze: engine.analyze,
    });

    const sixth = legalSans(INITIAL_FEN, 6)[5];
    expect(root.edges?.find((e) => e.san === sixth)?.status).toBe("outOfTolerance");
    expect(root.edges?.find((e) => e.status === "chosen")?.san).not.toBe(sixth);
});

test("searchBestLine asks for no more lines when the fifth is already out of tolerance", async () => {
    const book = fakeBook({ shares: [0.05, 0.05, 0.05, 0.05, 0.05, 0.7] });
    const engine = fakeEngine([30, 29, 28, 27, -80, -90]);
    await searchBestLine(params({ maxPlies: 1 }), {
        explore: book.explore,
        analyze: engine.analyze,
    });

    expect(engine.analysed).toHaveLength(1);
});

test("searchBestLine only checks the moves played often enough to be ranked", async () => {
    // The sixth move was played 20 times: it could not be ranked whatever the engine thinks.
    const book = fakeBook({ games: 100_000, shares: [0.2, 0.2, 0.2, 0.2, 0.19998, 0.0002] });
    const engine = fakeEngine([30, 29, 28, 27, 26, 25]);
    await searchBestLine(params({ maxPlies: 1 }), {
        explore: book.explore,
        analyze: engine.analyze,
    });

    expect(engine.analysed).toHaveLength(1);
});

test("searchBestLine checks at most the five most played moves left out", async () => {
    const shares = [0.02, 0.02, 0.02, 0.02, 0.02, 0.03, 0.06, 0.15, 0.2, 0.19, 0.09, 0.08];
    const book = fakeBook({ shares });
    const engine = fakeEngine([30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20, 19]);
    await searchBestLine(params({ maxPlies: 1 }), {
        explore: book.explore,
        analyze: engine.analyze,
    });

    const [, extra] = engine.analysed;
    const sans = legalSans(INITIAL_FEN, 12);
    const mostPlayedLeftOut = [8, 9, 7, 10, 11].map((i) => uciOf(INITIAL_FEN, sans[i]));
    expect(engine.analysed).toHaveLength(2);
    expect(extra.multipv).toBe(5);
    expect([...(extra.searchMoves ?? [])].sort()).toEqual([...mostPlayedLeftOut].sort());
});

test("searchBestLine analyses a studied position once, for its five first lines at the precise depth", async () => {
    const book = fakeBook({ shares: [0.6, 0.3] });
    const engine = fakeEngine([30, 20]);
    await searchBestLine(params({ maxPlies: 1 }), {
        explore: book.explore,
        analyze: engine.analyze,
    });

    expect(engine.analysed).toEqual([{ fen: INITIAL_FEN, purpose: "candidates", multipv: 5 }]);
});

test("searchBestLine plays the opponent's engine moves at the fast depth only", async () => {
    // Out of book everywhere below the first move: the engine plays both sides.
    const book = fakeBook({ games: 100_000 });
    const thinBook = {
        explored: book.explored,
        explore: async (fen: string) =>
            fen === INITIAL_FEN ? book.explore(fen) : { white: 0, draws: 0, black: 0, moves: [] },
    };
    const engine = fakeEngine();
    await searchBestLine(params({ maxPlies: 4 }), {
        explore: thinBook.explore,
        analyze: engine.analyze,
    });

    const opponent = engine.analysed.filter(
        (a) => a.fen !== INITIAL_FEN && a.fen.split(" ")[1] === "b",
    );
    expect(opponent.length).toBeGreaterThan(0);
    for (const a of opponent) expect(a.purpose).toBe("evaluation");
});

test("searchBestLine drops a candidate out of tolerance before searching below it", async () => {
    // The most played move loses a pawn.
    const book = fakeBook({ shares: [0.3, 0.6] });
    const engine = fakeEngine(losing);
    const { root } = await searchBestLine(params({ maxPlies: 3 }), {
        explore: book.explore,
        analyze: engine.analyze,
    });

    const [best, bad] = legalSans(INITIAL_FEN, 2);
    expect(root.edges?.find((e) => e.san === bad)?.status).toBe("outOfTolerance");
    expect(root.edges?.find((e) => e.status === "chosen")?.san).toBe(best);
    expect(book.explored).not.toContain(playSan(INITIAL_FEN, bad)?.fen);
});

test("searchBestLine plays the engine's best move when no candidate has enough games", async () => {
    const book = fakeBook({ shares: [0.0001, 0.0001] });
    const engine = fakeEngine([30, 20]);
    const { root } = await searchBestLine(params({ maxPlies: 1 }), {
        explore: book.explore,
        analyze: engine.analyze,
    });

    const chosen = root.edges?.find((e) => e.status === "chosen");
    expect(chosen?.san).toBe(legalSans(INITIAL_FEN, 1)[0]);
    expect(chosen?.decidedBy).toBe("engineChoice");
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

test("searchBestLine searches on below the candidate that replaces a rejected one", async () => {
    // The most played move is rejected by the engine: the line goes on below the other.
    const book = fakeBook({ shares: [0.3, 0.6] });
    const engine = fakeEngine([30, 25], { precise: losing });
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

test("searchBestLine starts from the reach of the position it continues", async () => {
    const book = fakeBook({ shares: [0.6, 0.3] });
    const search = (reach?: number) =>
        searchBestLine(params({ maxPlies: 4, minReach: 0.2, reach }), {
            explore: book.explore,
            analyze: fakeEngine().analyze,
        });

    const whole = await search();
    const rare = await search(0.1);

    expect(rare.root.reach).toBe(0.1);
    expect(rare.stats.expanded).toBeLessThan(whole.stats.expanded);
});
