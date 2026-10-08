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
    startBestLine,
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
        // One candidate list for our move; the opponent's reply comes from the
        // explorer alone, so nothing is evaluated for it.
        candidates: 1,
        evaluation: 0,
        // The stats choose 1.e4, so the engine only checks it at the precise depth.
        decision: 0,
        verification: 1,
    });
    expect(report).toMatchObject({
        moves: 2,
        cloud: 0,
        cached: 0,
        explorer: 2,
        expanded: 2,
        checked: 1,
        changed: 0,
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
            engine: { candidates: 6, evaluation: 9, decision: 2, verification: 4 },
            engineSeconds: 23.2,
            explorer: 24,
            explorerSeconds: 3.4,
            expanded: 120,
            pruned: 8,
            lowReach: 44,
            outOfBook: 3,
            coverage: 0.86,
            checked: 9,
            changed: 1,
            exhausted: false,
        }),
    ).toBe(
        "Best line search: 42 s for 11 moves | " +
            "local engine: 21 analyses in 23 s (fast depth 14: 6 candidate lists, 9 position evaluations; " +
            "precise depth 18: 2 engine decisions, 4 checks) | " +
            "Lichess cloud: 31 analyses, 12 reused from the cache | " +
            "Lichess explorer: 24 requests in 3 s | " +
            "search: 120 positions opened, 8 candidates dropped, 44 replies left closed, " +
            "3 out of book, covering 86% of the games | " +
            "checks: 9 positions re-analysed (1 changed)",
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

    await analyze(INITIAL, { purpose: "verification", multipv: 5, searchMoves: ["e2e4", "d2d4"] });

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
