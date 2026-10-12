import i18n from "i18next";
import { getDefaultStore } from "jotai";
import { type BestMoves, commands } from "@/bindings";
import { info } from "@tauri-apps/plugin-log";
import {
    type BestLineResult,
    bestLinePanelTabFamily,
    bestLineResultFamily,
    bestLineRunFamily,
    idleBestLineRun,
    type SearchReport,
} from "@/state/atoms";
import type { TreeMove, TreeStore } from "@/state/store/tree";
import {
    type AnalysisRequest,
    BEST_LINE_MULTIPV,
    type BestLineNode,
    type BestLineSettings,
    cloudLinesUsable,
    fenAfter,
    isPreciseAnalysis,
    isTurnOf,
    type LineCommentLabels,
    lineComment,
    type Metric,
    nodeAt,
    replaceNodeAt,
    sansAlong,
    sansTo,
    subtreeHeight,
    truncateNodes,
    withRateLimitRetry,
} from "@/utils/bestLine";
import { evaluateLeaves } from "@/utils/bestLine/evaluate";
import { countNodes, type OutputOptions, toBestLineNodes } from "@/utils/bestLine/project";
import {
    coverageOf,
    DEFAULT_RISK,
    DEFAULT_SHRINKAGE,
    DEFAULT_SMOOTHING,
    searchBestLine,
    type SearchParams,
} from "@/utils/bestLine/search";
import {
    createLimiter,
    createWorkerPool,
    MAX_WORKERS,
    planEngines,
    type WorkerPool,
} from "@/utils/bestLinePool";
import {
    analysisKey,
    clearBestLineCaches,
    engineCache,
    explorerCache,
    memoizeAsync,
    positionKey,
    prefetchingExplorer,
} from "@/utils/bestLineCache";
import { colorComment } from "@/utils/commentColor";
import type { LocalEngine } from "@/utils/engines";
import { formatNumber } from "@/utils/format";
import { positionFromFen } from "@/utils/chessops";
import {
    getBestMoves as getCloudBestMoves,
    getLichessGames,
    LichessHttpError,
} from "@/utils/lichess/api";
import type { LichessGamesOptions } from "@/utils/lichess/explorer";
import { defaultTree, findPathBySans, getNodeAtPath } from "@/utils/treeReducer";
import { unwrap } from "@/utils/unwrap";

// The search outlives the tab's components (switching tabs unmounts them), so
// its state lives in atoms and the result is added to the tree store currently
// mounted for the tab, or when the tab is shown again.

const treeStores = new Map<string, TreeStore>();
const cancelFlags = new Map<string, boolean>();

const analysisId = (tab: string) => `bestline_${tab}`;
/** Engine of a worker: the first keeps the tab's own name, the others are numbered. */
const workerId = (tab: string, worker: number) =>
    worker === 0 ? analysisId(tab) : `${analysisId(tab)}#${worker}`;
const workerIds = (tab: string) => Array.from({ length: MAX_WORKERS }, (_, i) => workerId(tab, i));

function closeEngines(tab: string) {
    for (const id of workerIds(tab)) commands.closeAnalysisSession(id);
}

/**
 * Explorer requests a search keeps running at once. Lichess answers a burst
 * with a 429 and a minute's wait, so this stays small.
 */
const EXPLORER_CONCURRENCY = 3;

/**
 * The engine stays up a while after a search, so the next one doesn't start
 * it again and benefits from what it already computed (hash table).
 */
const SESSION_IDLE_MS = 5 * 60_000;
const sessionTimers = new Map<string, ReturnType<typeof setTimeout>>();

function keepSession(tab: string) {
    clearTimeout(sessionTimers.get(tab));
    sessionTimers.set(
        tab,
        setTimeout(() => {
            sessionTimers.delete(tab);
            if (!cancelFlags.has(tab)) closeEngines(tab);
        }, SESSION_IDLE_MS),
    );
}

/** Key of the live analysis of a tab: its own search, run state and engine. */
export const liveKeyOf = (tab: string) => `${tab}-live`;

