import { getDefaultStore } from "jotai";
import { beforeEach, expect, test, vi } from "vitest";
import {
    bestLinePanelTabFamily,
    bestLineResultFamily,
    bestLineRunFamily,
    idleBestLineRun,
} from "@/state/atoms";
import { commands } from "@/bindings";
import { createTreeStore } from "@/state/store/tree";
import { type BestLineNode, bestLineSettingsSchema } from "@/utils/bestLine";
import { defaultTree } from "@/utils/treeReducer";
import { LichessHttpError } from "@/utils/lichess/api";
import {
    cancelBestLine,
    createAnalyze,
    extendLine,
    isTransientExplorerError,
    formatSearchReport,
    newSearchReport,
    registerTreeStore,
    releaseBestLine,
    resetBestLine,
    type SearchConfig,
    liveKeyOf,
    resetLiveSearch,
    startBestLine,
    startLiveSearch,
    stopLiveSearch,
} from "@/components/bestLine/runner";
import { clearBestLineCaches } from "@/utils/bestLineCache";

const { analyzePosition, fetchMock } = vi.hoisted(() => ({
    analyzePosition: vi.fn(),
    fetchMock: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: fetchMock }));
vi.mock("@tauri-apps/plugin-log", () => ({ error: vi.fn(), info: vi.fn() }));
vi.mock("@/bindings", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/bindings")>()),
    commands: {
        analyzePosition,
        cancelAnalysis: vi.fn(async () => ({ status: "ok", data: null })),
        closeAnalysisSession: vi.fn(async () => ({ status: "ok", data: null })),
    },
}));

const TAB = "tab-reset";
const atoms = getDefaultStore();
const tree = createTreeStore();

const result = {
    fen: defaultTree().root.fen,
    color: "black" as const,
    metric: "score" as const,
    startPath: [],
    nodes: [],
    inserted: true,
    focus: [0],
};

beforeEach(() => {
    releaseBestLine(TAB);
    clearBestLineCaches();
    vi.clearAllMocks();
    tree.setState({
        ...defaultTree("8/8/8/4k3/8/8/4K3/7R w - - 0 1"),
        dirty: true,
        headers: { ...defaultTree().headers, orientation: "black", white: "Me" },
    });
    tree.getState().makeMove({ payload: "Rh5+" });
    registerTreeStore(TAB, tree);
    atoms.set(bestLineResultFamily(TAB), result);
    atoms.set(bestLineRunFamily(TAB), { ...idleBestLineRun, positions: 12, error: "boom" });
    atoms.set(bestLinePanelTabFamily(TAB), "result");
});

test("resetBestLine clears the result, the search state and the moves", () => {
    expect(resetBestLine(TAB)).toBe(true);

    expect(atoms.get(bestLineResultFamily(TAB))).toBeNull();
    expect(atoms.get(bestLineRunFamily(TAB))).toEqual(idleBestLineRun);
    expect(atoms.get(bestLinePanelTabFamily(TAB))).toBe("settings");

    const state = tree.getState();
    expect(state.root).toEqual(defaultTree().root);
    expect(state.position).toEqual([]);
    expect(state.dirty).toBe(false);
    expect(state.headers.white).toBe("");
});

test("resetBestLine keeps the board orientation (the studied side)", () => {
    resetBestLine(TAB);
    expect(tree.getState().headers.orientation).toBe("black");
});

test("resetBestLine does nothing while a search is running", async () => {
    // Neither the engine nor the explorer ever answer: the search keeps running.
    analyzePosition.mockReturnValue(new Promise(() => {}));
    fetchMock.mockReturnValue(new Promise(() => {}));
    const config: SearchConfig = {
        settings: { ...bestLineSettingsSchema.parse({}), useCloudEval: false },
        engine: { type: "local", id: "e", name: "e", path: "/e", settings: [] } as never,
        explorerOptions: { color: "white" },
    };
    void startBestLine(TAB, config, []);
    await vi.waitFor(() => expect(atoms.get(bestLineRunFamily(TAB)).running).toBe(true));
    const before = tree.getState().root;

    expect(resetBestLine(TAB)).toBe(false);
    expect(atoms.get(bestLineRunFamily(TAB)).running).toBe(true);
    expect(tree.getState().root).toBe(before);
});

// --- search report -----------------------------------------------------------

const INITIAL = defaultTree().root.fen;
const AFTER_E4_E5 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";

