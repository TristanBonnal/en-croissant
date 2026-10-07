import { INITIAL_FEN } from "chessops/fen";
import { expect, test } from "vitest";
import type { BestMoves } from "@/bindings";
import {
    admissibleMoves,
    type BestLineNode,
    type BestLineParams,
    type ExplorerMove,
    type ExplorerPosition,
    fenAfter,
    findBestLine,
    isTrap,
    lineComment,
    mainLine,
    mistakeAnnotation,
    moveScore,
    nodeAt,
    opponentMovesTo,
    replaceNodeAt,
    sansAlong,
    sansTo,
    selectOpponentReplies,
    selectStudiedMove,
    subtreeHeight,
    wilsonLowerBound,
    withRateLimitRetry,
} from "../bestLine";

function line(san: string, uci: string, cp: number, multipv = 1): BestMoves {
    return {
        depth: 18,
        multipv,
        nodes: 0,
        nps: 0,
        score: { value: { type: "cp", value: cp }, wdl: null },
        sanMoves: [san],
        uciMoves: [uci],
    };
}

function mateLine(san: string, uci: string, mate: number): BestMoves {
    return { ...line(san, uci, 0), score: { value: { type: "mate", value: mate }, wdl: null } };
}

function move(san: string, uci: string, white: number, draws: number, black: number): ExplorerMove {
    return { san, uci, white, draws, black };
}

function position(moves: ExplorerMove[]): ExplorerPosition {
    return {
        white: moves.reduce((acc, m) => acc + m.white, 0),
        draws: moves.reduce((acc, m) => acc + m.draws, 0),
        black: moves.reduce((acc, m) => acc + m.black, 0),
        moves,
    };
}

const pawns = (value: number) => ({ mode: "pawns" as const, value });
const winChance = (value: number) => ({ mode: "winChance" as const, value });

const whiteLines = [
    line("e4", "e2e4", 80, 1),
    line("d4", "d2d4", 60, 2),
    line("Nf3", "g1f3", 30, 3),
    line("c4", "c2c4", 10, 4),
    line("g3", "g2g3", 0, 5),
];

const rawOptions = { tolerance: pawns(0.3), ranking: "raw" as const, minGamesPerMove: 1 };

// --- stats -----------------------------------------------------------------

test("moveScore counts draws as half points for white", () => {
    expect(moveScore(move("e4", "e2e4", 55, 10, 35), "white")).toBeCloseTo(0.6);
});

test("moveScore uses black wins for black", () => {
    expect(moveScore(move("e5", "e7e5", 35, 10, 55), "black")).toBeCloseTo(0.6);
});

test("moveScore of a move without games is 0", () => {
    expect(moveScore(move("e4", "e2e4", 0, 0, 0), "white")).toBe(0);
});

test("wilsonLowerBound lowers the score of small samples", () => {
    expect(wilsonLowerBound(0.6, 100)).toBeCloseTo(0.502, 3);
    expect(wilsonLowerBound(0.6, 1_000_000)).toBeCloseTo(0.599, 3);
});

test("wilsonLowerBound of a move without games is 0", () => {
    expect(wilsonLowerBound(0.6, 0)).toBe(0);
});

// --- tolerance ---------------------------------------------------------------

test("admissibleMoves keeps moves within the pawn tolerance of the best move (white)", () => {
    expect(admissibleMoves(whiteLines, "white", pawns(0.3)).map((l) => l.sanMoves[0])).toEqual([
        "e4",
        "d4",
    ]);
});

test("admissibleMoves compares from black's point of view", () => {
    // White POV scores: black's best move is the most negative one.
    const blackLines = [
        line("c5", "c7c5", -50, 1),
        line("e5", "e7e5", -30, 2),
        line("e6", "e7e6", 0, 3),
    ];
    expect(admissibleMoves(blackLines, "black", pawns(0.3)).map((l) => l.sanMoves[0])).toEqual([
        "c5",
        "e5",
    ]);
});

test("admissibleMoves always keeps the best move, even with a zero tolerance", () => {
    expect(admissibleMoves(whiteLines, "white", pawns(0)).map((l) => l.sanMoves[0])).toEqual([
        "e4",
    ]);
});

test("admissibleMoves treats a mate as the best evaluation", () => {
    const lines = [mateLine("Qh5#", "d1h5", 1), line("e4", "e2e4", 900, 2)];
    expect(admissibleMoves(lines, "white", pawns(0.3)).map((l) => l.sanMoves[0])).toEqual(["Qh5#"]);
});