/** Stops the search of a closed tab and its engine. */
export function releaseBestLine(tab: string) {
    stopLiveSearch(liveKeyOf(tab));
    closeEngines(liveKeyOf(tab));
    cancelBestLine(tab);
    enginePools.delete(liveKeyOf(tab));
    enginePools.delete(tab);
    clearTimeout(sessionTimers.get(tab));
    sessionTimers.delete(tab);
    closeEngines(tab);
}

/**
 * Starts the tab over: forgets the result and the last search, and empties the
 * move tree (the board keeps its orientation, i.e. the studied side). Refused
 * while a search is running.
 */
export function resetBestLine(tab: string) {
    if (cancelFlags.has(tab)) return false;
    const store = getDefaultStore();
    store.set(bestLineResultFamily(tab), null);
    store.set(bestLineRunFamily(tab), idleBestLineRun);
    store.set(bestLinePanelTabFamily(tab), "settings");
    const tree = treeStores.get(tab);
    if (tree) {
        const empty = defaultTree();
        const { orientation } = tree.getState().headers;
        tree.getState().setState({ ...empty, headers: { ...empty.headers, orientation } });
    }
    return true;
}

/** Everything a search needs besides the position. */
export type SearchConfig = {
    settings: BestLineSettings;
    engine: LocalEngine;
    explorerOptions: LichessGamesOptions;
    token?: string;
};

/** Registers the tree store of a mounted tab, and adds a pending result to it. */
export function registerTreeStore(tab: string, store: TreeStore) {
    treeStores.set(tab, store);
    insertPendingResult(tab);
    return () => {
        if (treeStores.get(tab) === store) {
            treeStores.delete(tab);
        }
    };
}

export function cancelBestLine(tab: string) {
    if (!cancelFlags.has(tab)) return;
    cancelFlags.set(tab, true);
    for (const id of workerIds(tab)) commands.cancelAnalysis(id);
}

/** Everything the search needs, from the tab's settings. */
function searchParamsOf(
    config: SearchConfig,
    fen: string,
    plies: number,
    forcedMove?: string,
    keepPlies?: number,
): SearchParams {
    const { settings } = config;
    return {
        fen,
        color: settings.color,
        maxPlies: plies,
        tolerance:
            settings.toleranceMode === "winChance"
                ? { mode: "winChance", value: settings.winChanceTolerance }
                : { mode: "pawns", value: settings.engineTolerance },
        metric: settings.metric,
        minimumGames: settings.minimumGames,
        minGamesPerMove: settings.minGamesPerMove,
        minMoveShare: settings.minMoveShare,
        trapMinShare:
            settings.mode === "tree" && settings.trapBranching ? settings.trapMinShare : undefined,
        minReach: settings.reachThreshold,
        shrinkage: DEFAULT_SHRINKAGE,
        risk: DEFAULT_RISK,
        smoothing: DEFAULT_SMOOTHING,
        forcedMove,
        mode: settings.mode,
        keepPlies,
    };
}

/** What of the searched tree is kept in the result. */
function outputOptionsOf(config: SearchConfig): OutputOptions {
    const { settings } = config;
    return {
        mode: settings.mode,
        metric: settings.metric,
        preciseDepth: settings.depth,
        risk: DEFAULT_RISK,
        trapMinShare: settings.trapBranching ? settings.trapMinShare : undefined,
    };
}

function legalMoveCount(fen: string) {
    const [pos] = positionFromFen(fen);
    if (!pos) return 0;
    let count = 0;
    for (const [, dests] of pos.allDests()) count += dests.size();
    return count;
}

/**
 * Lichess cloud analysis of a position, when it is at least as deep as asked
 * and has as many lines as a local analysis would: it is instant and usually
 * much deeper. Null otherwise (the local engine is used).
 */
async function cloudLines(
    fen: string,
    depth: number,
    multipv: number,
): Promise<BestMoves[] | null> {
    try {
        const cloud = await getCloudBestMoves(
            "",
            { t: "Depth", c: depth },
            {
                fen,
                moves: [],
                extraOptions: [{ name: "MultiPV", value: multipv.toString() }],
            },
        );
        const expected = Math.min(multipv, legalMoveCount(fen));
        return cloud && cloudLinesUsable(cloud[1], depth, expected) ? cloud[1] : null;
    } catch {
        return null;
    }
}