function bestMoves(san: string, uci: string, depth: number): { status: "ok"; data: unknown } {
    return {
        status: "ok",
        data: [
            {
                depth,
                multipv: 1,
                nodes: 0,
                nps: 0,
                score: { value: { type: "cp", value: 30 }, wdl: null },
                sanMoves: [san],
                uciMoves: [uci],
            },
        ],
    };
}

/** Explorer answer with enough games for the search to follow the statistics. */
function explorerPosition(san: string, uci: string) {
    return {
        ok: true,
        status: 200,
        json: async () => ({
            white: 3000,
            draws: 2000,
            black: 3000,
            moves: [{ san, uci, white: 3000, draws: 2000, black: 3000 }],
            topGames: [],
            recentGames: [],
            opening: null,
        }),
    };
}

const REPORT_TAB = "tab-report";

test("the search report counts the engine analyses by purpose and depth", async () => {
    const reportTree = createTreeStore();
    reportTree.setState(defaultTree());
    const unregister = registerTreeStore(REPORT_TAB, reportTree);
    fetchMock.mockImplementation(async (url: string) =>
        decodeURIComponent(url).includes("4P3")
            ? explorerPosition("e5", "e7e5")
            : explorerPosition("e4", "e2e4"),
    );
    // Fast analyses answer at the fast depth, precise ones at the precise depth.
    analyzePosition.mockImplementation(
        async (_id: string, _path: string, goMode: { t: "Depth"; c: number }, fen: string) =>
            bestMoves(
                fen === INITIAL ? "e4" : fen === AFTER_E4 ? "e5" : "Nf3",
                fen === INITIAL ? "e2e4" : fen === AFTER_E4 ? "e7e5" : "g1f3",
                goMode.c,
            ),
    );
    const config: SearchConfig = {
        settings: {
            ...bestLineSettingsSchema.parse({}),
            useCloudEval: false,
            fullMoves: 1,
            minimumGames: 5000,
        },
        engine: { type: "local", id: "e", name: "e", path: "/e", settings: [] } as never,
        explorerOptions: { color: "white" },
    };

    void startBestLine(REPORT_TAB, config, []);
    await vi.waitFor(() => expect(atoms.get(bestLineRunFamily(REPORT_TAB)).running).toBe(false));

    const report = atoms.get(bestLineRunFamily(REPORT_TAB)).report!;
    expect(report.engine).toEqual({
        // One candidate list for our move, at the precise depth; the opponent's
        // reply comes from the explorer alone, and the position the line ends
        // on is evaluated once, quickly.
        candidates: 1,
        evaluation: 1,
        decision: 0,
    });
    expect(report).toMatchObject({
        moves: 2,
        cloud: 0,
        cached: 0,
        explorer: 2,
        expanded: 2,
        fastDepth: config.settings.fastDepth,
        preciseDepth: config.settings.depth,
    });
    expect(report.coverage).toBeGreaterThan(0.9);
    unregister();
    releaseBestLine(REPORT_TAB);
});

test("a search lives through an explorer request that fails once", async () => {
    const tab = "tab-flaky";
    const flakyTree = createTreeStore();
    flakyTree.setState(defaultTree());
    const unregister = registerTreeStore(tab, flakyTree);
    let failed = false;
    fetchMock.mockImplementation(async (url: string) => {
        if (!failed) {
            failed = true;
            throw new Error("connection reset");
        }
        return decodeURIComponent(url).includes("4P3")
            ? explorerPosition("e5", "e7e5")
            : explorerPosition("e4", "e2e4");
    });
    analyzePosition.mockImplementation(
        async (_id: string, _path: string, goMode: { t: "Depth"; c: number }, fen: string) =>
            bestMoves(
                fen === INITIAL ? "e4" : fen === AFTER_E4 ? "e5" : "Nf3",
                fen === INITIAL ? "e2e4" : fen === AFTER_E4 ? "e7e5" : "g1f3",
                goMode.c,
            ),
    );
    const config: SearchConfig = {
        settings: { ...bestLineSettingsSchema.parse({}), useCloudEval: false, fullMoves: 1 },
        engine: { type: "local", id: "e", name: "e", path: "/e", settings: [] } as never,
        explorerOptions: { color: "white" },
    };

    void startBestLine(tab, config, []);
    await vi.waitFor(() => expect(atoms.get(bestLineRunFamily(tab)).running).toBe(false), {
        timeout: 10_000,
    });

    expect(atoms.get(bestLineRunFamily(tab)).error).toBeNull();
    expect(atoms.get(bestLineResultFamily(tab))?.nodes.length).toBeGreaterThan(0);
    unregister();
    releaseBestLine(tab);
});

