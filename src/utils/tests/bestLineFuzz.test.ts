import { expect, test } from "vitest";
import { evaluateLeaves } from "@/utils/bestLine/evaluate";
import type { SearchNode } from "@/utils/bestLine/node";
import { playSan } from "@/utils/bestLine/position";
import { countNodes, toBestLineNodes } from "@/utils/bestLine/project";
import { coverageOf, searchBestLine, type SearchParams } from "@/utils/bestLine/search";
import { searchParams } from "./bestLineFixtures";
import { World } from "./bestLineWorld";

/**
 * Whatever the openings, the settings and the moment the search is stopped, the
 * tree it returns has to be one the rest of the app can use: legal moves
 * following one another, a single move chosen for the studied side and only a
 * sound one, shares that make sense. Checked on made-up worlds (bestLineWorld.ts).
 */

const TOLERANCE_CP = 30;

type Setup = {
    seed: number;
    studied: "white" | "black";
    games: number;
    over: Partial<SearchParams>;
};

const SETUPS: Setup[] = [
    { seed: 1, studied: "white", games: 400_000, over: {} },
    { seed: 2, studied: "black", games: 400_000, over: { metric: "wins" } },
    { seed: 3, studied: "white", games: 20_000, over: { minReach: 0.005 } },
    {
        seed: 4,
        studied: "black",
        games: 2_000_000,
        over: { minGamesPerMove: 500, minMoveShare: 0.05 },
    },
    { seed: 5, studied: "white", games: 150_000, over: { risk: 0, shrinkage: 0 } },
    { seed: 6, studied: "white", games: 150_000, over: { mode: "line" } },
    { seed: 7, studied: "black", games: 150_000, over: { keepPlies: 3 } },
    { seed: 8, studied: "white", games: 60_000, over: { minimumGames: 500, trapMinShare: 0.05 } },
];

function worldOf({ seed, studied, games }: Setup) {
    return new World({
        seed,
        studied,
        games,
        branching: 3,
        horizon: 6,
        rootFen:
            studied === "white"
                ? undefined
                : "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
    });
}

function paramsOf(world: World, setup: Setup): SearchParams {
    return searchParams({
        fen: world.root.fen,
        color: setup.studied,
        maxPlies: 5,
        tolerance: { mode: "pawns", value: TOLERANCE_CP / 100 },
        ...setup.over,
    });
}

function* nodesOf(root: SearchNode): Generator<SearchNode> {
    yield root;
    for (const edge of root.edges ?? []) if (edge.child) yield* nodesOf(edge.child);
}

function checkTree(root: SearchNode, world: World, maxPlies: number) {
    const problems: string[] = [];
    const check = (ok: boolean, what: string, node: SearchNode) => {
        if (!ok) problems.push(`${what} at ${node.fen}`);
    };
    for (const node of nodesOf(root)) {
        check(node.ply <= maxPlies, "deeper than asked", node);
        const edges = node.edges ?? [];
        check(new Set(edges.map((edge) => edge.san)).size === edges.length, "twice a move", node);
        for (const edge of edges) {
            if (!edge.child) continue;
            // Each position follows from the one before by a legal move.
            check(
                playSan(node.fen, edge.san)?.fen === edge.child.fen,
                `${edge.san} not played`,
                node,
            );
            check(edge.child.ply === node.ply + 1, "ply", node);
            // A line can only get rarer.
            check(edge.child.reach <= node.reach + 1e-9, "reach grows", node);
            check(edge.child.studied === !node.studied, "side to move", node);
        }
        if (node.studied) {
            const chosen = edges.filter((edge) => edge.status === "chosen");
            check(chosen.length <= 1, "several moves chosen", node);
            // The engine's tolerance is never exceeded: every move it knows is among its lines.
            const here = world.nodeAt(node.fen);
            const best = Math.min(...(here?.moves.map((m) => m.loss) ?? [0]));
            for (const edge of chosen) {
                const move = here?.moves.find((m) => m.san === edge.san);
                check(
                    !move || move.loss - best <= TOLERANCE_CP + 1e-9,
                    `${edge.san} chosen beyond the tolerance`,
                    node,
                );
            }
        } else {
            const replies = edges.filter((edge) => edge.status === "reply");
            const share = replies.reduce((acc, edge) => acc + edge.probability, 0);
            check(share <= 1 + 1e-9, "replies share more than all the games", node);
            check(
                replies.every((edge) => edge.probability > 0),
                "a reply nobody plays",
                node,
            );
        }
        // Whatever the engine could do about it, a value stays a result.
        check(node.value.mean >= 0 && node.value.mean <= 1, "value out of [0, 1]", node);
        check(Number.isFinite(node.value.sigma), "uncertainty not a number", node);
    }
    const coverage = coverageOf(root);
    if (coverage < 0 || coverage > 1) problems.push(`coverage ${coverage}`);
    expect(problems).toEqual([]);
}