test("admissibleMoves supports a tolerance in win chance points", () => {
    // Win chances: +0.80 -> 57.3%, +0.60 -> 55.5%, +0.30 -> 52.8%
    expect(admissibleMoves(whiteLines, "white", winChance(3)).map((l) => l.sanMoves[0])).toEqual([
        "e4",
        "d4",
    ]);
    expect(admissibleMoves(whiteLines, "white", winChance(5)).map((l) => l.sanMoves[0])).toEqual([
        "e4",
        "d4",
        "Nf3",
    ]);
});

test("a win chance tolerance accepts bigger pawn losses in decided positions", () => {
    // +3.00 -> 75.1%, +2.60 -> 72.3%: 0.40 pawn but less than 3 win chance points
    const lines = [line("Qd2", "d1d2", 300, 1), line("Qe2", "d1e2", 260, 2)];
    expect(admissibleMoves(lines, "white", winChance(3))).toHaveLength(2);
    expect(admissibleMoves(lines, "white", pawns(0.3))).toHaveLength(1);
});

// --- studied side ---------------------------------------------------------------

test("selectStudiedMove picks the best score among admissible moves", () => {
    const stats = [move("e4", "e2e4", 50, 10, 40), move("d4", "d2d4", 55, 10, 35)];
    const { choice } = selectStudiedMove(whiteLines, position(stats), "white", rawOptions);
    expect(choice.san).toBe("d4");
    expect(choice.reason).toBe("stats");
    expect(choice.stats).toEqual({ score: 0.6, games: 100, share: 0.5 });
});

test("selectStudiedMove ignores moves outside the tolerance even with better stats", () => {
    const stats = [move("e4", "e2e4", 50, 0, 50), move("Nf3", "g1f3", 90, 0, 10)];
    const { choice } = selectStudiedMove(whiteLines, position(stats), "white", rawOptions);
    expect(choice.san).toBe("e4");
});

test("selectStudiedMove prefers more games when raw scores are within 1%", () => {
    // e4: 57.0% on 5 000 games, d4: 56.3% on 20 000 games -> d4
    const stats = [move("e4", "e2e4", 2850, 0, 2150), move("d4", "d2d4", 11260, 0, 8740)];
    const { choice } = selectStudiedMove(whiteLines, position(stats), "white", rawOptions);
    expect(choice.san).toBe("d4");
});

test("selectStudiedMove prefers the better raw score when the gap is above 1%", () => {
    // e4: 58.0% on 5 000 games, d4: 56.3% on 20 000 games -> e4
    const stats = [move("e4", "e2e4", 2900, 0, 2100), move("d4", "d2d4", 11260, 0, 8740)];
    const { choice } = selectStudiedMove(whiteLines, position(stats), "white", rawOptions);
    expect(choice.san).toBe("e4");
});

test("selectStudiedMove with the Wilson ranking prefers a reliable score", () => {
    // e4: 60% on 200 games, d4: 58% on 50 000 games
    const stats = [move("e4", "e2e4", 120, 0, 80), move("d4", "d2d4", 29000, 0, 21000)];
    expect(selectStudiedMove(whiteLines, position(stats), "white", rawOptions).choice.san).toBe(
        "e4",
    );
    expect(
        selectStudiedMove(whiteLines, position(stats), "white", {
            ...rawOptions,
            ranking: "wilson",
        }).choice.san,
    ).toBe("d4");
});

test("selectStudiedMove ignores candidates below the per-move minimum of games", () => {
    const stats = [move("e4", "e2e4", 500, 0, 500), move("d4", "d2d4", 3, 0, 0)];
    const { choice } = selectStudiedMove(whiteLines, position(stats), "white", {
        ...rawOptions,
        minGamesPerMove: 100,
    });
    expect(choice.san).toBe("e4");
    expect(choice.reason).toBe("stats");
});

test("selectStudiedMove falls back to the engine best move without enough games", () => {
    const stats = [move("d4", "d2d4", 3, 0, 0)];
    const { choice } = selectStudiedMove(whiteLines, position(stats), "white", {
        ...rawOptions,
        minGamesPerMove: 100,
    });
    expect(choice.san).toBe("e4");
    expect(choice.reason).toBe("engine");
    expect(choice.score).toEqual(whiteLines[0].score);
});

test("selectStudiedMove matches moves by SAN regardless of check marks", () => {
    const lines = [line("Bb5+", "f1b5", 50, 1)];
    const { choice } = selectStudiedMove(
        lines,
        position([move("Bb5", "f1b5", 60, 0, 40)]),
        "white",
        rawOptions,
    );
    expect(choice.reason).toBe("stats");
});