test("a dropped connection or a server error is worth trying again, a refusal is not", () => {
    expect(isTransientExplorerError(new Error("connection reset"))).toBe(true);
    expect(isTransientExplorerError(new LichessHttpError("down", 503))).toBe(true);
    expect(isTransientExplorerError(new LichessHttpError("timeout", 408))).toBe(true);
    expect(isTransientExplorerError(new LichessHttpError("no token", 401))).toBe(false);
    expect(isTransientExplorerError(new LichessHttpError("bad request", 400))).toBe(false);
    // Rate limits have their own, longer wait.
    expect(isTransientExplorerError(new LichessHttpError("slow down", 429))).toBe(false);
});

test("stopping a search while the engine works is not an error and keeps what was found", async () => {
    const tab = "tab-stop";
    const stopTree = createTreeStore();
    stopTree.setState(defaultTree());
    const unregister = registerTreeStore(tab, stopTree);
    fetchMock.mockImplementation(async () => explorerPosition("e4", "e2e4"));
    // The engine takes its time, and answers with an error once it is told to stop.
    const pending: ((answer: unknown) => void)[] = [];
    analyzePosition.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    vi.mocked(commands.cancelAnalysis).mockImplementation(async () => {
        for (const resolve of pending.splice(0)) {
            resolve({ status: "error", error: "Analysis cancelled" });
        }
        return { status: "ok", data: null };
    });
    const config: SearchConfig = {
        settings: { ...bestLineSettingsSchema.parse({}), useCloudEval: false, fullMoves: 2 },
        engine: { type: "local", id: "e", name: "e", path: "/e", settings: [] } as never,
        explorerOptions: { color: "white" },
    };

    void startBestLine(tab, config, []);
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
    cancelBestLine(tab);
    await vi.waitFor(() => expect(atoms.get(bestLineRunFamily(tab)).running).toBe(false));

    // Nothing to show an alert about: the user asked for it.
    expect(atoms.get(bestLineRunFamily(tab)).error).toBeNull();
    unregister();
    releaseBestLine(tab);
});

test("formatSearchReport spells out where the search spent its time", () => {
    expect(
        formatSearchReport({
            seconds: 42.4,
            moves: 11,
            fastDepth: 14,
            preciseDepth: 18,
            cached: 12,
            cloud: 31,
            engine: { candidates: 6, evaluation: 9, decision: 2 },
            engineSeconds: 23.2,
            explorer: 24,
            explorerSeconds: 3.4,
            expanded: 120,
            pruned: 8,
            lowReach: 44,
            outOfBook: 3,
            coverage: 0.86,
            exhausted: false,
        }),
    ).toBe(
        "Best line search: 42 s for 11 moves | " +
            "local engine: 17 analyses, 23 s of engine time (fast depth 14: 9 position evaluations; " +
            "precise depth 18: 6 candidate lists, 2 engine decisions) | " +
            "Lichess cloud: 31 analyses, 12 reused from the cache | " +
            "Lichess explorer: 24 requests in 3 s | " +
            "search: 120 positions opened, 8 candidates dropped, 44 replies left closed, " +
            "3 out of book, covering 86% of the games",
    );
});

// --- engine analyses ---------------------------------------------------------

function analyzeConfig(): SearchConfig {
    return {
        settings: { ...bestLineSettingsSchema.parse({}), useCloudEval: false },
        engine: { type: "local", id: "e", name: "e", path: "/e", settings: [] } as never,
        explorerOptions: { color: "white" },
    };
}

test("an analysis restricted to some moves never asks for more lines than them", async () => {
    const config = analyzeConfig();
    const analyze = createAnalyze("tab-analyze", config, newSearchReport(config.settings));
    analyzePosition.mockResolvedValue({ status: "ok", data: [] });

    await analyze(INITIAL, { purpose: "candidates", multipv: 5, searchMoves: ["e2e4", "d2d4"] });

    // Asking for 5 lines on 2 moves waits for lines the engine never sends.
    const [, , , , , multipv, searchMoves] = analyzePosition.mock.calls[0];
    expect(multipv).toBe(2);
    expect(searchMoves).toEqual(["e2e4", "d2d4"]);
});