/**
 * Engines of a tab. The backend keys an analysis session and its cancel flag by
 * id, so two analyses on the same engine would share a mutex and lose each
 * other's cancel flag: each worker of the pool has its own engine, and runs one
 * analysis at a time.
 */
const enginePools = new Map<string, WorkerPool>();

function poolOf(tab: string, workers: number): WorkerPool {
    const known = enginePools.get(tab);
    if (known?.size === workers) return known;
    if (known) closeEngines(tab);
    const pool = createWorkerPool(workers);
    enginePools.set(tab, pool);
    return pool;
}

/**
 * Cloud evaluations asked at once, by every search: the analyses of a search
 * are asked side by side, and a burst makes Lichess answer with a 429.
 */
const CLOUD_CONCURRENCY = 2;
const limitCloud = createLimiter(CLOUD_CONCURRENCY);

/** Threads the machine has, to share among the engines. */
function availableCores(): number {
    return typeof navigator === "undefined" ? 1 : navigator.hardwareConcurrency || 1;
}

/**
 * Whether a failed explorer request is worth trying again soon: the connection
 * dropped or the server failed. A refusal (no token, bad request) stays one.
 */
export function isTransientExplorerError(e: unknown): boolean {
    if (e instanceof LichessHttpError) return e.status >= 500 || e.status === 408;
    return true;
}

/** Empty report of a search about to start. */
export function newSearchReport(settings: BestLineSettings): SearchReport {
    return {
        seconds: 0,
        moves: 0,
        fastDepth: Math.min(settings.fastDepth, settings.depth),
        preciseDepth: settings.depth,
        cached: 0,
        cloud: 0,
        engine: { candidates: 0, evaluation: 0, decision: 0 },
        engineSeconds: 0,
        explorer: 0,
        explorerSeconds: 0,
        expanded: 0,
        pruned: 0,
        lowReach: 0,
        outOfBook: 0,
        coverage: 0,
        exhausted: false,
    };
}

/**
 * The engine analyses of a search: the Lichess cloud evaluation when it is
 * deep enough, else the local engine, counted in `report`. Results are
 * memoized for the session; the number of lines never exceeds the number of
 * moves the analysis is restricted to, which the engine would never send.
 *
 * An engine with threads to share (`planEngines`) runs on several engines side
 * by side: the analyses the search waits on take the first one free, and `warm`
 * starts, on the others, the ones it will probably ask for next. `stop` ends
 * what is still running ahead of need.
 */
