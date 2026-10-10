import { expect, test } from "vitest";
import { UciEngine } from "./uciEngine";

const ENGINE = process.env.E2E_ENGINE;
const FENS = [
    "r1bqkb1r/pppp1ppp/2n2n2/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
    "r1bq1rk1/ppp2ppp/2np1n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w - - 0 7",
];
test.skipIf(!ENGINE)(
    "depth scaling",
    async () => {
        const e = new UciEngine(ENGINE as string, { Threads: 16, Hash: 2048 });
        for (const fen of FENS) {
            for (const [depth, pv] of [
                [16, 1],
                [20, 1],
                [22, 1],
                [24, 1],
                [26, 1],
                [28, 1],
                [24, 5],
                [28, 5],
            ]) {
                const t = Date.now();
                await e.analyze(fen, depth, pv);
                console.log(
                    `depth ${depth} multipv ${pv}: ${((Date.now() - t) / 1000).toFixed(1)}s`,
                );
            }
        }
        e.quit();
        expect(FENS.length).toBeGreaterThan(0);
    },
    1_800_000,
);