test("the engine runs one analysis at a time for a tab", async () => {
    const config = analyzeConfig();
    const analyze = createAnalyze("tab-serial", config, newSearchReport(config.settings));
    const started: string[] = [];
    let release: (() => void) | null = null;
    analyzePosition.mockImplementation(
        async (_id: string, _p: string, _g: unknown, fen: string) => {
            started.push(fen);
            if (!release) await new Promise<void>((resolve) => (release = resolve));
            return { status: "ok", data: [] };
        },
    );

    const first = analyze(INITIAL, { purpose: "candidates" });
    const second = analyze(AFTER_E4, { purpose: "candidates" });
    await vi.waitFor(() => expect(started).toEqual([INITIAL]));

    release!();
    await Promise.all([first, second]);
    expect(started).toEqual([INITIAL, AFTER_E4]);
});

test("analyses queued behind a cancelled one never reach the engine", async () => {
    const config = analyzeConfig();
    let cancelled = false;
    const analyze = createAnalyze(
        "tab-cancel",
        config,
        newSearchReport(config.settings),
        () => cancelled,
    );
    const started: string[] = [];
    let release: (() => void) | null = null;
    analyzePosition.mockImplementation(
        async (_id: string, _p: string, _g: unknown, fen: string) => {
            started.push(fen);
            await new Promise<void>((resolve) => (release = resolve));
            return { status: "error", error: "cancelled" };
        },
    );

    const first = analyze(INITIAL, { purpose: "candidates" }).catch(() => {});
    const second = analyze(AFTER_E4, { purpose: "candidates" }).catch(() => {});
    await vi.waitFor(() => expect(started).toEqual([INITIAL]));
    cancelled = true;
    release!();
    await Promise.all([first, second]);

    expect(started).toEqual([INITIAL]);
});

test("an analysis that returned no line is not kept in the cache", async () => {
    const config = analyzeConfig();
    const analyze = createAnalyze("tab-empty", config, newSearchReport(config.settings));
    analyzePosition.mockResolvedValue({ status: "ok", data: [] });

    await analyze(INITIAL, { purpose: "candidates" });
    await analyze(INITIAL, { purpose: "candidates" });

    expect(analyzePosition).toHaveBeenCalledTimes(2);
});

test("the analysis cache ignores the move number of a position", async () => {
    const config = analyzeConfig();
    const analyze = createAnalyze("tab-cache", config, newSearchReport(config.settings));
    analyzePosition.mockResolvedValue({ status: "ok", data: [{ depth: 10 }] });

    await analyze(INITIAL, { purpose: "candidates" });
    await analyze("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 9", {
        purpose: "candidates",
    });

    expect(analyzePosition).toHaveBeenCalledTimes(1);
});

// --- extending a line --------------------------------------------------------

const AFTER_E4_E5_NF3 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2";

function seededNode(san: string, fen: string, color: "white" | "black", children: BestLineNode[]) {
    return {
        san,
        uci: san,
        color,
        fen,
        reason: "score",
        reach: 1,
        candidates: [],
        children,
    } as BestLineNode;
}

test("extending a line adds one line of moves, even where the opponent has several frequent replies", async () => {
    const tab = "tab-extend";
    const extendTree = createTreeStore();
    extendTree.setState(defaultTree());
    const unregister = registerTreeStore(tab, extendTree);
    // After 1.e4 e5 2.Nf3, Black plays Nc6 and Nf6 about as often: a tree would follow both.
    const move = (san: string, uci: string, games: number) => ({
        san,
        uci,
        white: games * 0.4,
        draws: games * 0.2,
        black: games * 0.4,
    });
    const answer = (moves: ReturnType<typeof move>[]) => ({
        ok: true,
        status: 200,
        json: async () => ({
            white: 4000,
            draws: 2000,
            black: 4000,
            moves,
            topGames: [],
            recentGames: [],
            opening: null,
        }),
    });
    fetchMock.mockImplementation(async (url: string) =>
        decodeURIComponent(url).includes("4P3/5N2")
            ? answer([move("Nc6", "b8c6", 5000), move("Nf6", "g8f6", 5000)])
            : answer([move("Nf3", "g1f3", 10000)]),
    );
    analyzePosition.mockImplementation(
        async (_id: string, _path: string, goMode: { t: "Depth"; c: number }, fen: string) =>
            fen === AFTER_E4_E5
                ? bestMoves("Nf3", "g1f3", goMode.c)
                : bestMoves("Nc6", "b8c6", goMode.c),
    );
    const config: SearchConfig = {
        settings: {
            ...bestLineSettingsSchema.parse({}),
            useCloudEval: false,
            mode: "tree",
            minimumGames: 5000,
        },
        engine: { type: "local", id: "e", name: "e", path: "/e", settings: [] } as never,
        explorerOptions: { color: "white" },
    };
    const line = seededNode("e4", INITIAL, "white", [seededNode("e5", AFTER_E4, "black", [])]);
    atoms.set(bestLineResultFamily(tab), {
        ...result,
        color: "white",
        nodes: [line],
        inserted: true,
    });

    void extendLine(tab, config, [0, 0], 1);
    await vi.waitFor(() => expect(atoms.get(bestLineRunFamily(tab)).running).toBe(false), {
        timeout: 10_000,
    });

    expect(atoms.get(bestLineRunFamily(tab)).error).toBeNull();
    const nodes = atoms.get(bestLineResultFamily(tab))?.nodes ?? [];
    const added = nodes[0].children[0].children;
    expect(added.map((n) => n.san)).toEqual(["Nf3"]);
    // One reply, the most played: no second line under it.
    expect(added[0].children.map((n) => n.san)).toHaveLength(1);
    unregister();
    releaseBestLine(tab);
});

