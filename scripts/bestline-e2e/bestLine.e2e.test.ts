import { expect, test } from "vitest";
import type { BestMoves } from "@/bindings";
import { isPreciseAnalysis, type AnalysisPurpose } from "@/utils/bestLine";
import { playSan } from "@/utils/bestLine/position";
import { searchBestLine, type SearchParams } from "@/utils/bestLine/search";
import { toBestLineNodes } from "@/utils/bestLine/project";
import { evaluateLeaves } from "@/utils/bestLine/evaluate";
import { engineBook } from "./engineBook";
import { UciEngine } from "./uciEngine";

/**
 * End-to-end run of the search with a real engine. The Lichess explorer needs a
 * token, so the book is made up from the engine itself: humans-like replies
 * weighted by their evaluation. Run with E2E_ENGINE=/path/to/uci.exe.
 */
const ENGINE = process.env.E2E_ENGINE;
const FAST = Number(process.env.E2E_FAST ?? 12);
const PRECISE = Number(process.env.E2E_PRECISE ?? 20);
const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

type Call = { purpose: AnalysisPurpose; seconds: number; searchMoves: number };

function setup() {
    const engine = new UciEngine(ENGINE as string, { Threads: 8, Hash: 512 });
    const calls: Call[] = [];
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
            const start = Date.now();
            p = engine.analyze(fen, depth, multipv, r.searchMoves).then((lines) => {
                calls.push({
                    purpose: r.purpose,
                    seconds: (Date.now() - start) / 1000,
                    searchMoves: r.searchMoves?.length ?? 0,
                });
                return lines;
            });
            memo.set(key, p);
        }
        return p;
    };
    const bookEngine = new UciEngine(ENGINE as string, { Threads: 2, Hash: 64 });
    const explore = engineBook(bookEngine, START);
    return { engine, bookEngine, analyze, explore, calls };
}

const params = (o: Partial<SearchParams> = {}): SearchParams => ({
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
    ...o,
});

function report(name: string, calls: Call[], seconds: number, extra: unknown) {
    const by = (p: AnalysisPurpose) => calls.filter((c) => c.purpose === p);
    const fmt = (p: AnalysisPurpose) => {
        const c = by(p)
            .map((x) => x.seconds)
            .sort((a, b) => a - b);
        const sum = c.reduce((a, b) => a + b, 0);
        return `${p}: n=${c.length} total=${sum.toFixed(1)}s max=${(c.at(-1) ?? 0).toFixed(1)}s`;
    };
    console.log(
        `[${name}] ${seconds.toFixed(1)}s | ${fmt("candidates")} | ${fmt("decision")} | ${fmt("evaluation")} | ${JSON.stringify(extra)}`,
    );
}

test.skipIf(!ENGINE)(
    "end-to-end: full search, extension and live",
    async () => {
        const { engine, bookEngine, analyze, explore, calls } = setup();
        try {
            // 1. Full search.
            let start = Date.now();
            const full = await searchBestLine(params(), { analyze, explore });
            await evaluateLeaves(full.root, { mode: "tree" }, { analyze });
            const nodes = toBestLineNodes(full.root, {
                mode: "tree",
                metric: "score",
                preciseDepth: PRECISE,
                risk: 1,
                trapMinShare: 0.05,
            });
            report("full", calls, (Date.now() - start) / 1000, full.stats);
            const line: string[] = [];
            for (let n = nodes; n[0]; n = n[0].children) line.push(n[0].san);
            console.log("main line:", line.join(" "));
            expect(nodes.length).toBeGreaterThan(0);

            // 2. Extension of 3 moves from the end of the main line.
            let path = nodes;
            let leaf = path[0];
            while (leaf.children[0]) leaf = leaf.children[0];
            const before = calls.length;
            start = Date.now();
            const { fen: leafFen } = playSan(leaf.fen, leaf.san) ?? { fen: "" };
            const ext = await searchBestLine(
                params({ fen: leafFen, maxPlies: 6, reach: leaf.reach }),
                {
                    analyze,
                    explore,
                },
            );
            report("extend", calls.slice(before), (Date.now() - start) / 1000, {
                ...ext.stats,
                reach: leaf.reach,
            });

            // 3. Live: one move, two moves of look-ahead.
            const liveBefore = calls.length;
            start = Date.now();
            const live = await searchBestLine(params({ maxPlies: 3, trapMinShare: undefined }), {
                analyze,
                explore,
            });
            report(
                "live(cached)",
                calls.slice(liveBefore),
                (Date.now() - start) / 1000,
                live.stats,
            );
        } finally {
            engine.quit();
            bookEngine.quit();
        }
    },
    3_600_000,
);