test("selectStudiedMove lists every engine candidate with its status", () => {
    const stats = [
        move("e4", "e2e4", 500, 100, 400),
        move("d4", "d2d4", 3, 0, 0),
        move("Nf3", "g1f3", 900, 0, 100),
    ];
    const { candidates } = selectStudiedMove(whiteLines, position(stats), "white", {
        ...rawOptions,
        minGamesPerMove: 100,
    });
    expect(candidates.map((c) => [c.san, c.status])).toEqual([
        ["e4", "chosen"],
        ["d4", "fewGames"],
        ["Nf3", "outOfTolerance"],
        ["c4", "outOfTolerance"],
        ["g3", "outOfTolerance"],
    ]);
    expect(candidates[0].score).toEqual(whiteLines[0].score);
    expect(candidates[2].stats?.games).toBe(1000);
});

test("selectStudiedMove marks admissible moves with a lower score", () => {
    const stats = [move("e4", "e2e4", 50, 10, 40), move("d4", "d2d4", 55, 10, 35)];
    const { candidates } = selectStudiedMove(whiteLines, position(stats), "white", rawOptions);
    expect(candidates.slice(0, 2).map((c) => [c.san, c.status])).toEqual([
        ["e4", "lowerScore"],
        ["d4", "chosen"],
    ]);
});

// --- opponent ----------------------------------------------------------------

const replies = position([
    move("d5", "d7d5", 6000, 3000, 6000),
    move("Nf6", "g8f6", 4000, 2000, 4000),
    move("e5", "e7e5", 1000, 1000, 1000),
    move("c5", "c7c5", 1000, 0, 1000),
]);

test("selectOpponentReplies picks the most played move in line mode", () => {
    const { replies: chosen } = selectOpponentReplies(replies, "black", 5000, {
        minShare: 0.15,
        maxReplies: 1,
    });
    expect(chosen.map((r) => r.san)).toEqual(["d5"]);
    expect(chosen[0].reason).toBe("popular");
    expect(chosen[0].stats?.games).toBe(15000);
    expect(chosen[0].stats?.share).toBe(0.5);
});

test("selectOpponentReplies branches on replies above the share threshold", () => {
    const { replies: chosen } = selectOpponentReplies(replies, "black", 5000, {
        minShare: 0.15,
        maxReplies: 3,
    });
    expect(chosen.map((r) => r.san)).toEqual(["d5", "Nf6"]);
});

test("selectOpponentReplies keeps at most maxReplies replies", () => {
    const { replies: chosen } = selectOpponentReplies(replies, "black", 5000, {
        minShare: 0,
        maxReplies: 3,
    });
    expect(chosen.map((r) => r.san)).toEqual(["d5", "Nf6", "e5"]);
});

test("selectOpponentReplies lists the other replies as candidates", () => {
    const { candidates } = selectOpponentReplies(replies, "black", 5000, {
        minShare: 0.15,
        maxReplies: 3,
    });
    expect(candidates.map((c) => [c.san, c.status])).toEqual([
        ["d5", "chosen"],
        ["Nf6", "chosen"],
        ["e5", "other"],
        ["c5", "other"],
    ]);
});

test("selectOpponentReplies returns nothing when the position has too few games", () => {
    const pos = position([move("d5", "d7d5", 1000, 0, 1000)]);
    expect(
        selectOpponentReplies(pos, "black", 5000, { minShare: 0, maxReplies: 1 }).replies,
    ).toEqual([]);
});

test("selectOpponentReplies returns nothing when no move is known", () => {
    expect(
        selectOpponentReplies(position([]), "black", 0, { minShare: 0, maxReplies: 1 }).replies,
    ).toEqual([]);
});

// --- search ------------------------------------------------------------------

function fakeDeps(
    analyses: Record<string, BestMoves[]>,
    explorer: Record<string, ExplorerPosition>,
) {
    const analyzed: string[] = [];
    const explored: string[] = [];
    let positions = 0;
    return {
        analyzed,
        explored,
        positions: () => positions,
        deps: {
            analyze: async (fen: string) => {
                analyzed.push(fen);
                return analyses[fen] ?? [];
            },
            explore: async (fen: string) => {
                explored.push(fen);
                return explorer[fen] ?? position([]);
            },
            onPosition: () => {
                positions++;
            },
        },
    };
}

const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const AFTER_D4 = "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1";
const AFTER_E4_E5 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
const AFTER_E4_C5 = "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";