// --- several engines ---------------------------------------------------------

/** An engine with threads to share: on a 16-thread machine, 4 engines of 4 threads. */
function manyThreadsConfig(): SearchConfig {
    const config = analyzeConfig();
    return {
        ...config,
        engine: {
            ...config.engine,
            settings: [
                { name: "Threads", value: 16 },
                { name: "Hash", value: 2048 },
                { name: "MultiPV", value: 5 },
            ],
        } as never,
    };
}

const FENS = [
    INITIAL,
    AFTER_E4,
    AFTER_E4_E5,
    "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1",
    "rnbqkbnr/pppppppp/8/8/2P5/8/PP1PPPPP/RNBQKBNR b KQkq - 0 1",
];

/** Analyses that wait for `release()`, recording which engine took which position. */
function heldEngines() {
    const started: { id: string; fen: string; options: { name: string; value: string }[] }[] = [];
    const releases: (() => void)[] = [];
    analyzePosition.mockImplementation(
        async (
            id: string,
            _p: string,
            _g: unknown,
            fen: string,
            _m: unknown,
            _pv: number,
            _s: unknown,
            options: { name: string; value: string }[],
        ) => {
            started.push({ id, fen, options });
            await new Promise<void>((resolve) => releases.push(resolve));
            return { status: "ok", data: [] };
        },
    );
    return { started, releaseAll: () => releases.splice(0).forEach((r) => r()) };
}

test("an engine with threads to share runs several analyses side by side, on engines of their own", async () => {
    const config = manyThreadsConfig();
    const analyze = createAnalyze(
        "tab-pool",
        config,
        newSearchReport(config.settings),
        undefined,
        16,
    );
    const held = heldEngines();

    const all = FENS.map((fen) => analyze(fen, { purpose: "candidates" }));
    await vi.waitFor(() => expect(held.started).toHaveLength(4));

    // One engine per worker, the first keeping the tab's engine name.
    expect(held.started.map((s) => s.id).sort()).toEqual([
        "bestline_tab-pool",
        "bestline_tab-pool#1",
        "bestline_tab-pool#2",
        "bestline_tab-pool#3",
    ]);
    // Each gets a quarter of the threads and of the hash.
    for (const { options } of held.started) {
        expect(options.find((o) => o.name === "Threads")?.value).toBe("4");
        expect(options.find((o) => o.name === "Hash")?.value).toBe("512");
        expect(options.find((o) => o.name === "MultiPV")?.value).toBe("5");
    }
    // The fifth waits for an engine to be free.
    expect(held.started.map((s) => s.fen)).toEqual(FENS.slice(0, 4));
    held.releaseAll();
    await vi.waitFor(() => expect(held.started).toHaveLength(5));
    held.releaseAll();
    await Promise.all(all);
});

test("an engine's own settings stand when it has no threads to share", async () => {
    const config = analyzeConfig();
    const analyze = createAnalyze(
        "tab-single",
        config,
        newSearchReport(config.settings),
        undefined,
        16,
    );
    const held = heldEngines();

    const all = [
        analyze(FENS[0], { purpose: "candidates" }),
        analyze(FENS[1], { purpose: "candidates" }),
    ];
    await vi.waitFor(() => expect(held.started).toHaveLength(1));
    expect(held.started[0].id).toBe("bestline_tab-single");
    held.releaseAll();
    await vi.waitFor(() => expect(held.started).toHaveLength(2));
    held.releaseAll();
    await Promise.all(all);
});

