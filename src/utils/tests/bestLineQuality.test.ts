import { expect, test } from "vitest";
import { searchBestLine, type SearchParams } from "@/utils/bestLine/search";
import { searchParams } from "./bestLineFixtures";
import { chosenMoves, ruleChoice, World, type WorldNode } from "./bestLineWorld";

/**
 * Is the search worth running? On made-up openings whose truth is known
 * (bestLineWorld.ts), the result a careful player gets from the moves it finds
 * is compared with the simple ways of choosing: the most played sound move, and
 * the one with the best raw score. The numbers behind the thresholds come from
 * scripts/bestline-e2e/quality.sim.test.ts, which runs many more worlds.
 */

const PLIES = 5;
const SEEDS = 25;

function mean(values: number[]) {
    return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Points over the most played move, for each way of choosing, on the same worlds. */
async function compare(games: number, studied: "white" | "black") {
    const gains = { search: [] as number[], rawScore: [] as number[] };
    for (let seed = 1; seed <= SEEDS; seed++) {
        const world = new World({
            seed,
            studied,
            games,
            branching: 3,
            horizon: PLIES + 1,
            rootFen:
                studied === "white"
                    ? undefined
                    : "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
        });
        const params: SearchParams = searchParams({
            fen: world.root.fen,
            color: studied,
            maxPlies: PLIES,
        });
        const horizon = { maxPlies: PLIES, minReach: params.minReach };
        const value = (choose: (node: WorldNode) => string | undefined) =>
            world.valueOf(choose, horizon);
        const { root } = await searchBestLine(params, {
            explore: world.explore,
            analyze: world.analyze,
        });
        const chosen = chosenMoves(root);
        // Where the search opened nothing the simple rule plays: this measures
        // its decisions, not how far it looked.
        const rule = ruleChoice(world, "bestScore", params);
        const mostPlayed = value(ruleChoice(world, "mostPlayed", params));
        gains.search.push(value((node) => chosen.get(node.key) ?? rule(node)) - mostPlayed);
        gains.rawScore.push(value(rule) - mostPlayed);
    }
    return { search: mean(gains.search), rawScore: mean(gains.rawScore) };
}

const results = (async () => {
    const all: Record<string, { search: number; rawScore: number }> = {};
    for (const studied of ["white", "black"] as const) {
        for (const games of [60_000, 1_000_000]) {
            all[`${studied} ${games}`] = await compare(games, studied);
        }
    }
    return all;
})();

test("the moves of the search beat the most played sound move", async () => {
    for (const [setting, { search }] of Object.entries(await results)) {
        // Points of expected result over the most played move, about 7 to 9 here.
        expect({ setting, beats: search > 0.04 }).toEqual({ setting, beats: true });
    }
});

test("the moves of the search do at least as well as the best raw score", async () => {
    for (const [setting, { search, rawScore }] of Object.entries(await results)) {
        expect({ setting, atLeastAsGood: search > rawScore - 0.01 }).toEqual({
            setting,
            atLeastAsGood: true,
        });
    }
});