export function createAnalyze(
    tab: string,
    config: SearchConfig,
    report: SearchReport,
    isCancelled: () => boolean = () => false,
    cores: number = availableCores(),
) {
    const { engine, settings } = config;
    const engineOptions = (engine.settings ?? []).map((s) => ({
        ...s,
        value: s.value?.toString() ?? "",
    }));
    const engineKey = `${engine.path}|${JSON.stringify(engineOptions)}`;
    const plan = planEngines(engine.settings ?? undefined, cores);
    const pool = poolOf(tab, plan.workers);
    // Each engine gets its share of the threads and of the hash.
    const workerOptions =
        plan.threads === undefined
            ? engineOptions
            : engineOptions.map((option) => {
                  if (option.name === "Threads") return { ...option, value: String(plan.threads) };
                  if (option.name === "Hash") return { ...option, value: String(plan.hash) };
                  return option;
              });
    let stopped = false;

    const keyOf = (fen: string, request: AnalysisRequest) => {
        const depth = isPreciseAnalysis(request.purpose) ? report.preciseDepth : report.fastDepth;
        const searchMoves = request.searchMoves ?? [];
        const asked = request.multipv ?? BEST_LINE_MULTIPV;
        const multipv = searchMoves.length > 0 ? Math.min(asked, searchMoves.length) : asked;
        const key = `${engineKey}|${depth}|${multipv}|${searchMoves.join(",")}|${analysisKey(fen)}`;
        return { key, depth, multipv, searchMoves };
    };

    /** The analysis, started if it is not under way or done; `ahead` when nothing waits on it yet. */
    function linesOf(fen: string, request: AnalysisRequest, ahead: boolean): Promise<BestMoves[]> {
        const { key, depth, multipv, searchMoves } = keyOf(fen, request);
        if (!ahead && engineCache.has(key)) report.cached++;
        const lines = memoizeAsync(engineCache, key, async () => {
            const cloud =
                settings.useCloudEval && searchMoves.length === 0
                    ? await limitCloud(() => {
                          // Waiting for its turn, the search may have been stopped.
                          if (isCancelled() || (ahead && stopped)) {
                              throw new Error("Analysis cancelled");
                          }
                          return cloudLines(fen, depth, multipv);
                      })
                    : null;
            if (cloud) {
                report.cloud++;
                return cloud;
            }
            const analyse = async (worker: number) => {
                // The backend only cancels the analysis running, so those
                // waiting for an engine would each start a full one.
                if (isCancelled() || (ahead && stopped)) throw new Error("Analysis cancelled");
                // A quick look at a position is counted with the other fast analyses.
                report.engine[request.purpose === "survey" ? "evaluation" : request.purpose]++;
                const start = Date.now();
                try {
                    const answer = await commands.analyzePosition(
                        workerId(tab, worker),
                        engine.path,
                        { t: "Depth", c: depth },
                        fen,
                        [],
                        multipv,
                        searchMoves,
                        workerOptions,
                    );
                    // A search the user stopped is not an error to show.
                    if (answer.status === "error" && (isCancelled() || (ahead && stopped))) {
                        throw new Error("Analysis cancelled");
                    }
                    return unwrap(answer);
                } finally {
                    report.engineSeconds += (Date.now() - start) / 1000;
                }
            };
            // An analysis ahead of need that finds no spare engine after the cloud
            // lookup waits for its turn like the others.
            return (ahead ? pool.speculate(analyse) : undefined) ?? pool.run(analyse);
        });
        // An engine that stopped without a line says nothing about the position.
        void lines.then(
            (found) => {
                if (found.length === 0 && engineCache.get(key) === lines) engineCache.delete(key);
            },
            () => {},
        );
        return lines;
    }

    const analyze = (fen: string, request: AnalysisRequest): Promise<BestMoves[]> =>
        linesOf(fen, request, false);

    /**
     * Starts an analysis the search will probably ask for soon, when an engine is
     * spare (one is always left to the analyses the search waits on). Returns the
     * analysis, under way or done, or false when no engine is spare.
     */
    const warm = (fen: string, request: AnalysisRequest): Promise<BestMoves[]> | false => {
        if (stopped) return false;
        const known = engineCache.get(keyOf(fen, request).key);
        if (known) return known;
        if (pool.spare() === 0) return false;
        const lines = linesOf(fen, request, true);
        lines.catch(() => {});
        return lines;
    };

    /** Ends the analyses still running ahead of need: the search is over. */
    const stop = async () => {
        stopped = true;
        await Promise.all(
            pool.busy().map((worker) => commands.cancelAnalysis(workerId(tab, worker))),
        );
    };

    return Object.assign(analyze, { warm, stop });
}

/** One line, for the log, of everything a finished search spent its time on. */
export function formatSearchReport(report: SearchReport): string {
    const { engine } = report;
    const analyses = Object.values(engine).reduce((acc, n) => acc + n, 0);
    const round = (seconds: number) => Math.round(seconds);
    return [
        `Best line search: ${round(report.seconds)} s for ${report.moves} moves`,
        `local engine: ${analyses} analyses, ${round(report.engineSeconds)} s of engine time ` +
            `(fast depth ${report.fastDepth}: ${engine.evaluation} position evaluations; ` +
            `precise depth ${report.preciseDepth}: ${engine.candidates} candidate lists, ` +
            `${engine.decision} engine decisions)`,
        `Lichess cloud: ${report.cloud} analyses, ${report.cached} reused from the cache`,
        `Lichess explorer: ${report.explorer} requests in ${round(report.explorerSeconds)} s`,
        `search: ${report.expanded} positions opened, ${report.pruned} candidates dropped, ` +
            `${report.lowReach} replies left closed, ${report.outOfBook} out of book, ` +
            `covering ${Math.round(report.coverage * 100)}% of the games` +
            (report.exhausted ? " (stopped on its limit)" : ""),
    ].join(" | ");
}