test("warm starts an analysis on a spare engine, and the search's own request shares it", async () => {
    const config = manyThreadsConfig();
    const analyze = createAnalyze(
        "tab-warm",
        config,
        newSearchReport(config.settings),
        undefined,
        16,
    );
    const held = heldEngines();

    const ahead = analyze.warm(FENS[1], { purpose: "candidates", multipv: 5 });
    expect(ahead).toBeInstanceOf(Promise);
    await vi.waitFor(() => expect(held.started).toHaveLength(1));
    // The search asks for it later: it is the same analysis, not a second one.
    const own = analyze(FENS[1], { purpose: "candidates", multipv: 5 });
    expect(analyze.warm(FENS[1], { purpose: "candidates", multipv: 5 })).toBe(ahead);
    held.releaseAll();
    expect(await own).toBe(await ahead);
    expect(analyzePosition).toHaveBeenCalledTimes(1);
});

test("warm leaves one engine to the search", async () => {
    const config = manyThreadsConfig();
    const analyze = createAnalyze(
        "tab-spare",
        config,
        newSearchReport(config.settings),
        undefined,
        16,
    );
    const held = heldEngines();

    const answers = FENS.slice(0, 4).map((fen) => analyze.warm(fen, { purpose: "candidates" }));
    expect(answers.map((answer) => answer !== false)).toEqual([true, true, true, false]);
    await vi.waitFor(() => expect(held.started).toHaveLength(3));

    // The search's own request starts at once on the engine kept for it.
    const own = analyze(FENS[3], { purpose: "candidates" });
    await vi.waitFor(() => expect(held.started).toHaveLength(4));
    held.releaseAll();
    await own;
});

test("warm does nothing for an engine that runs alone", () => {
    const config = analyzeConfig();
    const analyze = createAnalyze(
        "tab-alone",
        config,
        newSearchReport(config.settings),
        undefined,
        16,
    );
    expect(analyze.warm(FENS[0], { purpose: "candidates" })).toBe(false);
    expect(analyzePosition).not.toHaveBeenCalled();
});

test("stopping the analyses stops the engines still working ahead, and starts no more", async () => {
    const config = manyThreadsConfig();
    const analyze = createAnalyze(
        "tab-ahead",
        config,
        newSearchReport(config.settings),
        undefined,
        16,
    );
    const held = heldEngines();
    analyze.warm(FENS[1], { purpose: "candidates" });
    await vi.waitFor(() => expect(held.started).toHaveLength(1));
    vi.mocked(commands.cancelAnalysis).mockClear();

    await analyze.stop();

    expect(commands.cancelAnalysis).toHaveBeenCalledWith(held.started[0].id);
    expect(commands.cancelAnalysis).toHaveBeenCalledTimes(1);
    expect(analyze.warm(FENS[2], { purpose: "candidates" })).toBe(false);
    held.releaseAll();
});

test("releasing a tab closes every engine of its search", () => {
    releaseBestLine("tab-close");
    for (const id of ["", "#1", "#2", "#3"]) {
        expect(commands.closeAnalysisSession).toHaveBeenCalledWith(`bestline_tab-close${id}`);
    }
});

// --- live analysis -----------------------------------------------------------

function liveConfig(): SearchConfig {
    return {
        settings: { ...bestLineSettingsSchema.parse({}), useCloudEval: false, minimumGames: 5000 },
        engine: { type: "local", id: "e", name: "e", path: "/e", settings: [] } as never,
        explorerOptions: { color: "white" },
    };
}

function mockBook() {
    fetchMock.mockImplementation(async (url: string) => {
        const fen = decodeURIComponent(url);
        if (fen.includes("4p3/4P3")) return explorerPosition("Nf3", "g1f3");
        return fen.includes("4P3")
            ? explorerPosition("e5", "e7e5")
            : explorerPosition("e4", "e2e4");
    });
    analyzePosition.mockImplementation(
        async (_id: string, _path: string, goMode: { t: "Depth"; c: number }, fen: string) =>
            bestMoves(
                fen === INITIAL ? "e4" : fen === AFTER_E4 ? "e5" : "Nf3",
                fen === INITIAL ? "e2e4" : fen === AFTER_E4 ? "e7e5" : "g1f3",
                goMode.c,
            ),
    );
}