function params(overrides: Partial<BestLineParams>): BestLineParams {
    return {
        fen: INITIAL_FEN,
        color: "white",
        plies: 2,
        tolerance: pawns(0.3),
        ranking: "raw",
        minimumGames: 5000,
        minGamesPerMove: 100,
        branching: { minShare: 0.15, maxReplies: 1, maxDepth: 1 },
        ...overrides,
    };
}

const sans = (nodes: BestLineNode[]) => mainLine(nodes).map((n) => n.san);

test("findBestLine plays the studied side and the opponent in turn", async () => {
    const { deps, analyzed } = fakeDeps(
        {
            [INITIAL_FEN]: [line("e4", "e2e4", 30, 1), line("d4", "d2d4", 25, 2)],
        },
        {
            [INITIAL_FEN]: position([
                move("e4", "e2e4", 500, 100, 400),
                move("d4", "d2d4", 520, 100, 380),
            ]),
        },
    );
    const nodes = await findBestLine(params({ plies: 1 }), deps);
    expect(sans(nodes)).toEqual(["d4"]);
    expect(nodes[0].color).toBe("white");
    expect(nodes[0].fen).toBe(INITIAL_FEN);
    expect(analyzed[0]).toBe(INITIAL_FEN);
});

test("findBestLine skips the engine for popular replies and evaluates them afterwards", async () => {
    const { deps, analyzed } = fakeDeps(
        {
            [INITIAL_FEN]: [line("e4", "e2e4", 30, 1)],
            [AFTER_E4_E5]: [line("Nf3", "g1f3", 40, 1)],
        },
        {
            [INITIAL_FEN]: position([move("e4", "e2e4", 500, 100, 400)]),
            [AFTER_E4]: position([
                move("e5", "e7e5", 3000, 1000, 3000),
                move("c5", "c7c5", 1000, 500, 1000),
            ]),
        },
    );
    const nodes = await findBestLine(params({ plies: 4 }), deps);
    const line3 = mainLine(nodes);
    expect(line3.map((s) => s.san)).toEqual(["e4", "e5", "Nf3"]);
    expect(line3.map((s) => s.reason)).toEqual(["stats", "popular", "engine"]);
    expect(line3[1].score).toEqual(line("Nf3", "g1f3", 40).score);
    expect(analyzed).not.toContain(AFTER_E4);
});

test("findBestLine evaluates the final position when the line ends with a popular reply", async () => {
    const { deps, analyzed } = fakeDeps(
        {
            [INITIAL_FEN]: [line("e4", "e2e4", 30, 1)],
            [AFTER_E4_E5]: [line("Nf3", "g1f3", 40, 1), line("Bc4", "f1c4", 20, 2)],
        },
        {
            [INITIAL_FEN]: position([move("e4", "e2e4", 500, 100, 400)]),
            [AFTER_E4]: position([move("e5", "e7e5", 3000, 1000, 3000)]),
        },
    );
    const nodes = await findBestLine(params({ plies: 2 }), deps);
    const moves = mainLine(nodes);
    expect(moves.map((s) => s.san)).toEqual(["e4", "e5"]);
    expect(moves[1].score).toEqual(line("Nf3", "g1f3", 40).score);
    expect(analyzed).toEqual([INITIAL_FEN, AFTER_E4_E5]);
});

test("findBestLine falls back to the engine for the opponent with too few games", async () => {
    const { deps } = fakeDeps(
        { [AFTER_E4]: [line("c5", "c7c5", -10, 1)] },
        {
            [AFTER_E4]: position([move("e5", "e7e5", 100, 0, 100), move("c5", "c7c5", 50, 0, 50)]),
        },
    );
    const nodes = await findBestLine(params({ fen: AFTER_E4, plies: 1 }), deps);
    expect(nodes[0].san).toBe("c5");
    expect(nodes[0].color).toBe("black");
    expect(nodes[0].reason).toBe("engine");
    expect(nodes[0].stats).toEqual({ score: 0.5, games: 100, share: 1 / 3 });
});

test("findBestLine branches on frequent opponent replies in tree mode", async () => {
    const { deps } = fakeDeps(
        {
            [INITIAL_FEN]: [line("e4", "e2e4", 30, 1)],
            [AFTER_E4_E5]: [line("Nf3", "g1f3", 40, 1)],
            [AFTER_E4_C5]: [line("Nf3", "g1f3", 35, 1)],
        },
        {
            [INITIAL_FEN]: position([move("e4", "e2e4", 500, 100, 400)]),
            [AFTER_E4]: position([
                move("e5", "e7e5", 3000, 1000, 3000),
                move("c5", "c7c5", 2000, 1000, 2000),
                move("e6", "e7e6", 100, 0, 100),
            ]),
        },
    );
    const nodes = await findBestLine(
        params({ plies: 3, branching: { minShare: 0.15, maxReplies: 3, maxDepth: 1 } }),
        deps,
    );
    expect(nodes.map((n) => n.san)).toEqual(["e4"]);
    expect(nodes[0].children.map((n) => n.san)).toEqual(["e5", "c5"]);
    expect(nodes[0].children.map((n) => n.children.map((c) => c.san))).toEqual([["Nf3"], ["Nf3"]]);
    expect(nodes[0].children[1].score).toEqual(line("Nf3", "g1f3", 35).score);
});