/**
 * Runs a search with the engine and explorer of `config`, then stores the
 * result built by `toResult` from the found nodes and adds it to the tree.
 */
async function run(
    tab: string,
    config: SearchConfig,
    params: SearchParams,
    toResult: (nodes: BestLineNode[]) => BestLineResult,
) {
    if (cancelFlags.has(tab)) return;
    const store = getDefaultStore();
    const runAtom = bestLineRunFamily(tab);
    store.set(runAtom, {
        running: true,
        progress: 0,
        positions: 0,
        waitingUntil: null,
        error: null,
        report: null,
    });
    const started = Date.now();
    const report = newSearchReport(config.settings);
    cancelFlags.set(tab, false);
    const isCancelled = () => cancelFlags.get(tab) === true;

    const { explorerOptions, token } = config;
    const analyze = createAnalyze(tab, config, report, isCancelled);
    const explorerKey = JSON.stringify(explorerOptions);

    const sleep = (ms: number) =>
        new Promise<void>((resolve) => {
            const end = Date.now() + ms;
            const timer = setInterval(() => {
                if (isCancelled() || Date.now() >= end) {
                    clearInterval(timer);
                    resolve();
                }
            }, 250);
        });

    // Prefetches can still answer after the search, and must not touch the
    // state of the next one.
    let searching = true;
    try {
        const { explore, prefetch } = prefetchingExplorer(
            explorerCache,
            (fen) => `${explorerKey}|${positionKey(fen)}`,
            (fen) => {
                report.explorer++;
                const start = Date.now();
                return withRateLimitRetry(() => getLichessGames(fen, explorerOptions, token), {
                    isRateLimited: (e) => e instanceof LichessHttpError && e.status === 429,
                    isTransient: isTransientExplorerError,
                    sleep,
                    isCancelled,
                    onWait: (ms) => {
                        if (!searching) return;
                        store.set(runAtom, (prev) => ({
                            ...prev,
                            waitingUntil: Date.now() + ms,
                        }));
                    },
                }).finally(() => {
                    report.explorerSeconds += (Date.now() - start) / 1000;
                    if (searching) store.set(runAtom, (prev) => ({ ...prev, waitingUntil: null }));
                });
            },
            EXPLORER_CONCURRENCY,
        );

        const { root, stats } = await searchBestLine(params, {
            analyze,
            warm: analyze.warm,
            explore,
            prefetch: (fen) => !isCancelled() && prefetch(fen),
            isCancelled,
            // The tree is searched most likely first, so its coverage of the
            // games to come is the honest measure of how far the search is.
            onProgress: (progress, tree) =>
                store.set(runAtom, (prev) => ({
                    ...prev,
                    positions: progress.expanded,
                    progress: Math.round(coverageOf(tree) * 100),
                })),
        });
        report.expanded = stats.expanded;
        report.pruned = stats.pruned;
        report.lowReach = stats.lowReach;
        report.outOfBook = stats.outOfBook;
        report.exhausted = stats.exhausted;
        report.coverage = coverageOf(root);

        // The search never analyses the opponent's positions, so the moves a
        // branch ends on get their evaluation here.
        await evaluateLeaves(
            root,
            { mode: config.settings.mode, keepPlies: params.keepPlies },
            { analyze, isCancelled },
        );

        const nodes = toBestLineNodes(root, outputOptionsOf(config));
        report.moves = countNodes(nodes);
        store.set(bestLineResultFamily(tab), toResult(nodes));
        insertPendingResult(tab);
    } catch (e) {
        store.set(runAtom, (prev) => ({
            ...prev,
            error: e instanceof Error ? e.message : String(e),
        }));
    } finally {
        searching = false;
        // Analyses started ahead of need that the search never asked for.
        await analyze.stop().catch(() => {});
        cancelFlags.delete(tab);
        keepSession(tab);
        report.seconds = (Date.now() - started) / 1000;
        info(formatSearchReport(report));
        store.set(runAtom, (prev) => ({ ...prev, running: false, waitingUntil: null, report }));
    }
}

