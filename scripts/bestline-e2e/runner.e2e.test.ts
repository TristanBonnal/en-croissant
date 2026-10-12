import { getDefaultStore } from "jotai";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import {
    cancelBestLine,
    extendLine,
    liveKeyOf,
    registerTreeStore,
    releaseBestLine,
    replayMove,
    type SearchConfig,
    startBestLine,
    startLiveSearch,
} from "@/components/bestLine/runner";
import { bestLineResultFamily, bestLineRunFamily } from "@/state/atoms";
import { createTreeStore } from "@/state/store/tree";
import { bestLineSettingsSchema, mainLine, nodeAt, sansTo } from "@/utils/bestLine";
import { playSan } from "@/utils/bestLine/position";
import { clearBestLineCaches } from "@/utils/bestLineCache";
import { getPGN } from "@/utils/chess";
import { defaultTree, getNodeAtPath } from "@/utils/treeReducer";
import { engineBook } from "./engineBook";
import { UciEngine } from "./uciEngine";

/**
 * The whole feature with a real engine: the runner (queue, caches, report),
 * the search, and the moves added to the board's tree. Only Tauri is replaced:
 * its engine command by a UCI process, the Lichess explorer by a book made up
 * from another engine (engineBook.ts).
 * Run with E2E_ENGINE=/path/to/uci.exe.
 */
const ENGINE = process.env.E2E_ENGINE;
const FAST = Number(process.env.E2E_FAST ?? 10);
const PRECISE = Number(process.env.E2E_PRECISE ?? 14);
// The engine of the app: 16 threads and 2 GB by default. E2E_POOL=off gives it no
// thread and hash options, so that it runs as a single engine (how it ran before the pool).
const THREADS = Number(process.env.E2E_THREADS ?? 16);
const POOLED = process.env.E2E_POOL !== "off";
const CORES = Number(process.env.E2E_CORES ?? 16);
const MOVES = Number(process.env.E2E_MOVES ?? 4);
const REACH = Number(process.env.E2E_REACH ?? 0.05);
// Network time added to each explorer request (the real one answers in 100-500 ms).
const EXPLORER_MS = Number(process.env.E2E_EXPLORER_MS ?? 0);
// E2E_APP=1 searches with the app's own settings (line mode, 6 moves, its thresholds) instead of
// the small tree of the other checks; E2E_OLD=1 gives it the defaults it had before 2026-10-12;
// E2E_MINGAMES sets the games a position needs to be judged by its statistics.
const APP = process.env.E2E_APP === "1";
const OLD = process.env.E2E_OLD === "1";

const { analyzePosition, fetchMock, cancelAnalysis } = vi.hoisted(() => ({
    analyzePosition: vi.fn(),
    fetchMock: vi.fn(),
    cancelAnalysis: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: fetchMock }));
vi.mock("@tauri-apps/plugin-log", () => ({ error: vi.fn(), info: vi.fn() }));
vi.mock("@/bindings", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/bindings")>()),
    commands: {
        analyzePosition,
        cancelAnalysis,
        closeAnalysisSession: vi.fn(async () => ({ status: "ok", data: null })),
    },
}));

const TAB = "tab-e2e";
const START = defaultTree().root.fen;
const atoms = getDefaultStore();

let engine: UciEngine;
let bookEngine: UciEngine;
let requests = 0;
const engines = new Map<string, { engine: UciEngine; running: boolean; cancelled: boolean }>();
/** When each analysis ran (E2E_TRACE=1 prints how many engines were busy over time). */
const trace: { start: number; end: number; id: string; depth: number; multipv: number }[] = [];

