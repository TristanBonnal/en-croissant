import { INITIAL_FEN } from "chessops/fen";
import { expect, test } from "vitest";
import { evaluateLeaves } from "@/utils/bestLine/evaluate";
import { settleAll } from "@/utils/bestLine/parallel";
import { legalSans, playSan } from "@/utils/bestLine/position";
import { toBestLineNodes } from "@/utils/bestLine/project";
import { searchBestLine } from "@/utils/bestLine/search";
import { fakeBook, fakeEngine, searchParams as params } from "./bestLineFixtures";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** An engine that answers after a moment and counts the analyses running at once. */
function slowEngine(inner = fakeEngine()) {
    const state = { running: 0, most: 0 };
    const analyze: typeof inner.analyze = async (fen, request) => {
        state.most = Math.max(state.most, ++state.running);
        await tick();
        try {
            return await inner.analyze(fen, request);
        } finally {
            state.running--;
        }
    };
    return { analyze, analysed: inner.analysed, state };
}

test("settleAll waits for every task, then reports the first failure", async () => {
    const done: string[] = [];
    const slow = async () => {
        await tick();
        await tick();
        done.push("slow");
    };
    const failing = async () => {
        throw new Error("first");
    };
    await expect(settleAll([slow(), failing()])).rejects.toThrow("first");
    // Nothing is left running behind a failure.
    expect(done).toEqual(["slow"]);
    await expect(settleAll([])).resolves.toBeUndefined();
});

// --- the end of the search ----------------------------------------------------

/** Every position two plies deep has 2 000 games: out of book, so the engine plays on there. */
function thinBook() {
    const thin: Record<string, number> = {};
    for (const first of legalSans(INITIAL_FEN, 5)) {
        const afterFirst = playSan(INITIAL_FEN, first)?.fen as string;
        for (const reply of legalSans(afterFirst, 5)) {
            thin[playSan(afterFirst, reply)?.fen as string] = 2000;
        }
    }
    return fakeBook({ shares: [0.6, 0.3], thin });
}

test("the engine is played on from several positions at once, without changing the result", async () => {
    const run = async (parallel: boolean) => {
        const engine = slowEngine(fakeEngine([30, 25, 10, 0, -10]));
        const book = thinBook();
        let queue: Promise<unknown> = Promise.resolve();
        const analyze: typeof engine.analyze = (fen, request) => {
            if (parallel) return engine.analyze(fen, request);
            const next = queue.then(() => engine.analyze(fen, request));
            queue = next.catch(() => {});
            return next;
        };
        const found = await searchBestLine(params({ maxPlies: 8, mode: "tree", minReach: 0.01 }), {
            explore: book.explore,
            analyze,
        });
        return { found, most: engine.state.most };
    };
    const serial = await run(false);
    const parallel = await run(true);

    expect(serial.most).toBe(1);
    expect(parallel.most).toBeGreaterThan(1);
    expect(parallel.found.stats).toEqual(serial.found.stats);
    expect(toBestLineNodes(parallel.found.root, { mode: "tree", metric: "score" })).toEqual(
        toBestLineNodes(serial.found.root, { mode: "tree", metric: "score" }),
    );
});

test("evaluateLeaves evaluates the leaves side by side", async () => {
    const book = fakeBook({ shares: [0.6, 0.3] });
    const engine = slowEngine(fakeEngine([30, 20]));
    const { root } = await searchBestLine(params({ maxPlies: 2 }), {
        explore: book.explore,
        analyze: engine.analyze,
    });
    engine.state.most = 0;

    const evaluated = await evaluateLeaves(root, { mode: "tree" }, { analyze: engine.analyze });

    expect(evaluated).toBeGreaterThan(1);
    expect(engine.state.most).toBeGreaterThan(1);
});

test("evaluateLeaves waits for the analyses running when one of them fails", async () => {
    const book = fakeBook({ shares: [0.6, 0.3] });
    const engine = fakeEngine([30, 20]);
    const { root } = await searchBestLine(params({ maxPlies: 2 }), {
        explore: book.explore,
        analyze: engine.analyze,
    });
    let calls = 0;
    let finished = 0;
    const analyze: typeof engine.analyze = async (fen, request) => {
        if (calls++ === 0) throw new Error("engine crashed");
        await tick();
        await tick();
        finished++;
        return engine.analyze(fen, request);
    };

    await expect(evaluateLeaves(root, { mode: "tree" }, { analyze })).rejects.toThrow(
        "engine crashed",
    );
    // The others are over: none of them changes the tree after the failure.
    expect(finished).toBe(calls - 1);
});
