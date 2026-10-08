import { expect, test } from "vitest";
import { searchBestLine } from "@/utils/bestLine/search";
import { verifyChoices } from "@/utils/bestLine/verify";
import { fakeBook, fakeEngine, searchParams } from "./bestLineFixtures";

/** A search whose fast candidates are all within tolerance of each other. */
async function searched(
    engine: ReturnType<typeof fakeEngine>,
    overrides: Parameters<typeof searchParams>[0] = {},
    shares = [0.6, 0.3],
) {
    const book = fakeBook({ shares });
    const { root } = await searchBestLine(
        searchParams({ maxPlies: 2, preciseDepth: 18, ...overrides }),
        { explore: book.explore, analyze: engine.analyze },
    );
    return root;
}

test("verification analyses the candidates of a position in one request", async () => {
    const engine = fakeEngine([30, 20]);
    const root = await searched(engine);
    engine.analysed.length = 0;

    await verifyChoices(root, searchParams({ preciseDepth: 18 }), { analyze: engine.analyze });

    const checks = engine.analysed.filter((a) => a.purpose === "verification");
    expect(checks).toHaveLength(1);
    // One analysis for both candidates, and never more lines than moves asked.
    expect(checks[0].searchMoves).toHaveLength(2);
    expect(checks[0].multipv).toBe(checks[0].searchMoves?.length);
});

test("verification keeps the chosen move when the precise depth agrees", async () => {
    const engine = fakeEngine([30, 20], { precise: [30, 20] });
    const root = await searched(engine);
    const before = root.edges?.find((e) => e.status === "chosen")?.san;

    const { changed } = await verifyChoices(root, searchParams({ preciseDepth: 18 }), {
        analyze: engine.analyze,
    });

    expect(changed).toBe(0);
    expect(root.edges?.find((e) => e.status === "chosen")?.san).toBe(before);
});

test("verification drops a candidate the precise depth puts out of tolerance", async () => {
    // The move the statistics preferred turns out to lose half a pawn.
    const engine = fakeEngine([30, 25], { precise: [30, -70] });
    // The statistics prefer the second candidate, which the engine then sinks.
    const root = await searched(engine, {}, [0.3, 0.6]);
    const chosen = root.edges?.find((e) => e.status === "chosen");

    const { changed } = await verifyChoices(root, searchParams({ preciseDepth: 18 }), {
        analyze: engine.analyze,
    });

    expect(changed).toBe(1);
    const dropped = root.edges?.find((e) => e.san === chosen?.san);
    expect(dropped?.status).toBe("outOfTolerance");
    expect(root.edges?.find((e) => e.status === "chosen")?.san).not.toBe(chosen?.san);
});

test("verification updates the evaluation it found", async () => {
    const engine = fakeEngine([30, 20], { precise: [55, 20] });
    const root = await searched(engine);

    await verifyChoices(root, searchParams({ preciseDepth: 18 }), { analyze: engine.analyze });

    const first = root.edges?.[0];
    expect(first?.score?.value).toEqual({ type: "cp", value: 55 });
});

test("verification is skipped when the fast lines are already deep enough", async () => {
    const engine = fakeEngine([30, 20], { depth: 30 });
    const root = await searched(engine);
    engine.analysed.length = 0;

    const { checked } = await verifyChoices(root, searchParams({ preciseDepth: 18 }), {
        analyze: engine.analyze,
    });

    expect(checked).toBe(0);
    expect(engine.analysed).toHaveLength(0);
});

test("verification never analyses the opponent's positions", async () => {
    const engine = fakeEngine([30, 20]);
    const root = await searched(engine, { maxPlies: 4 });
    engine.analysed.length = 0;

    await verifyChoices(
        root,
        { ...searchParams({ preciseDepth: 18 }), mode: "tree" as const },
        {
            analyze: engine.analyze,
        },
    );

    const studied = new Set<string>();
    const walk = (node: typeof root) => {
        if (node.studied) studied.add(node.fen);
        for (const edge of node.edges ?? []) if (edge.child) walk(edge.child);
    };
    walk(root);
    for (const check of engine.analysed) expect(studied.has(check.fen)).toBe(true);
});

test("verification stops when the search is cancelled", async () => {
    const engine = fakeEngine([30, 20]);
    const root = await searched(engine, { maxPlies: 4 });
    engine.analysed.length = 0;

    await verifyChoices(
        root,
        { ...searchParams({ preciseDepth: 18 }), mode: "tree" as const },
        {
            analyze: engine.analyze,
            isCancelled: () => true,
        },
    );

    expect(engine.analysed).toHaveLength(0);
});
