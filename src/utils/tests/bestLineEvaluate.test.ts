import { expect, test } from "vitest";
import { evaluateLeaves } from "@/utils/bestLine/evaluate";
import { toBestLineNodes } from "@/utils/bestLine/project";
import { searchBestLine } from "@/utils/bestLine/search";
import { fakeBook, fakeEngine, searchParams } from "./bestLineFixtures";

async function searched(engine: ReturnType<typeof fakeEngine>, plies = 2) {
    const book = fakeBook({ shares: [0.6, 0.3] });
    const { root } = await searchBestLine(searchParams({ maxPlies: plies }), {
        explore: book.explore,
        analyze: engine.analyze,
    });
    return root;
}

test("evaluateLeaves evaluates the positions the result ends on, at the fast depth", async () => {
    const engine = fakeEngine([30, 20]);
    const root = await searched(engine);
    engine.analysed.length = 0;

    const evaluated = await evaluateLeaves(root, { mode: "tree" }, { analyze: engine.analyze });

    expect(evaluated).toBeGreaterThan(0);
    expect(engine.analysed).toHaveLength(evaluated);
    for (const request of engine.analysed) {
        expect(request.purpose).toBe("evaluation");
        expect(request.multipv).toBe(1);
    }
});

test("evaluateLeaves keeps a single line's leaf only", async () => {
    const engine = fakeEngine([30, 20]);
    const root = await searched(engine, 4);
    engine.analysed.length = 0;

    const evaluated = await evaluateLeaves(root, { mode: "line" }, { analyze: engine.analyze });

    expect(evaluated).toBe(1);
});

test("evaluateLeaves leaves an analysed position alone", async () => {
    const engine = fakeEngine([30, 20]);
    const root = await searched(engine);
    engine.analysed.length = 0;

    await evaluateLeaves(root, { mode: "tree" }, { analyze: engine.analyze });
    const first = engine.analysed.length;
    await evaluateLeaves(root, { mode: "tree" }, { analyze: engine.analyze });

    // The second pass has nothing left to evaluate.
    expect(engine.analysed).toHaveLength(first);
});

test("evaluateLeaves stops when the search is cancelled", async () => {
    const engine = fakeEngine([30, 20]);
    const root = await searched(engine);
    engine.analysed.length = 0;

    await evaluateLeaves(
        root,
        { mode: "tree" },
        {
            analyze: engine.analyze,
            isCancelled: () => true,
        },
    );

    expect(engine.analysed).toHaveLength(0);
});

test("the result shows the evaluation an opponent reply leads to", async () => {
    const engine = fakeEngine([30, 20]);
    const root = await searched(engine, 3);
    await evaluateLeaves(root, { mode: "line" }, { analyze: engine.analyze });

    const nodes = toBestLineNodes(root, { mode: "line", preciseDepth: 18 });
    const reply = nodes[0].children[0];
    expect(reply.color).toBe("black");
    expect(reply.score).toBeDefined();
    // An opponent reply is only ever evaluated quickly.
    expect(reply.precise).toBeFalsy();
});

test("the result marks the studied side's evaluations as coming from the precise depth", async () => {
    const engine = fakeEngine([30, 20], { precise: [40, 20] });
    const root = await searched(engine);
    const nodes = toBestLineNodes(root, { mode: "line", preciseDepth: 18 });
    // The candidates are always analysed at the precise depth.
    expect(nodes[0].precise).toBe(true);
    expect(nodes[0].score?.value).toEqual({ type: "cp", value: 40 });
});

test("evaluateLeaves stops quietly when an analysis fails because the search was stopped", async () => {
    const engine = fakeEngine([30, 20]);
    const root = await searched(engine);
    let stopped = false;

    const evaluated = await evaluateLeaves(
        root,
        { mode: "tree" },
        {
            analyze: async () => {
                stopped = true;
                throw new Error("Analysis cancelled");
            },
            isCancelled: () => stopped,
        },
    );

    expect(evaluated).toBe(0);
});

test("evaluateLeaves does not hide a failure the user did not ask for", async () => {
    const engine = fakeEngine([30, 20]);
    const root = await searched(engine);

    await expect(
        evaluateLeaves(
            root,
            { mode: "tree" },
            {
                analyze: async () => {
                    throw new Error("engine crashed");
                },
            },
        ),
    ).rejects.toThrow("engine crashed");
});
