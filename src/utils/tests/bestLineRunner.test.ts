import { getDefaultStore } from "jotai";
import { beforeEach, expect, test, vi } from "vitest";
import {
    bestLinePanelTabFamily,
    bestLineResultFamily,
    bestLineRunFamily,
    idleBestLineRun,
} from "@/state/atoms";
import { createTreeStore } from "@/state/store/tree";
import { bestLineSettingsSchema } from "@/utils/bestLine";
import { defaultTree } from "@/utils/treeReducer";
import {
    createAnalyze,
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
            "local engine: 17 analyses in 23 s (fast depth 14: 9 position evaluations; " +
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

test("the analysis cache ignores the move number of a position", async () => {
    const config = analyzeConfig();
    const analyze = createAnalyze("tab-cache", config, newSearchReport(config.settings));
    analyzePosition.mockResolvedValue({ status: "ok", data: [] });

    await analyze(INITIAL, { purpose: "candidates" });
    await analyze("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 9", {
        purpose: "candidates",
    });

    expect(analyzePosition).toHaveBeenCalledTimes(1);
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
        id === `bestline_${MAIN}` ? new Promise(() => {}) : book(id, ...args),
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