test("a live search keeps its own result, apart from the tab's", async () => {
    mockBook();
    const key = liveKeyOf(TAB);
    await startLiveSearch(key, liveConfig(), INITIAL);

    const live = atoms.get(bestLineResultFamily(key));
    expect(live?.fen).toBe(INITIAL);
    // The studied side (white) is to move: the search is one move deep.
    expect(live?.nodes.map((n) => n.san)).toEqual(["e4"]);
    // The moves looked at beyond it only served to choose it.
    expect(live?.nodes[0].children).toEqual([]);
    expect(atoms.get(bestLineResultFamily(TAB))).toEqual(result);
    expect(atoms.get(bestLineRunFamily(key)).running).toBe(false);
    stopLiveSearch(key);
});

test("a live search chooses its move at the precise depth and judges it quickly", async () => {
    mockBook();
    const key = liveKeyOf(TAB);
    resetLiveSearch(key);
    vi.clearAllMocks();
    const config = liveConfig();
    await startLiveSearch(
        key,
        { ...config, settings: { ...config.settings, liveMoves: 2 } },
        INITIAL,
    );

    const asked = analyzePosition.mock.calls.map((call) => [
        call[3] as string,
        (call[2] as { c: number }).c,
    ]);
    // The first move is chosen among precise candidates...
    expect(asked).toContainEqual([INITIAL, config.settings.depth]);
    // ...the position it leads to is looked at for the next one, quickly...
    expect(asked).toContainEqual([AFTER_E4_E5, config.settings.fastDepth]);
    // ...and nothing is evaluated for the sake of the moves beyond, which are not shown.
    expect(asked.map(([fen]) => fen)).not.toContain(AFTER_E4_E5_NF3);
    stopLiveSearch(key);
});

test("a live search counts its quick looks with the fast evaluations", async () => {
    mockBook();
    const key = liveKeyOf(TAB);
    resetLiveSearch(key);
    await startLiveSearch(key, liveConfig(), INITIAL);

    const { engine } = atoms.get(bestLineRunFamily(key)).report!;
    expect(engine.evaluation).toBeGreaterThan(0);
    expect(Object.values(engine).every((n) => Number.isFinite(n))).toBe(true);
    stopLiveSearch(key);
});

// --- the live move on the board ----------------------------------------------

/** A tab whose board shows the starting position, and its live search key. */
function liveBoard(tab: string) {
    const board = createTreeStore();
    board.setState(defaultTree());
    const unregister = registerTreeStore(tab, board);
    return { board, key: liveKeyOf(tab), done: () => (unregister(), releaseBestLine(tab)) };
}

test("a live search adds the move it chose to the line the board is on", async () => {
    mockBook();
    const { board, key, done } = liveBoard("tab-live-add");

    await startLiveSearch(key, liveConfig(), INITIAL);

    const state = board.getState();
    expect(state.root.children.map((n) => n.san)).toEqual(["e4"]);
    // The board goes to the move, where the opponent is to answer.
    expect(state.position).toEqual([0]);
    expect(state.root.children[0].comment).not.toBe("");
    expect(state.dirty).toBe(true);
    done();
});

test("a live search adds its move where the board is in a variation, not to the main line", async () => {
    mockBook();
    const { board, key, done } = liveBoard("tab-live-variation");
    // 1.d4 is on the board's main line; the board is back at the start, on 1.c4 instead.
    board.getState().makeMove({ payload: "d4" });
    board.getState().goToStart();
    board.getState().makeMove({ payload: "c4" });
    board.getState().goToStart();
    const before = board.getState().root.children.length;
    expect(before).toBe(2);

    // The start of the game has a continuation already: nothing is added.
    await startLiveSearch(key, liveConfig(), INITIAL);
    expect(board.getState().root.children.map((n) => n.san)).toEqual(["d4", "c4"]);
    done();
});

test("a live search adds nothing when asked not to", async () => {
    mockBook();
    const { board, key, done } = liveBoard("tab-live-off");
    const config = liveConfig();

    await startLiveSearch(
        key,
        { ...config, settings: { ...config.settings, liveAddMove: false } },
        INITIAL,
    );

    expect(board.getState().root.children).toHaveLength(0);
    expect(atoms.get(bestLineResultFamily(key))?.nodes[0].san).toBe("e4");
    done();
});

