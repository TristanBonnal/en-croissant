import { INITIAL_FEN } from "chessops/fen";
import { expect, test } from "vitest";
import type { BestMoves } from "@/bindings";
import {
    admissibleMoves,
    type BestLineStep,
    lineComment,
    type ExplorerMove,
    type ExplorerPosition,
    findBestLine,
    moveScore,
    selectOpponentMove,
    selectStudiedMove,
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

const whiteLines = [
    line("e4", "e2e4", 80, 1),
    line("d4", "d2d4", 60, 2),
    line("Nf3", "g1f3", 30, 3),
    line("c4", "c2c4", 10, 4),
    line("g3", "g2g3", 0, 5),
];

test("moveScore counts draws as half points for white", () => {
    expect(moveScore(move("e4", "e2e4", 55, 10, 35), "white")).toBeCloseTo(0.6);
});

test("moveScore uses black wins for black", () => {
    expect(moveScore(move("e5", "e7e5", 35, 10, 55), "black")).toBeCloseTo(0.6);
});

test("moveScore of a move without games is 0", () => {
    expect(moveScore(move("e4", "e2e4", 0, 0, 0), "white")).toBe(0);
});

test("admissibleMoves keeps moves within the tolerance of the best move (white)", () => {
    expect(admissibleMoves(whiteLines, "white", 0.3).map((l) => l.sanMoves[0])).toEqual([
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
    expect(admissibleMoves(blackLines, "black", 0.3).map((l) => l.sanMoves[0])).toEqual([
        "c5",
        "e5",
    ]);
});

test("admissibleMoves always keeps the best move, even with a zero tolerance", () => {
    expect(admissibleMoves(whiteLines, "white", 0).map((l) => l.sanMoves[0])).toEqual(["e4"]);
});

test("admissibleMoves treats a mate as the best evaluation", () => {
    const lines = [mateLine("Qh5#", "d1h5", 1), line("e4", "e2e4", 900, 2)];
    expect(admissibleMoves(lines, "white", 0.3).map((l) => l.sanMoves[0])).toEqual(["Qh5#"]);
});

test("selectStudiedMove picks the best score among admissible moves", () => {
    const stats = [move("e4", "e2e4", 50, 10, 40), move("d4", "d2d4", 55, 10, 35)];
    const result = selectStudiedMove(
        admissibleMoves(whiteLines, "white", 0.3),
        position(stats),
        "white",
        1,
    );
    expect(result.san).toBe("d4");
    expect(result.reason).toBe("stats");
    expect(result.stats).toEqual({ score: 0.6, games: 100, share: 0.5 });
});

test("selectStudiedMove ignores moves outside the tolerance even with better stats", () => {
    const stats = [move("e4", "e2e4", 50, 0, 50), move("Nf3", "g1f3", 90, 0, 10)];
    const result = selectStudiedMove(
        admissibleMoves(whiteLines, "white", 0.3),
        position(stats),
        "white",
        1,
    );
    expect(result.san).toBe("e4");
});

test("selectStudiedMove prefers more games when scores are within 1%", () => {
    // e4: 57.0% on 5 000 games, d4: 56.3% on 20 000 games -> d4
    const stats = [move("e4", "e2e4", 2850, 0, 2150), move("d4", "d2d4", 11260, 0, 8740)];
    const result = selectStudiedMove(
        admissibleMoves(whiteLines, "white", 0.3),
        position(stats),
        "white",
        1,
    );
    expect(result.san).toBe("d4");
});

test("selectStudiedMove prefers the better score when the gap is above 1%", () => {
    // e4: 58.0% on 5 000 games, d4: 56.3% on 20 000 games -> e4
    const stats = [move("e4", "e2e4", 2900, 0, 2100), move("d4", "d2d4", 11260, 0, 8740)];
    const result = selectStudiedMove(
        admissibleMoves(whiteLines, "white", 0.3),
        position(stats),
        "white",
        1,
    );
    expect(result.san).toBe("e4");
});

test("selectStudiedMove ignores candidates below the per-move minimum of games", () => {
    const stats = [move("e4", "e2e4", 500, 0, 500), move("d4", "d2d4", 3, 0, 0)];
    const result = selectStudiedMove(
        admissibleMoves(whiteLines, "white", 0.3),
        position(stats),
        "white",
        100,
    );
    expect(result.san).toBe("e4");
    expect(result.reason).toBe("stats");
});

test("selectStudiedMove falls back to the engine best move without enough games", () => {
    const stats = [move("d4", "d2d4", 3, 0, 0)];
    const result = selectStudiedMove(
        admissibleMoves(whiteLines, "white", 0.3),
        position(stats),
        "white",
        100,
    );
    expect(result.san).toBe("e4");
    expect(result.reason).toBe("engine");
    expect(result.score).toEqual(whiteLines[0].score);
});

test("selectStudiedMove matches moves by SAN regardless of check marks", () => {
    const lines = [line("Bb5+", "f1b5", 50, 1)];
    const result = selectStudiedMove(lines, position([move("Bb5", "f1b5", 60, 0, 40)]), "white", 1);
    expect(result.reason).toBe("stats");
});

test("selectOpponentMove picks the most played move", () => {
    const pos = position([
        move("Nf6", "g8f6", 4000, 2000, 4000),
        move("d5", "d7d5", 6000, 3000, 6000),
        move("e5", "e7e5", 2000, 1000, 2000),
    ]);
    const result = selectOpponentMove(pos, "black", 5000);
    expect(result?.san).toBe("d5");
    expect(result?.reason).toBe("popular");
    expect(result?.stats?.games).toBe(15000);
    expect(result?.stats?.share).toBe(0.5);
});

test("selectOpponentMove returns null when the position has too few games", () => {
    const pos = position([move("d5", "d7d5", 1000, 0, 1000)]);
    expect(selectOpponentMove(pos, "black", 5000)).toBeNull();
});

test("selectOpponentMove returns null when no move is known", () => {
    expect(selectOpponentMove(position([]), "black", 0)).toBeNull();
});

function fakeDeps(
    analyses: Record<string, BestMoves[]>,
    explorer: Record<string, ExplorerPosition>,
) {
    const analyzed: string[] = [];
    const explored: string[] = [];
    return {
        analyzed,
        explored,
        deps: {
            analyze: async (fen: string) => {
                analyzed.push(fen);
                return analyses[fen] ?? [];
            },
            explore: async (fen: string) => {
                explored.push(fen);
                return explorer[fen] ?? position([]);
            },
        },
    };
}

const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const AFTER_E4_E5 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
const AFTER_E4_C5 = "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";

test("findBestLine plays the studied side and the opponent in turn", async () => {
    const { deps, analyzed } = fakeDeps(
        {
            [INITIAL_FEN]: [line("e4", "e2e4", 30, 1), line("d4", "d2d4", 25, 2)],
            [AFTER_E4_E5]: [line("Nf3", "g1f3", 40, 1)],
        },
        {
            [INITIAL_FEN]: position([
                move("e4", "e2e4", 500, 100, 400),
                move("d4", "d2d4", 520, 100, 380),
            ]),
            [AFTER_E4]: position([
                move("e5", "e7e5", 3000, 1000, 3000),
                move("c5", "c7c5", 1000, 500, 1000),
            ]),
        },
    );
    const steps = await findBestLine(
        {
            fen: INITIAL_FEN,
            color: "white",
            fullMoves: 1,
            tolerance: 0.3,
            minimumGames: 5000,
            minGamesPerMove: 100,
        },
        deps,
    );
    expect(steps[0].san).toBe("d4");
    expect(steps[0].color).toBe("white");
    expect(analyzed[0]).toBe(INITIAL_FEN);
});

test("findBestLine plays 2 plies per full move and skips the engine for popular replies", async () => {
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
    const steps = await findBestLine(
        {
            fen: INITIAL_FEN,
            color: "white",
            fullMoves: 2,
            tolerance: 0.3,
            minimumGames: 5000,
            minGamesPerMove: 100,
        },
        deps,
    );
    expect(steps.map((s) => s.san)).toEqual(["e4", "e5", "Nf3"]);
    expect(steps.map((s) => s.reason)).toEqual(["stats", "popular", "engine"]);
    // The popular reply gets the evaluation of the next analysed position.
    expect(steps[1].score).toEqual(line("Nf3", "g1f3", 40).score);
    expect(analyzed).not.toContain(AFTER_E4);
});

test("findBestLine falls back to the engine for the opponent with too few games", async () => {
    const { deps } = fakeDeps(
        {
            [AFTER_E4]: [line("c5", "c7c5", -10, 1)],
        },
        {
            [AFTER_E4]: position([move("e5", "e7e5", 100, 0, 100)]),
        },
    );
    const steps = await findBestLine(
        {
            fen: AFTER_E4,
            color: "white",
            fullMoves: 1,
            tolerance: 0.3,
            minimumGames: 5000,
            minGamesPerMove: 100,
        },
        deps,
    );
    expect(steps[0].san).toBe("c5");
    expect(steps[0].color).toBe("black");
    expect(steps[0].reason).toBe("engine");
});

test("findBestLine counts full moves from a black-to-move start", async () => {
    const { deps } = fakeDeps(
        {
            [AFTER_E4]: [line("c5", "c7c5", -10, 1)],
            [AFTER_E4_C5]: [line("Nf3", "g1f3", 20, 1)],
        },
        {},
    );
    const steps = await findBestLine(
        {
            fen: AFTER_E4,
            color: "black",
            fullMoves: 1,
            tolerance: 0.3,
            minimumGames: 5000,
            minGamesPerMove: 100,
        },
        deps,
    );
    expect(steps.map((s) => s.san)).toEqual(["c5", "Nf3"]);
});

test("findBestLine stops when the game is over", async () => {
    const mated = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3";
    const { deps, analyzed } = fakeDeps({}, {});
    const steps = await findBestLine(
        {
            fen: mated,
            color: "white",
            fullMoves: 3,
            tolerance: 0.3,
            minimumGames: 5000,
            minGamesPerMove: 100,
        },
        deps,
    );
    expect(steps).toEqual([]);
    expect(analyzed).toEqual([]);
});

test("findBestLine stops when no move can be found", async () => {
    const { deps } = fakeDeps({}, {});
    const steps = await findBestLine(
        {
            fen: INITIAL_FEN,
            color: "white",
            fullMoves: 3,
            tolerance: 0.3,
            minimumGames: 5000,
            minGamesPerMove: 100,
        },
        deps,
    );
    expect(steps).toEqual([]);
});

test("findBestLine reports progress and returns the partial line when cancelled", async () => {
    let cancelled = false;
    const progress: [number, number][] = [];
    const { deps } = fakeDeps(
        {
            [INITIAL_FEN]: [line("e4", "e2e4", 30, 1)],
            [AFTER_E4]: [line("e5", "e7e5", -30, 1)],
        },
        {},
    );
    const steps = await findBestLine(
        {
            fen: INITIAL_FEN,
            color: "white",
            fullMoves: 3,
            tolerance: 0.3,
            minimumGames: 5000,
            minGamesPerMove: 100,
        },
        {
            ...deps,
            isCancelled: () => cancelled,
            onProgress: (done, total) => {
                progress.push([done, total]);
                cancelled = true;
            },
        },
    );
    expect(steps.map((s) => s.san)).toEqual(["e4"]);
    expect(progress).toEqual([[1, 6]]);
});

test("findBestLine returns the partial line when a dependency fails after cancellation", async () => {
    let cancelled = false;
    const steps = await findBestLine(
        {
            fen: INITIAL_FEN,
            color: "white",
            fullMoves: 1,
            tolerance: 0.3,
            minimumGames: 5000,
            minGamesPerMove: 100,
        },
        {
            analyze: async () => {
                cancelled = true;
                throw new Error("Analysis cancelled");
            },
            explore: async () => position([]),
            isCancelled: () => cancelled,
        },
    );
    expect(steps).toEqual([]);
});

test("findBestLine rethrows dependency errors when not cancelled", async () => {
    await expect(
        findBestLine(
            {
                fen: INITIAL_FEN,
                color: "white",
                fullMoves: 1,
                tolerance: 0.3,
                minimumGames: 5000,
                minGamesPerMove: 100,
            },
            {
                analyze: async () => [line("e4", "e2e4", 30)],
                explore: async () => {
                    throw new Error("429 Too Many Requests");
                },
            },
        ),
    ).rejects.toThrow("429");
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
    const steps = await findBestLine(
        {
            fen: INITIAL_FEN,
            color: "white",
            fullMoves: 1,
            tolerance: 0.3,
            minimumGames: 5000,
            minGamesPerMove: 100,
        },
        deps,
    );
    expect(steps.map((s) => s.san)).toEqual(["e4", "e5"]);
    expect(steps[1].score).toEqual(line("Nf3", "g1f3", 40).score);
    expect(analyzed).toEqual([INITIAL_FEN, AFTER_E4_E5]);
});

test("findBestLine keeps the explorer stats of an engine reply", async () => {
    const { deps } = fakeDeps(
        {
            [AFTER_E4]: [line("c5", "c7c5", -10, 1)],
        },
        {
            [AFTER_E4]: position([move("e5", "e7e5", 100, 0, 100), move("c5", "c7c5", 50, 0, 50)]),
        },
    );
    const steps = await findBestLine(
        {
            fen: AFTER_E4,
            color: "white",
            fullMoves: 1,
            tolerance: 0.3,
            minimumGames: 5000,
            minGamesPerMove: 100,
        },
        deps,
    );
    expect(steps[0].reason).toBe("engine");
    expect(steps[0].stats).toEqual({ score: 0.5, games: 100, share: 1 / 3 });
});

function step(partial: Partial<BestLineStep>): BestLineStep {
    return { san: "e4", uci: "e2e4", color: "white", reason: "stats", ...partial };
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
            step({
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
            step({ reason: "engine", score: cp(45), stats: { score: 0.5, games: 3, share: 0.1 } }),
            "white",
            labels,
        ),
    ).toEqual({ text: "+0.45 engine move", color: "blue" });
});

test("lineComment shows how often the opponent's popular move was played", () => {
    expect(
        lineComment(
            step({
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
        lineComment(step({ color: "black", reason: "engine", score: cp(-30) }), "white", labels),
    ).toEqual({ text: "-0.30 engine move" });
});

test("lineComment is empty when nothing is known", () => {
    expect(lineComment(step({ reason: "engine" }), "white", labels)).toEqual({ text: "" });
});