/**
 * New search from the position at `from` (default: the board's position) of
 * the tab; replaces the previous result.
 */
export function startBestLine(tab: string, config: SearchConfig, from?: number[]) {
    const tree = treeStores.get(tab);
    if (!tree || cancelFlags.has(tab)) return;
    const startPath = from ?? tree.getState().position;
    const fen = getNodeAtPath(tree.getState().root, startPath).fen;
    getDefaultStore().set(bestLineResultFamily(tab), null);
    return run(
        tab,
        config,
        searchParamsOf(config, fen, config.settings.fullMoves * 2),
        (nodes) => ({
            fen,
            color: config.settings.color,
            metric: config.settings.metric,
            startPath,
            nodes,
            inserted: false,
            focus: [0],
        }),
    );
}

const liveRequests = new Map<string, number>();

/** Tab whose board a live search key belongs to. */
const liveTabOf = (key: string) => (key.endsWith("-live") ? key.slice(0, -"-live".length) : key);

/**
 * Adds the move a live search chose to the board it searched, at the end of
 * the line the board is on. The board stays as it is when it has moved on in
 * the meantime or already has a move there (it is being gone back through).
 */
function addLiveMove(tab: string, fen: string, result: BestLineResult) {
    const tree = treeStores.get(tab);
    const first = result.nodes[0];
    if (!tree || !first) return;
    const state = tree.getState();
    const here = getNodeAtPath(state.root, state.position);
    if (here.fen !== fen || here.children.length > 0) return;
    state.addTree(toTreeMoves([first], result.color, result.metric), state.position);
}

/**
 * Chooses the move of the studied side in the position of the board, for the
 * live analysis: it looks `liveMoves` of the studied side's moves ahead to
 * judge each candidate, and keeps only the move itself, which it adds to the
 * line on the board. The first move is chosen among precise candidates; what
 * follows only serves to judge it, and is looked at quickly. It has its own
 * result and engine session, apart from the tab's search. A newer request
 * replaces the one still running, and nothing is searched while it is the
 * opponent's turn.
 */