test("findBestLine counts plies from a black-to-move start", async () => {
    const { deps } = fakeDeps(
        {
            [AFTER_E4]: [line("c5", "c7c5", -10, 1)],
            [AFTER_E4_C5]: [line("Nf3", "g1f3", 20, 1)],
        },
        {},
    );
    const nodes = await findBestLine(params({ fen: AFTER_E4, color: "black", plies: 2 }), deps);
    expect(sans(nodes)).toEqual(["c5", "Nf3"]);
});

test("findBestLine plays a forced first move and continues", async () => {
    const { deps } = fakeDeps(
        {
            [INITIAL_FEN]: [line("e4", "e2e4", 30, 1), line("d4", "d2d4", 25, 2)],
        },
        {
            [INITIAL_FEN]: position([
                move("e4", "e2e4", 500, 100, 400),
                move("d4", "d2d4", 400, 100, 500),
            ]),
            [AFTER_D4]: position([move("d5", "d7d5", 6000, 1000, 6000)]),
        },
    );
    const nodes = await findBestLine(params({ forcedMove: "d4" }), deps);
    expect(sans(nodes)).toEqual(["d4", "d5"]);
    expect(nodes[0].reason).toBe("manual");
    expect(nodes[0].score).toEqual(line("d4", "d2d4", 25, 2).score);
    expect(nodes[0].stats?.games).toBe(1000);
});

test("findBestLine records the candidates of each move", async () => {
    const { deps } = fakeDeps(
        { [INITIAL_FEN]: [line("e4", "e2e4", 30, 1), line("d4", "d2d4", 25, 2)] },
        {},
    );
    const nodes = await findBestLine(params({ plies: 1 }), deps);
    expect(nodes[0].candidates.map((c) => [c.san, c.status])).toEqual([
        ["e4", "chosen"],
        ["d4", "fewGames"],
    ]);
});

test("findBestLine stops when the game is over", async () => {
    const mated = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3";
    const { deps, analyzed } = fakeDeps({}, {});
    const nodes = await findBestLine(params({ fen: mated, plies: 6 }), deps);
    expect(nodes).toEqual([]);
    expect(analyzed).toEqual([]);
});

test("findBestLine stops when no move can be found", async () => {
    const { deps } = fakeDeps({}, {});
    expect(await findBestLine(params({ plies: 6 }), deps)).toEqual([]);
});

test("findBestLine reports each position and returns the partial line when cancelled", async () => {
    let cancelled = false;
    const { deps, positions } = fakeDeps(
        {
            [INITIAL_FEN]: [line("e4", "e2e4", 30, 1)],
            [AFTER_E4]: [line("e5", "e7e5", -30, 1)],
        },
        {},
    );
    const nodes = await findBestLine(params({ plies: 6 }), {
        ...deps,
        isCancelled: () => cancelled,
        onPosition: () => {
            deps.onPosition();
            cancelled = true;
        },
    });
    expect(sans(nodes)).toEqual(["e4"]);
    expect(positions()).toBe(1);
});

test("findBestLine returns the partial line when a dependency fails after cancellation", async () => {
    let cancelled = false;
    const nodes = await findBestLine(params({}), {
        analyze: async () => {
            cancelled = true;
            throw new Error("Analysis cancelled");
        },
        explore: async () => position([]),
        isCancelled: () => cancelled,
    });
    expect(nodes).toEqual([]);
});

test("findBestLine rethrows dependency errors when not cancelled", async () => {
    await expect(
        findBestLine(params({}), {
            analyze: async () => [line("e4", "e2e4", 30)],
            explore: async () => {
                throw new Error("500 Internal Server Error");
            },
        }),
    ).rejects.toThrow("500");
});

test("mainLine follows the first child of each node", () => {
    const leaf = (san: string): BestLineNode => ({
        san,
        uci: "",
        color: "white",
        fen: "",
        reason: "engine",
        candidates: [],
        children: [],
    });
    const tree = [{ ...leaf("e4"), children: [leaf("e5"), leaf("c5")] }, leaf("d4")];
    expect(mainLine(tree).map((n) => n.san)).toEqual(["e4", "e5"]);
});