test("a live search adds nothing once the board has moved on", async () => {
    mockBook();
    const { board, key, done } = liveBoard("tab-live-moved");
    // The search is started for the starting position, then the board goes to another one.
    fetchMock.mockImplementation(async (url: string) => {
        board.getState().makeMove({ payload: "Nf3" });
        return decodeURIComponent(url).includes("4P3")
            ? explorerPosition("e5", "e7e5")
            : explorerPosition("e4", "e2e4");
    });

    await startLiveSearch(key, liveConfig(), INITIAL);

    expect(board.getState().root.children.map((n) => n.san)).toEqual(["Nf3"]);
    done();
});

test("a live search that was stopped adds nothing", async () => {
    mockBook();
    const { board, key, done } = liveBoard("tab-live-stopped");

    const search = startLiveSearch(key, liveConfig(), INITIAL);
    stopLiveSearch(key);
    await search;

    expect(board.getState().root.children).toHaveLength(0);
    done();
});

test("a live search waits for the studied side's turn", async () => {
    mockBook();
    const key = liveKeyOf(TAB);
    resetLiveSearch(key);
    vi.clearAllMocks();
    await startLiveSearch(key, liveConfig(), AFTER_E4);

    // Black is to move and white is studied: nothing is searched.
    expect(atoms.get(bestLineResultFamily(key))).toBeNull();
    expect(analyzePosition).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
});

test("resetLiveSearch forgets the result and starts over from nothing", async () => {
    mockBook();
    const key = liveKeyOf(TAB);
    await startLiveSearch(key, liveConfig(), INITIAL);
    expect(atoms.get(bestLineResultFamily(key))).not.toBeNull();
    const asked = analyzePosition.mock.calls.length;

    resetLiveSearch(key);
    expect(atoms.get(bestLineResultFamily(key))).toBeNull();
    expect(atoms.get(bestLineRunFamily(key))).toEqual(idleBestLineRun);

    // Nothing is reused: the same position is analysed again.
    await startLiveSearch(key, liveConfig(), INITIAL);
    expect(analyzePosition.mock.calls.length).toBeGreaterThan(asked);
    stopLiveSearch(key);
});

test("a live search runs while the tab's own search is running", async () => {
    const MAIN = "tab-live-main";
    const unregister = registerTreeStore(MAIN, createTreeStore());
    mockBook();
    const book = analyzePosition.getMockImplementation()!;
    // The tab's own engine never answers, the live one does.
    analyzePosition.mockImplementation(async (id: string, ...args: unknown[]) =>
        id.startsWith(`bestline_${MAIN}`) && !id.includes("-live")
            ? new Promise(() => {})
            : book(id, ...args),
    );
    void startBestLine(MAIN, liveConfig(), []);
    await vi.waitFor(() => expect(atoms.get(bestLineRunFamily(MAIN)).running).toBe(true));

    // Another engine, so that nothing it computes is shared with the hung search.
    const other = {
        ...liveConfig(),
        engine: { ...liveConfig().engine, id: "live", path: "/live" },
    };
    await startLiveSearch(liveKeyOf(MAIN), other, INITIAL);
    expect(atoms.get(bestLineResultFamily(liveKeyOf(MAIN)))?.nodes).toHaveLength(1);
    expect(atoms.get(bestLineRunFamily(MAIN)).running).toBe(true);
    stopLiveSearch(liveKeyOf(MAIN));
    unregister();
    releaseBestLine(MAIN);
});

test("a newer live search replaces the one still running", async () => {
    mockBook();
    const key = liveKeyOf(TAB);
    const first = startLiveSearch(key, liveConfig(), INITIAL);
    const second = startLiveSearch(key, liveConfig(), AFTER_E4_E5);
    await Promise.all([first, second]);

    expect(atoms.get(bestLineResultFamily(key))?.fen).toBe(AFTER_E4_E5);
    stopLiveSearch(key);
});

function engineCallsFor(key: string) {
    return analyzePosition.mock.calls.filter(([id]) => id === `bestline_${key}`).length;
}

test("a live search looks as far ahead as asked, to choose its move", async () => {
    mockBook();
    const key = liveKeyOf(TAB);
    const settings = { ...liveConfig().settings, liveMoves: 1 };
    await startLiveSearch(key, { ...liveConfig(), settings }, INITIAL);
    const short = engineCallsFor(key);

    await startLiveSearch(key, liveConfig(), INITIAL);
    expect(engineCallsFor(key)).toBeGreaterThan(short);
    stopLiveSearch(key);
});