function printTrace(label: string) {
    if (!process.env.E2E_TRACE || trace.length === 0) return;
    const t0 = Math.min(...trace.map((e) => e.start));
    const t1 = Math.max(...trace.map((e) => e.end));
    const bucket = 2000;
    const rows: string[] = [];
    for (let t = t0; t < t1; t += bucket) {
        const busy = trace.reduce(
            (acc, e) => acc + Math.max(0, Math.min(e.end, t + bucket) - Math.max(e.start, t)),
            0,
        );
        rows.push((busy / bucket).toFixed(1));
    }
    console.log(
        `[trace ${label}] ${((t1 - t0) / 1000).toFixed(1)}s, ${trace.length} analyses, busy engines per 2 s: ${rows.join(" ")}`,
    );
    if (process.env.E2E_TRACE === "full") {
        for (const e of [...trace].sort((a, b) => a.start - b.start)) {
            console.log(
                `  ${((e.start - t0) / 1000).toFixed(1).padStart(5)}s +${((e.end - e.start) / 1000).toFixed(1).padStart(4)}s ${e.id.slice(-2)} d${e.depth} pv${e.multipv}`,
            );
        }
    }
    trace.length = 0;
}

/** The engine of an analysis id, started on first use with the options it was sent. */
function engineOf(id: string, options: { name: string; value: string }[] = []) {
    let known = engines.get(id);
    if (!known) {
        const option = (name: string, fallback: number) =>
            Number(options.find((o) => o.name === name)?.value ?? fallback);
        known = {
            engine: new UciEngine(ENGINE as string, {
                Threads: option("Threads", THREADS),
                Hash: option("Hash", 2048),
            }),
            running: false,
            cancelled: false,
        };
        engines.set(id, known);
    }
    return known;
}

beforeAll(() => {
    if (!ENGINE) return;
    Object.defineProperty(navigator, "hardwareConcurrency", { value: CORES, configurable: true });
    engine = new UciEngine(ENGINE, { Threads: 8, Hash: 256 });
    bookEngine = new UciEngine(ENGINE, { Threads: 2, Hash: 64 });
    const explore = engineBook(bookEngine, START, 3_000_000);
    analyzePosition.mockImplementation(
        async (
            id: string,
            _path: string,
            go: { t: "Depth"; c: number },
            fen: string,
            _moves: string[],
            multipv: number,
            searchMoves: string[],
            options: { name: string; value: string }[],
        ) => {
            const known = engineOf(id, options);
            known.running = true;
            known.cancelled = false;
            const start = Date.now();
            const lines = await known.engine.analyze(fen, go.c, multipv, searchMoves);
            known.running = false;
            trace.push({ start, end: Date.now(), id, depth: go.c, multipv });
            // The backend answers a cancelled analysis with an error, never with half a result.
            return known.cancelled
                ? { status: "error", error: "Analysis cancelled" }
                : { status: "ok", data: lines };
        },
    );
    fetchMock.mockImplementation(async (url: string) => {
        requests++;
        const fen = new URL(url).searchParams.get("fen") ?? START;
        const position = await explore(fen);
        if (EXPLORER_MS > 0) await new Promise((resolve) => setTimeout(resolve, EXPLORER_MS));
        return {
            ok: true,
            status: 200,
            json: async () => ({ ...position, topGames: [], recentGames: [], opening: null }),
        };
    });
    cancelAnalysis.mockImplementation(async (id: string) => {
        const known = engines.get(id);
        if (known?.running) {
            known.cancelled = true;
            known.engine.stop();
        }
        return { status: "ok", data: null };
    });
});

afterAll(() => {
    engine?.quit();
    bookEngine?.quit();
    for (const { engine: e } of engines.values()) e.quit();
});

function configOf(
    over: Partial<ReturnType<typeof bestLineSettingsSchema.parse>> = {},
): SearchConfig {
    return {
        settings: {
            ...bestLineSettingsSchema.parse({}),
            useCloudEval: false,
            depth: PRECISE,
            fastDepth: FAST,
            ...(APP
                ? {}
                : {
                      fullMoves: MOVES,
                      mode: "tree" as const,
                      reachThreshold: REACH,
                      minimumGames: 2000,
                      minGamesPerMove: 30,
                  }),
            ...(OLD ? { toleranceMode: "pawns" as const, minimumGames: 5000 } : {}),
            ...(process.env.E2E_MINGAMES ? { minimumGames: Number(process.env.E2E_MINGAMES) } : {}),
            ...over,
        },
        engine: {
            type: "local",
            id: "e",
            name: "e",
            path: "/engine",
            settings: POOLED
                ? [
                      { name: "Threads", value: THREADS },
                      { name: "Hash", value: 2048 },
                      { name: "MultiPV", value: 5 },
                  ]
                : [],
        } as never,
        explorerOptions: { color: "white" },
    };
}

