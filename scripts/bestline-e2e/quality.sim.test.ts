import { expect, test } from "vitest";
import { searchBestLine, type SearchParams } from "@/utils/bestLine/search";
import { chosenMoves, ruleChoice, World, type WorldNode } from "@/utils/tests/bestLineWorld";
import { searchParams } from "@/utils/tests/bestLineFixtures";

/**
 * How good the moves of a search are, on made-up openings whose truth is known
 * (see bestLineWorld.ts), against simple ways of choosing and against the best
 * a careful player could do. Run with E2E_SIM=1 (E2E_SEEDS=n for more worlds).
 */
const SIM = process.env.E2E_SIM;
const SEEDS = Number(process.env.E2E_SEEDS ?? 20);
const PLIES = Number(process.env.E2E_PLIES ?? 6);

function stats(values: number[]) {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance =
        values.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, values.length - 1);
    return { mean, se: Math.sqrt(variance / values.length) };
}

const fmt = (x: { mean: number; se: number }, digits = 2) =>
    `${(x.mean * 100).toFixed(digits)} ±${(x.se * 100).toFixed(digits)}`;

type Variants = Record<string, Partial<SearchParams>>;

/** Mean result of each way of choosing on the same worlds, as points over the most played move. */
async function simulate(
    games: number,
    studied: "white" | "black",
    variants: Variants,
    world: Partial<{ practicalNoise: number; branching: number; engineScale: number }> = {},
) {
    const diffs: Record<string, number[]> = { bestScore: [], oracle: [] };
    for (const name of Object.keys(variants)) diffs[name] = [];
    const absolute: number[] = [];
    const requests: Record<string, { explores: number; analyses: number }> = {};
    let expanded = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
        const w = new World({
            seed,
            studied,
            games,
            horizon: PLIES + 1,
            rootFen:
                studied === "white"
                    ? undefined
                    : "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
            ...world,
        });
        const base = searchParams({
            fen: w.root.fen,
            color: studied,
            maxPlies: PLIES,
            tolerance: { mode: "pawns", value: 0.3 },
            minReach: Number(process.env.E2E_REACH ?? 0.02),
            minimumGames: Number(process.env.E2E_MINGAMES ?? 5000),
            minGamesPerMove: Number(process.env.E2E_MINMOVE ?? 100),
        });
        const horizon = { maxPlies: PLIES, minReach: base.minReach };
        const value = (choose: (node: WorldNode) => string | undefined) =>
            w.valueOf(choose, horizon);
        const mostPlayed = value(ruleChoice(w, "mostPlayed", base));
        absolute.push(mostPlayed);
        diffs.bestScore.push(value(ruleChoice(w, "bestScore", base)) - mostPlayed);
        diffs.oracle.push(w.oracle(30, horizon) - mostPlayed);
        for (const [name, over] of Object.entries(variants)) {
            let explores = 0;
            let analyses = 0;
            const found = await searchBestLine(
                { ...base, ...over },
                {
                    explore: async (fen) => (explores++, w.explore(fen)),
                    analyze: async (fen, request) => (analyses++, w.analyze(fen, request)),
                },
            );
            requests[name] ??= { explores: 0, analyses: 0 };
            requests[name].explores += explores;
            requests[name].analyses += analyses;
            if (name === Object.keys(variants)[0]) expanded += found.stats.expanded;
            const chosen = chosenMoves(found.root);
            diffs[name].push(value((node) => chosen.get(node.key)) - mostPlayed);
            // Where the search opened nothing, the simple rule plays: what is left is the
            // quality of its decisions, not how far it looked.
            const fallback = ruleChoice(w, "bestScore", base);
            diffs[`${name} + rule`] ??= [];
            diffs[`${name} + rule`].push(
                value((node) => chosen.get(node.key) ?? fallback(node)) - mostPlayed,
            );
        }
    }
    const room = stats(diffs.oracle).mean;
    const paired = (name: string) => stats(diffs[name].map((d, i) => d - diffs.bestScore[i]));
    const rows = Object.keys(variants).flatMap((name) =>
        [name, `${name} + rule`].map(
            (key) =>
                `    ${key.padEnd(22)} ${fmt(stats(diffs[key]))} (${((stats(diffs[key]).mean / room) * 100).toFixed(0)}% of the oracle's gain) | vs best raw score ${fmt(paired(key))}` +
                (requests[key]
                    ? ` | per search: ${(requests[key].explores / SEEDS).toFixed(1)} explorer requests, ${(requests[key].analyses / SEEDS).toFixed(1)} analyses`
                    : ""),
        ),
    );
    return [
        `games ${String(games).padStart(8)} ${studied.padEnd(5)} | most played ${fmt(stats(absolute))} points | best raw score ${fmt(stats(diffs.bestScore))} | oracle ${fmt(stats(diffs.oracle))} | positions opened ${(expanded / SEEDS).toFixed(0)}`,
        ...rows,
    ].join("\n");
}

const VARIANTS: Variants = process.env.E2E_SWEEP
    ? {
          "default (risk 1, k 100)": {},
          "risk 0": { risk: 0 },
          "risk 2": { risk: 2 },
          "shrinkage 30": { shrinkage: 30 },
          "shrinkage 300": { shrinkage: 300 },
          "shrinkage 0, risk 0": { shrinkage: 0, risk: 0 },
      }
    : process.env.E2E_TRUST
      ? {
            default: {},
            ...Object.fromEntries(
                process.env.E2E_TRUST.split(",").map((n) => [
                    `trust ${n}`,
                    { trustGames: Number(n) },
                ]),
            ),
        }
      : { default: {} };

test.skipIf(!SIM)(
    "search against simple rules and the oracle",
    async () => {
        const rows: string[] = [];
        const noise = process.env.E2E_NOISE ? Number(process.env.E2E_NOISE) : undefined;
        const scale = process.env.E2E_SCALE ? Number(process.env.E2E_SCALE) : undefined;
        for (const studied of ["white", "black"] as const) {
            for (const games of [30_000, 300_000, 3_000_000]) {
                rows.push(
                    await simulate(games, studied, VARIANTS, {
                        practicalNoise: noise,
                        engineScale: scale,
                    }),
                );
            }
        }
        console.log(`worlds: ${SEEDS} per row, ${PLIES} plies\n${rows.join("\n")}`);
        expect(rows.length).toBeGreaterThan(0);
    },
    3_600_000,
);