// --- rate limit --------------------------------------------------------------

class RateLimited extends Error {}

const noWait = {
    isRateLimited: (e: unknown) => e instanceof RateLimited,
    sleep: async () => {},
};

test("withRateLimitRetry retries a rate-limited call after waiting", async () => {
    let calls = 0;
    const waits: number[] = [];
    const result = await withRateLimitRetry(
        async () => {
            calls++;
            if (calls < 3) throw new RateLimited();
            return "ok";
        },
        { ...noWait, delayMs: 60000, onWait: (ms) => waits.push(ms) },
    );
    expect(result).toBe("ok");
    expect(waits).toEqual([60000, 60000]);
});

test("withRateLimitRetry gives up after the last retry", async () => {
    let calls = 0;
    await expect(
        withRateLimitRetry(
            async () => {
                calls++;
                throw new RateLimited("429");
            },
            { ...noWait, retries: 2 },
        ),
    ).rejects.toThrow("429");
    expect(calls).toBe(3);
});

test("withRateLimitRetry does not retry other errors", async () => {
    let calls = 0;
    await expect(
        withRateLimitRetry(async () => {
            calls++;
            throw new Error("500");
        }, noWait),
    ).rejects.toThrow("500");
    expect(calls).toBe(1);
});

test("withRateLimitRetry stops retrying once cancelled", async () => {
    let calls = 0;
    await expect(
        withRateLimitRetry(
            async () => {
                calls++;
                throw new RateLimited("429");
            },
            { ...noWait, isCancelled: () => true },
        ),
    ).rejects.toThrow("429");
    expect(calls).toBe(1);
});

// --- comments ----------------------------------------------------------------

function node(partial: Partial<BestLineNode>): BestLineNode {
    return {
        san: "e4",
        uci: "e2e4",
        color: "white",
        fen: INITIAL_FEN,
        reason: "stats",
        candidates: [],
        children: [],
        ...partial,
    };
}

const cp = (value: number) => ({ value: { type: "cp" as const, value }, wdl: null });
const labels = {
    winrate: (score: string) => `${score} winrate`,
    played: (share: string, games: number) => `${share} played · ${games} games`,
    engine: (evaluation: string) => `${evaluation} engine move`,
};

test("lineComment shows the score in green for a studied move chosen by its stats", () => {
    expect(
        lineComment(
            node({
                reason: "stats",
                score: cp(60),
                stats: { score: 0.578, games: 10, share: 0.4 },
            }),
            "white",
            labels,
        ),
    ).toEqual({ text: "57.8% winrate", color: "green" });
});

test("lineComment shows the evaluation in blue for a studied engine move", () => {
    expect(
        lineComment(
            node({ reason: "engine", score: cp(45), stats: { score: 0.5, games: 3, share: 0.1 } }),
            "white",
            labels,
        ),
    ).toEqual({ text: "+0.45 engine move", color: "blue" });
});

test("lineComment shows how often the opponent's popular move was played", () => {
    expect(
        lineComment(
            node({
                color: "black",
                reason: "popular",
                score: cp(30),
                stats: { score: 0.45, games: 12345, share: 0.452 },
            }),
            "white",
            labels,
        ),
    ).toEqual({ text: "45.2% played · 12345 games" });
});

test("lineComment shows the evaluation without color for an opponent engine move", () => {
    expect(
        lineComment(node({ color: "black", reason: "engine", score: cp(-30) }), "white", labels),
    ).toEqual({
        text: "-0.30 engine move",
    });
});

test("lineComment describes a manually chosen move by its stats, without color", () => {
    const stats = { score: 0.52, games: 800, share: 0.2 };
    expect(lineComment(node({ reason: "manual", stats }), "white", labels)).toEqual({
        text: "52.0% winrate",
    });
    expect(lineComment(node({ color: "black", reason: "manual", stats }), "white", labels)).toEqual(
        {
            text: "20.0% played · 800 games",
        },
    );
    expect(lineComment(node({ reason: "manual", score: cp(10) }), "white", labels)).toEqual({
        text: "+0.10",
    });
});

test("lineComment is empty when nothing is known", () => {
    expect(lineComment(node({ reason: "engine" }), "white", labels)).toEqual({ text: "" });
});

// --- result tree helpers -----------------------------------------------------

const leaf = (san: string, children: BestLineNode[] = []): BestLineNode => ({
    san,
    uci: "",
    color: "white",
    fen: INITIAL_FEN,
    reason: "engine",
    candidates: [],
    children,
});