const finished = (tab: string) =>
    vi.waitFor(() => expect(atoms.get(bestLineRunFamily(tab)).running).toBe(false), {
        timeout: 600_000,
        interval: 200,
    });

test.skipIf(!ENGINE)(
    "a search with a real engine fills the result and the board's tree",
    async () => {
        clearBestLineCaches();
        const tree = createTreeStore();
        tree.setState(defaultTree());
        const unregister = registerTreeStore(TAB, tree);
        const config = configOf();

        void startBestLine(TAB, config, []);
        await finished(TAB);

        const run = atoms.get(bestLineRunFamily(TAB));
        expect(run.error).toBeNull();
        const result = atoms.get(bestLineResultFamily(TAB));
        expect(result?.nodes.length).toBeGreaterThan(0);

        // The line goes its whole length, every move legal after the one before.
        const line = mainLine(result?.nodes ?? []);
        expect(line.length).toBe(config.settings.fullMoves * 2);
        let fen = START;
        for (const node of line) {
            expect(node.fen).toBe(fen);
            const next = playSan(fen, node.san);
            expect({ move: node.san, fen, legal: next !== null }).toEqual({
                move: node.san,
                fen,
                legal: true,
            });
            fen = next?.fen ?? fen;
        }

        printTrace("search");
        // The report accounts for what the engine and the explorer were asked.
        const report = run.report;
        expect(report?.explorer).toBe(requests);
        expect(report?.engine.candidates).toBeGreaterThan(0);
        expect(report?.coverage).toBeGreaterThan(0);
        expect(report?.moves).toBeGreaterThanOrEqual(line.length);
        console.log(
            `[runner] ${report?.seconds.toFixed(1)}s | moves ${report?.moves} | ` +
                `engine ${JSON.stringify(report?.engine)} ${report?.engineSeconds.toFixed(1)}s | explorer ${report?.explorer} in ${report?.explorerSeconds.toFixed(1)}s | ` +
                `coverage ${((report?.coverage ?? 0) * 100).toFixed(0)}% | line ${line.map((n) => n.san).join(" ")}`,
        );

        // The tree of the board received the moves, with their comments.
        const state = tree.getState();
        const first = getNodeAtPath(state.root, []).children[0];
        expect(first?.san).toBe(line[0].san);
        const pgn = getPGN(state.root, {
            headers: state.headers,
            comments: true,
            extraMarkups: true,
            glyphs: true,
            variations: true,
        });
        for (const node of line) expect(pgn).toContain(node.san);
        expect(state.dirty).toBe(true);

        unregister();
        releaseBestLine(TAB);
    },
    900_000,
);

test.skipIf(!ENGINE)(
    "a line can be extended, and a move replaced, from the result",
    async () => {
        clearBestLineCaches();
        const tab = `${TAB}-edit`;
        const tree = createTreeStore();
        tree.setState(defaultTree());
        const unregister = registerTreeStore(tab, tree);
        const config = configOf({ fullMoves: 3, mode: "line" });

        void startBestLine(tab, config, []);
        await finished(tab);
        const before = atoms.get(bestLineResultFamily(tab));
        const length = mainLine(before?.nodes ?? []).length;
        expect(length).toBe(6);

        // Two more moves from the end of the line.
        const end = sansTo(before?.nodes ?? [], [0]).length - 1;
        const path = Array(length).fill(0);
        void extendLine(tab, config, path, 2);
        await finished(tab);
        const extended = atoms.get(bestLineResultFamily(tab));
        expect(atoms.get(bestLineRunFamily(tab)).error).toBeNull();
        expect(mainLine(extended?.nodes ?? []).length).toBe(length + 4);
        expect(end).toBeGreaterThanOrEqual(0);

        // Another first move than the one chosen, and the search goes on from it.
        const root = extended?.nodes[0];
        const other = root?.candidates.find(
            (c) => c.status !== "chosen" && c.status !== "outOfTolerance" && c.stats,
        );
        expect(root && other).toBeTruthy();
        void replayMove(tab, config, [0], other?.san ?? "");
        await finished(tab);
        const replaced = atoms.get(bestLineResultFamily(tab));
        expect(atoms.get(bestLineRunFamily(tab)).error).toBeNull();
        expect(nodeAt(replaced?.nodes ?? [], [0])?.san).toBe(other?.san);
        expect(nodeAt(replaced?.nodes ?? [], [0])?.reason).toBe("manual");

        unregister();
        releaseBestLine(tab);
    },
    900_000,
);

