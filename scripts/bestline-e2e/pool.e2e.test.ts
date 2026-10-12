import { expect, test } from "vitest";
import type { BestMoves } from "@/bindings";
import { isPreciseAnalysis, type AnalysisPurpose } from "@/utils/bestLine";
import { searchBestLine, type SearchParams } from "@/utils/bestLine/search";
import { engineBook } from "./engineBook";
import { UciEngine } from "./uciEngine";

/**
 * Throughput of the engine work of a real search: the analyses it asks for are
 * recorded, then replayed on one engine with many threads, or on several engines
 * with a few threads each (what the app would do to analyse positions side by
 * side). Run with E2E_ENGINE=/path/to/uci.exe.
 */
const ENGINE = process.env.E2E_ENGINE;
const FAST = Number(process.env.E2E_FAST ?? 14);
const PRECISE = Number(process.env.E2E_PRECISE ?? 18);
const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

type Req = { fen: string; depth: number; multipv: number; searchMoves: string[] };

async function record(): Promise<Req[]> {
    const engine = new UciEngine(ENGINE as string, { Threads: 8, Hash: 512 });
    const book = new UciEngine(ENGINE as string, { Threads: 2, Hash: 64 });
    const reqs: Req[] = [];
    const memo = new Map<string, Promise<BestMoves[]>>();
    const analyze = (
        fen: string,
        r: { purpose: AnalysisPurpose; multipv?: number; searchMoves?: string[] },
    ) => {
        const depth = isPreciseAnalysis(r.purpose) ? PRECISE : FAST;
        const multipv = Math.min(r.multipv ?? 5, r.searchMoves?.length || 99);
        const key = `${fen}|${depth}|${multipv}|${r.searchMoves ?? ""}`;
        let p = memo.get(key);
        if (!p) {
            reqs.push({ fen, depth, multipv, searchMoves: r.searchMoves ?? [] });
            p = engine.analyze(fen, depth, multipv, r.searchMoves);
            memo.set(key, p);
        }
        return p;
    };
    const params: SearchParams = {
        fen: START,
        color: "white",
        maxPlies: 8,
        tolerance: { mode: "winChance", value: 3 },
        metric: "score",
        minimumGames: 5000,
        minGamesPerMove: 100,
        minMoveShare: 0.01,
        trapMinShare: 0.05,
        minReach: 0.02,
        shrinkage: 100,
        risk: 1,
        smoothing: 1,
    };
    await searchBestLine(params, { analyze, explore: engineBook(book, START) });
    engine.quit();
    book.quit();
    return reqs;
}

async function replay(reqs: Req[], engines: number, threads: number, hash: number) {
    const pool = Array.from(
        { length: engines },
        () => new UciEngine(ENGINE as string, { Threads: threads, Hash: hash }),
    );
    const start = Date.now();
    let next = 0;
    await Promise.all(
        pool.map(async (engine) => {
            while (next < reqs.length) {
                const r = reqs[next++];
                await engine.analyze(r.fen, r.depth, r.multipv, r.searchMoves);
            }
        }),
    );
    const seconds = (Date.now() - start) / 1000;
    for (const engine of pool) engine.quit();
    return seconds;
}

test.skipIf(!ENGINE)(
    "engine throughput of a search",
    async () => {
        const reqs = await record();
        console.log(`recorded ${reqs.length} analyses (fast ${FAST}, precise ${PRECISE})`);
        const configs: [number, number][] = (process.env.E2E_POOLS ?? "1x16,1x8,2x8,4x4,8x2,16x1")
            .split(",")
            .map((c) => c.split("x").map(Number) as [number, number]);
        for (const [engines, threads] of configs) {
            const seconds = await replay(reqs, engines, threads, Math.floor(2048 / engines));
            console.log(`${engines} engine(s) x ${threads} thread(s): ${seconds.toFixed(1)}s`);
        }
        expect(reqs.length).toBeGreaterThan(0);
    },
    3_600_000,
);