const forest = () => [leaf("e4", [leaf("e5", [leaf("Nf3")]), leaf("c5")])];

test("nodeAt returns the node at a path", () => {
    expect(nodeAt(forest(), [0, 1])?.san).toBe("c5");
    expect(nodeAt(forest(), [0, 5])).toBeUndefined();
});

test("replaceNodeAt replaces a node without changing the original tree", () => {
    const original = forest();
    const replaced = replaceNodeAt(original, [0, 0], leaf("d6"));
    expect(replaced[0].children.map((n) => n.san)).toEqual(["d6", "c5"]);
    expect(original[0].children.map((n) => n.san)).toEqual(["e5", "c5"]);
});

test("subtreeHeight counts the plies of the deepest branch", () => {
    expect(subtreeHeight(forest()[0])).toBe(3);
    expect(subtreeHeight(leaf("c5"))).toBe(1);
});

test("sansTo lists the moves from the root to a node and down its main line", () => {
    expect(sansTo(forest(), [0, 0])).toEqual(["e4", "e5", "Nf3"]);
    expect(sansTo(forest(), [0, 1])).toEqual(["e4", "c5"]);
});

test("fenAfter plays the node's move", () => {
    expect(fenAfter(leaf("e4"))).toBe(AFTER_E4);
});

const AFTER_E4_E5_NF3 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2";

function branchingDeps() {
    return fakeDeps(
        {
            [INITIAL_FEN]: [line("e4", "e2e4", 30, 1)],
            [AFTER_E4_E5]: [line("Nf3", "g1f3", 40, 1)],
            [AFTER_E4_C5]: [line("Nf3", "g1f3", 35, 1)],
        },
        {
            [INITIAL_FEN]: position([move("e4", "e2e4", 500, 100, 400)]),
            [AFTER_E4]: position([
                move("e5", "e7e5", 3000, 1000, 3000),
                move("c5", "c7c5", 2000, 1000, 2000),
            ]),
            [AFTER_E4_E5_NF3]: position([
                move("Nc6", "b8c6", 3000, 1000, 3000),
                move("d6", "d7d6", 2000, 1000, 2000),
            ]),
        },
    );
}

test("findBestLine only branches on the first opponent moves up to the branching depth", async () => {
    const { deps } = branchingDeps();
    const nodes = await findBestLine(
        params({ plies: 4, branching: { minShare: 0.15, maxReplies: 3, maxDepth: 1 } }),
        deps,
    );
    expect(nodes[0].children.map((n) => n.san)).toEqual(["e5", "c5"]);
    const nf3 = nodes[0].children[0].children[0];
    expect(nf3.children.map((n) => n.san)).toEqual(["Nc6"]);
});

test("findBestLine branches again below the first opponent move with a deeper branching", async () => {
    const { deps } = branchingDeps();
    const nodes = await findBestLine(
        params({ plies: 4, branching: { minShare: 0.15, maxReplies: 3, maxDepth: 2 } }),
        deps,
    );
    const nf3 = nodes[0].children[0].children[0];
    expect(nf3.children.map((n) => n.san)).toEqual(["Nc6", "d6"]);
});

test("findBestLine does not branch with a branching depth of 0", async () => {
    const { deps } = branchingDeps();
    const nodes = await findBestLine(
        params({ plies: 2, branching: { minShare: 0.15, maxReplies: 3, maxDepth: 0 } }),
        deps,
    );
    expect(nodes[0].children.map((n) => n.san)).toEqual(["e5"]);
});

test("opponentMovesTo counts the opponent moves before a node", () => {
    const tree = [
        {
            ...leaf("e4"),
            children: [{ ...leaf("e5"), color: "black" as const, children: [leaf("Nf3")] }],
        },
    ];
    expect(opponentMovesTo(tree, [0, 0, 0], "white")).toBe(1);
    expect(opponentMovesTo(tree, [0, 0], "white")).toBe(0);
    expect(opponentMovesTo(tree, [0, 0], "white", true)).toBe(1);
});

test("sansAlong lists the moves from the first position to a node", () => {
    expect(sansAlong(forest(), [0, 0, 0])).toEqual(["e4", "e5", "Nf3"]);
    expect(sansAlong(forest(), [0, 1])).toEqual(["e4", "c5"]);
});

// --- traps -------------------------------------------------------------------