test.skipIf(!ENGINE)(
    "the live analysis chooses a move for the position of the board",
    async () => {
        clearBestLineCaches();
        const key = liveKeyOf(`${TAB}-live`);
        const config = configOf({ liveMoves: 2 });

        await startLiveSearch(key, config, START);

        expect(atoms.get(bestLineRunFamily(key)).error).toBeNull();
        const result = atoms.get(bestLineResultFamily(key));
        // Only the move itself is kept, whatever was looked at to choose it.
        expect(result?.nodes).toHaveLength(1);
        expect(result?.nodes[0].children).toHaveLength(0);
        expect(playSan(START, result?.nodes[0].san ?? "")).not.toBeNull();
        releaseBestLine(`${TAB}-live`);
    },
    900_000,
);

// How long the live analysis takes against a classic search of the same moves
// (E2E_LIVE=1 prints what each spent its time on).
test.skipIf(!ENGINE || !process.env.E2E_LIVE)(
    "the live analysis is not slower than a search for the same moves",
    async () => {
        const line = (label: string, key: string) => {
            const run = atoms.get(bestLineRunFamily(key));
            const r = run.report;
            console.log(
                `[${label}] ${r?.seconds.toFixed(1)}s | engine ${JSON.stringify(r?.engine)} ${r?.engineSeconds.toFixed(1)}s | explorer ${r?.explorer} | opened ${r?.expanded}`,
            );
        };
        for (const liveMoves of [1, 2]) {
            clearBestLineCaches();
            const key = liveKeyOf(`${TAB}-live${liveMoves}`);
            await startLiveSearch(key, configOf({ liveMoves }), START);
            line(`live, ${liveMoves} move(s) looked ahead`, key);
            releaseBestLine(`${TAB}-live${liveMoves}`);
        }
        for (const fullMoves of [1, 2]) {
            clearBestLineCaches();
            const tab = `${TAB}-classic${fullMoves}`;
            const tree = createTreeStore();
            tree.setState(defaultTree());
            const unregister = registerTreeStore(tab, tree);
            void startBestLine(tab, configOf({ fullMoves, mode: "line" }), []);
            await finished(tab);
            line(`classic, ${fullMoves} move(s), line mode`, tab);
            unregister();
            releaseBestLine(tab);
        }
    },
    900_000,
);

test.skipIf(!ENGINE)(
    "stopping a search returns promptly, without an error, and leaves the engine usable",
    async () => {
        clearBestLineCaches();
        const tab = `${TAB}-stop`;
        const tree = createTreeStore();
        tree.setState(defaultTree());
        const unregister = registerTreeStore(tab, tree);
        // A search that would run for minutes.
        const config = configOf({ reachThreshold: 0.002, fullMoves: 8, depth: PRECISE + 4 });

        void startBestLine(tab, config, []);
        await vi.waitFor(
            () => expect(atoms.get(bestLineRunFamily(tab)).positions).toBeGreaterThan(2),
            {
                timeout: 120_000,
                interval: 100,
            },
        );
        const stopped = Date.now();
        cancelBestLine(tab);
        await finished(tab);

        // The analysis running at that moment is the one the engine finishes: seconds, not minutes.
        expect((Date.now() - stopped) / 1000).toBeLessThan(30);
        expect(atoms.get(bestLineRunFamily(tab)).error).toBeNull();
        // What was found is kept.
        expect(atoms.get(bestLineResultFamily(tab))?.nodes.length).toBeGreaterThan(0);
        // And the engine answers the next question.
        const lines = await engineOf(`bestline_${tab}`).engine.analyze(START, 8, 1);
        expect(lines).toHaveLength(1);

        unregister();
        releaseBestLine(tab);
    },
    900_000,
);