export async function startLiveSearch(key: string, config: SearchConfig, fen: string) {
    const request = (liveRequests.get(key) ?? 0) + 1;
    liveRequests.set(key, request);
    if (cancelFlags.has(key)) {
        cancelBestLine(key);
        while (cancelFlags.has(key)) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (liveRequests.get(key) !== request || !isTurnOf(fen, config.settings.color)) return;

    // Nothing below the first move is kept: no trap is worth opening for it.
    const live: SearchConfig = {
        ...config,
        settings: { ...config.settings, mode: "tree", trapBranching: false },
    };
    const plies = 2 * config.settings.liveMoves - 1;
    const params = { ...searchParamsOf(live, fen, plies, undefined, 1), surveyBelowRoot: true };
    await run(key, live, params, (nodes) => ({
        fen,
        color: config.settings.color,
        metric: config.settings.metric,
        startPath: [],
        // The moves looked at beyond the first one only served to choose it.
        nodes: truncateNodes(nodes, 1),
        inserted: false,
        focus: [0],
    }));

    const store = getDefaultStore();
    const found = store.get(bestLineResultFamily(key));
    const failed = store.get(bestLineRunFamily(key)).error !== null;
    if (
        config.settings.liveAddMove &&
        liveRequests.get(key) === request &&
        found?.fen === fen &&
        !failed
    ) {
        addLiveMove(liveTabOf(key), fen, found);
    }
}

/** Stops the live analysis, and forgets the requests still waiting. */
export function stopLiveSearch(key: string) {
    liveRequests.set(key, (liveRequests.get(key) ?? 0) + 1);
    cancelBestLine(key);
}

/** Starts the live analysis over: nothing of its result, nor of any analysis, is kept. */
export function resetLiveSearch(key: string) {
    stopLiveSearch(key);
    const store = getDefaultStore();
    store.set(bestLineResultFamily(key), null);
    store.set(bestLineRunFamily(key), idleBestLineRun);
    clearBestLineCaches();
    closeEngines(key);
}

/** Plays `san` instead of the move at `path` of the result, and searches on to the same depth. */
export function replayMove(tab: string, config: SearchConfig, path: number[], san: string) {
    const result = getDefaultStore().get(bestLineResultFamily(tab));
    const node = result && nodeAt(result.nodes, path);
    if (!result || !node) return;
    const params = {
        ...searchParamsOf(config, node.fen, subtreeHeight(node), san),
        color: result.color,
    };
    return run(tab, config, params, (nodes) => ({
        ...result,
        nodes: nodes[0] ? replaceNodeAt(result.nodes, path, nodes[0]) : result.nodes,
        inserted: false,
        focus: path,
    }));
}

/**
 * Continues the branch ending with the move at `path` of the result for
 * `fullMoves` moves. The continuation is a single line, the most played reply
 * at each of the opponent's moves, whatever mode the result was searched in:
 * it extends the line instead of branching out of it.
 */
export function extendLine(tab: string, config: SearchConfig, path: number[], fullMoves: number) {
    const result = getDefaultStore().get(bestLineResultFamily(tab));
    const node = result && nodeAt(result.nodes, path);
    if (!result || !node) return;
    const single: SearchConfig = { ...config, settings: { ...config.settings, mode: "line" } };
    const params = {
        ...searchParamsOf(single, fenAfter(node), fullMoves * 2),
        color: result.color,
        reach: node.reach,
    };
    return run(tab, single, params, (nodes) => ({
        ...result,
        nodes: replaceNodeAt(result.nodes, path, {
            ...node,
            children: [...node.children, ...nodes],
        }),
        inserted: false,
        focus: path,
    }));
}

export function toTreeMoves(
    nodes: BestLineNode[],
    color: "white" | "black",
    metric: Metric = "score",
): TreeMove[] {
    const labels: LineCommentLabels = {
        winrate: (score) =>
            i18n.t(metric === "wins" ? "BestLine.Comment.Winrate" : "BestLine.Comment.Score", {
                score,
            }),
        played: (share, games) =>
            i18n.t("BestLine.Comment.Played", { share, games: formatNumber(games) }),
        engine: (evaluation) => i18n.t("BestLine.Comment.Engine", { eval: evaluation }),
    };
    const convert = (node: BestLineNode): TreeMove => {
        const { text, color: textColor } = lineComment(node, color, labels);
        return {
            san: node.san,
            comment: textColor ? colorComment(text, textColor) : text,
            score: node.score,
            annotation: node.annotation,
            children: node.children.map(convert),
        };
    };
    return nodes.map(convert);
}

function insertPendingResult(tab: string) {
    const store = getDefaultStore();
    const resultAtom = bestLineResultFamily(tab);
    const result = store.get(resultAtom);
    const tree = treeStores.get(tab);
    if (!result || result.inserted || !tree) return;
    store.set(resultAtom, { ...result, inserted: true });
    if (result.nodes.length === 0) return;

    const state = tree.getState();
    const from = [result.startPath, state.position].find(
        (path) => getNodeAtPath(state.root, path).fen === result.fen,
    );
    if (!from) {
        store.set(bestLineRunFamily(tab), (prev) => ({
            ...prev,
            error: i18n.t("BestLine.StartPositionChanged"),
        }));
        return;
    }

    tree.getState().addTree(toTreeMoves(result.nodes, result.color, result.metric), from);
    tree.getState().addLine(
        sansTo(result.nodes, result.focus).map((san) => ({ san })),
        from,
    );
    store.set(resultAtom, { ...result, inserted: true, startPath: from });
}

/** Shows on the board the position after the move at `path` of the result. */
export function goToResultMove(tab: string, path: number[]) {
    const result = getDefaultStore().get(bestLineResultFamily(tab));
    const tree = treeStores.get(tab);
    if (!result || !tree) return;
    const state = tree.getState();
    if (getNodeAtPath(state.root, result.startPath).fen !== result.fen) return;
    const sans = sansAlong(result.nodes, path);
    const found = findPathBySans(state.root, result.startPath, sans);
    if (found) {
        state.goToMove(found);
    } else {
        // The move was deleted from the tree: play it again.
        state.addLine(
            sans.map((san) => ({ san })),
            result.startPath,
        );
    }
}