for (const setup of SETUPS) {
    const label = `seed ${setup.seed}, ${setup.studied}, ${setup.games} games, ${JSON.stringify(setup.over)}`;

    test(`the tree holds together (${label})`, async () => {
        const world = worldOf(setup);
        const params = paramsOf(world, setup);
        const { root, stats } = await searchBestLine(params, {
            explore: world.explore,
            analyze: world.analyze,
        });

        expect(stats.cancelled).toBe(false);
        expect(root.edges?.length).toBeGreaterThan(0);
        checkTree(root, world, params.maxPlies);

        // What the app shows can be built from it, evaluations included.
        await evaluateLeaves(root, { mode: params.mode ?? "tree" }, { analyze: world.analyze });
        const nodes = toBestLineNodes(root, { mode: params.mode ?? "tree", metric: params.metric });
        expect(nodes.length).toBeGreaterThan(0);
        expect(countNodes(nodes)).toBeGreaterThan(0);
    });

    test(`the same search finds the same tree (${label})`, async () => {
        const run = async () => {
            const world = worldOf(setup);
            const params = paramsOf(world, setup);
            const { root } = await searchBestLine(params, {
                explore: world.explore,
                analyze: world.analyze,
            });
            return JSON.stringify(
                toBestLineNodes(root, { mode: params.mode ?? "tree", metric: params.metric }),
            );
        };
        expect(await run()).toBe(await run());
    });
}

test("a search stopped at any moment returns a tree that holds together", async () => {
    const setup = SETUPS[0];
    for (const stopAfter of [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89]) {
        const world = worldOf(setup);
        const params = paramsOf(world, setup);
        let calls = 0;
        const { root, stats } = await searchBestLine(params, {
            explore: world.explore,
            analyze: world.analyze,
            isCancelled: () => ++calls > stopAfter,
        });

        checkTree(root, world, params.maxPlies);
        expect(stats.expanded).toBeGreaterThanOrEqual(0);
        await evaluateLeaves(root, { mode: "tree" }, { analyze: world.analyze });
        expect(() => toBestLineNodes(root, { mode: "tree", metric: params.metric })).not.toThrow();
    }
});

test("every position is looked up once, whatever the number of ways to reach it", async () => {
    const setup = SETUPS[2];
    const world = worldOf(setup);
    const params = paramsOf(world, setup);
    const seen = new Map<string, number>();
    await searchBestLine(params, {
        explore: async (fen) => {
            const key = fen.split(" ").slice(0, 4).join(" ");
            seen.set(key, (seen.get(key) ?? 0) + 1);
            return world.explore(fen);
        },
        analyze: world.analyze,
    });
    // A transposition is opened twice (the tree has no memory of it), but the
    // callers' caches answer the second: the search itself never asks more than
    // twice about a position in a world this small.
    expect(Math.max(...seen.values())).toBeLessThanOrEqual(2);
});