test("mistakeAnnotation grades the win chance lost by a move", () => {
    // From black's point of view: -0.30 -> -3.00 loses about 22 win chance points
    expect(mistakeAnnotation(cp(30), cp(300), "black")).toBe("??");
    expect(mistakeAnnotation(cp(30), cp(170), "black")).toBe("?");
    expect(mistakeAnnotation(cp(30), cp(100), "black")).toBe("?!");
    expect(mistakeAnnotation(cp(30), cp(40), "black")).toBeUndefined();
    expect(mistakeAnnotation(cp(-30), cp(-300), "white")).toBe("??");
});

test("isTrap only keeps real mistakes", () => {
    expect(isTrap(leaf("e5"))).toBe(false);
    expect(isTrap({ ...leaf("e5"), annotation: "?!" })).toBe(false);
    expect(isTrap({ ...leaf("e5"), annotation: "?" })).toBe(true);
    expect(isTrap({ ...leaf("e5"), annotation: "??" })).toBe(true);
});

test("findBestLine annotates a popular opponent mistake", async () => {
    const { deps } = fakeDeps(
        {
            [INITIAL_FEN]: [line("e4", "e2e4", 30, 1)],
            [AFTER_E4_E5]: [line("Nf3", "g1f3", 300, 1)],
        },
        {
            [INITIAL_FEN]: position([move("e4", "e2e4", 500, 100, 400)]),
            [AFTER_E4]: position([move("e5", "e7e5", 3000, 1000, 3000)]),
        },
    );
    const nodes = await findBestLine(params({ plies: 3 }), deps);
    const e5 = nodes[0].children[0];
    expect(e5.annotation).toBe("??");
    expect(nodes[0].annotation).toBeUndefined();
});

test("findBestLine evaluates the start position to judge a first opponent move", async () => {
    const { deps } = fakeDeps(
        {
            [AFTER_E4]: [line("c5", "c7c5", 30, 1)],
            [AFTER_E4_E5]: [line("Nf3", "g1f3", 300, 1)],
        },
        { [AFTER_E4]: position([move("e5", "e7e5", 3000, 1000, 3000)]) },
    );
    const nodes = await findBestLine(params({ fen: AFTER_E4, plies: 1 }), deps);
    expect(nodes[0].annotation).toBe("??");
});

test("findBestLine branches on frequent opponent mistakes below the branching share", async () => {
    const { deps } = fakeDeps(
        {
            [INITIAL_FEN]: [line("e4", "e2e4", 30, 1)],
            [AFTER_E4_E5]: [line("Nf3", "g1f3", 40, 1)],
            [AFTER_E4_C5]: [line("Nf3", "g1f3", 300, 1)],
        },
        {
            [INITIAL_FEN]: position([move("e4", "e2e4", 500, 100, 400)]),
            [AFTER_E4]: position([
                move("e5", "e7e5", 3000, 1000, 3000),
                move("c5", "c7c5", 1000, 0, 1000),
                move("e6", "e7e6", 100, 0, 100),
            ]),
        },
    );
    const nodes = await findBestLine(
        params({
            plies: 2,
            branching: { minShare: 0.5, maxReplies: 3, maxDepth: 1, trapMinShare: 0.05 },
        }),
        deps,
    );
    const replies = nodes[0].children;
    expect(replies.map((n) => [n.san, n.reason])).toEqual([
        ["e5", "popular"],
        ["c5", "trap"],
    ]);
    expect(replies[1].annotation).toBe("??");
    expect(replies[1].stats?.share).toBeCloseTo(2000 / 9200);
});

test("findBestLine does not look for trap branches without the option", async () => {
    const { deps, analyzed } = fakeDeps(
        {
            [INITIAL_FEN]: [line("e4", "e2e4", 30, 1)],
            [AFTER_E4_C5]: [line("Nf3", "g1f3", 300, 1)],
        },
        {
            [INITIAL_FEN]: position([move("e4", "e2e4", 500, 100, 400)]),
            [AFTER_E4]: position([
                move("e5", "e7e5", 3000, 1000, 3000),
                move("c5", "c7c5", 1000, 0, 1000),
            ]),
        },
    );
    const nodes = await findBestLine(
        params({ plies: 2, branching: { minShare: 0.5, maxReplies: 3, maxDepth: 1 } }),
        deps,
    );
    expect(nodes[0].children.map((n) => n.san)).toEqual(["e5"]);
    expect(analyzed).not.toContain(AFTER_E4_C5);
});

test("lineComment describes a trap branch by how often it was played", () => {
    expect(
        lineComment(
            node({
                color: "black",
                reason: "trap",
                stats: { score: 0.3, games: 2000, share: 0.217 },
            }),
            "white",
            labels,
        ),
    ).toEqual({ text: "21.7% played · 2000 games" });
});
