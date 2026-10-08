import { INITIAL_FEN } from "chessops/fen";
import { expect, test } from "vitest";
import type { BestMoves } from "@/bindings";
import { createTreeStore } from "@/state/store/tree";
import {
    admissibleMoves,
    type BestLineNode,
    fenAfter,
    bestLineSettingsSchema,
    cloudLinesUsable,
    isTrap,
    isTrapMistake,
    lineComment,
    mainLine,
    mistakeAnnotation,
    movesTo,
    resultPathOf,
    sansBetween,
    nodeAt,
    opponentMovesTo,
    replaceNodeAt,
    sansAlong,
    sansTo,
    subtreeHeight,
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

const pawns = (value: number) => ({ mode: "pawns" as const, value });
const winChance = (value: number) => ({ mode: "winChance" as const, value });

const whiteLines = [
    line("e4", "e2e4", 80, 1),
    line("d4", "d2d4", 60, 2),
    line("Nf3", "g1f3", 30, 3),
    line("c4", "c2c4", 10, 4),
    line("g3", "g2g3", 0, 5),
];

test("the settings use the wins metric by default", () => {
    expect(bestLineSettingsSchema.parse({}).metric).toBe("wins");
    expect(bestLineSettingsSchema.parse({ ranking: "wilson" }).metric).toBe("wins");
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

// --- opponent ----------------------------------------------------------------

const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";

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
                stats: { score: 0.578, opponentScore: 0, games: 10, share: 0.4 },
            }),
            "white",
            labels,
        ),
    ).toEqual({ text: "57.8% winrate", color: "green" });
});

test("lineComment shows the evaluation in blue for a studied engine move", () => {
    expect(
        lineComment(
            node({
                reason: "engine",
                score: cp(45),
                stats: { score: 0.5, opponentScore: 0, games: 3, share: 0.1 },
            }),
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
                stats: { score: 0.45, opponentScore: 0, games: 12345, share: 0.452 },
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
    const stats = { score: 0.52, opponentScore: 0.3, games: 800, share: 0.2 };
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

test("isTrapMistake requires a mistake that humans actually punish", () => {
    // The studied side scores 60% in the position.
    const punished = { score: 0.25, opponentScore: 0.75, games: 1000, share: 0.2 };
    const unpunished = { score: 0.42, opponentScore: 0.58, games: 1000, share: 0.2 };
    expect(isTrapMistake("??", punished, 0.6)).toBe(true);
    expect(isTrapMistake("?", punished, 0.6)).toBe(true);
    expect(isTrapMistake("?!", punished, 0.6)).toBe(false);
    expect(isTrapMistake("??", unpunished, 0.6)).toBe(false);
    expect(isTrapMistake("??", { ...punished, games: 10 }, 0.6)).toBe(false);
    expect(isTrapMistake("??", undefined, 0.6)).toBe(false);
});

test("isTrap reads the trap flag of a node", () => {
    expect(isTrap(leaf("e5"))).toBe(false);
    expect(isTrap({ ...leaf("e5"), trap: true })).toBe(true);
});

test("lineComment describes a trap branch by how often it was played", () => {
    expect(
        lineComment(
            node({
                color: "black",
                reason: "trap",
                stats: { score: 0.3, opponentScore: 0, games: 2000, share: 0.217 },
            }),
            "white",
            labels,
        ),
    ).toEqual({ text: "21.7% played · 2000 games" });
});

test("cloudLinesUsable requires enough lines at the requested depth", () => {
    const lines = [line("e4", "e2e4", 30, 1), line("d4", "d2d4", 25, 2)].map((l) => ({
        ...l,
        depth: 40,
    }));
    expect(cloudLinesUsable(lines, 18, 2)).toBe(true);
    expect(cloudLinesUsable(lines, 18, 5)).toBe(false);
    expect(cloudLinesUsable(lines, 50, 2)).toBe(false);
    expect(cloudLinesUsable([], 18, 1)).toBe(false);
});

// --- analysis purpose and depth ----------------------------------------------

function rootAfter(moves: string[], fen?: string) {
    const store = createTreeStore();
    if (fen) store.getState().setFen(fen);
    store.getState().addLine(moves.map((san) => ({ san })));
    const { root, position } = store.getState();
    return { root, position };
}

test("movesTo numbers the moves leading to a position", () => {
    const { root, position } = rootAfter(["e4", "c5", "Nf3"]);
    expect(movesTo(root, position)).toBe("1. e4 c5 2. Nf3");
    expect(movesTo(root, [])).toBe("");
});

test("movesTo keeps the last moves of a long line", () => {
    const { root, position } = rootAfter(["e4", "c5", "Nf3", "d6", "d4", "cxd4", "Nxd4"]);
    expect(movesTo(root, position, 4)).toBe("… 2... d6 3. d4 cxd4 4. Nxd4");
});

test("movesTo starts a black move with an ellipsis", () => {
    const { root, position } = rootAfter(["c5"], AFTER_E4);
    expect(movesTo(root, position)).toBe("1... c5");
});

// --- start position reuse ----------------------------------------------------

test("sansBetween lists the moves from a node to one of its descendants", () => {
    const { root, position } = rootAfter(["e4", "c5", "Nf3"]);
    expect(sansBetween(root, [0], position)).toEqual(["c5", "Nf3"]);
    expect(sansBetween(root, position, position)).toEqual([]);
    expect(sansBetween(root, [1], position)).toBeNull();
});

test("resultPathOf finds the moves of a result", () => {
    expect(resultPathOf(forest(), ["e4", "c5"])).toEqual([0, 1]);
    expect(resultPathOf(forest(), ["e4", "e5", "Nf3"])).toEqual([0, 0, 0]);
    expect(resultPathOf(forest(), ["e4", "d5"])).toBeNull();
    expect(resultPathOf(forest(), [])).toBeNull();
});
