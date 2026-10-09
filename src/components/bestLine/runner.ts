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
    type LineCommentLabels,
    lineComment,
    type Metric,
    nodeAt,
    replaceNodeAt,
    sansAlong,
    sansTo,
    subtreeHeight,
    withRateLimitRetry,
} from "@/utils/bestLine";
import { countNodes, type OutputOptions, toBestLineNodes } from "@/utils/bestLine/project";
import {
    coverageOf,
    DEFAULT_RISK,
    DEFAULT_SHRINKAGE,
    DEFAULT_SMOOTHING,
    searchBestLine,
    type SearchParams,
} from "@/utils/bestLine/search";
import { verifyChoices } from "@/utils/bestLine/verify";
import {
    analysisKey,
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
            if (!cancelFlags.has(tab)) commands.closeAnalysisSession(analysisId(tab));
        }, SESSION_IDLE_MS),
    );
}

/** Stops the search of a closed tab and its engine. */
export function releaseBestLine(tab: string) {
    cancelBestLine(tab);
    engineQueues.delete(tab);
    clearTimeout(sessionTimers.get(tab));
    sessionTimers.delete(tab);
    commands.closeAnalysisSession(analysisId(tab));
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
    commands.cancelAnalysis(analysisId(tab));
}

/** Everything the search needs, from the tab's settings. */
function searchParamsOf(
    config: SearchConfig,
    fen: string,
    plies: number,
    forcedMove?: string,
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
        minReach: settings.reachThreshold,
        shrinkage: DEFAULT_SHRINKAGE,
        risk: DEFAULT_RISK,
        smoothing: DEFAULT_SMOOTHING,
        preciseDepth: settings.depth,
        forcedMove,
    };
}

/** What of the searched tree is kept in the result. */
function outputOptionsOf(config: SearchConfig): OutputOptions {
    const { settings } = config;
    return {
        mode: settings.mode,
        metric: settings.metric,
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
 * Engine analyses of a tab run one at a time: the backend keys its analysis
 * session and its cancel flag by id, so two analyses of the same tab would
 * share a mutex and lose each other's cancel flag.
 */
const engineQueues = new Map<string, Promise<unknown>>();

function enqueueAnalysis<T>(tab: string, task: () => Promise<T>): Promise<T> {
    const queued = (engineQueues.get(tab) ?? Promise.resolve()).then(task, task);
    engineQueues.set(
        tab,
        queued.catch(() => {}),
    );
    return queued;
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
        engine: { candidates: 0, evaluation: 0, decision: 0, verification: 0 },
        engineSeconds: 0,
        explorer: 0,
        explorerSeconds: 0,
        expanded: 0,
        pruned: 0,
        lowReach: 0,
        outOfBook: 0,
        coverage: 0,
        checked: 0,
        changed: 0,
        exhausted: false,
    };
}

/**
 * The engine analyses of a search: the Lichess cloud evaluation when it is
 * deep enough, else the local engine, counted in `report`. Results are
 * memoized for the session; the number of lines never exceeds the number of
 * moves the analysis is restricted to, which the engine would never send.
 */
export function createAnalyze(tab: string, config: SearchConfig, report: SearchReport) {
    const { engine, settings } = config;
    const engineOptions = (engine.settings ?? []).map((s) => ({
        ...s,
        value: s.value?.toString() ?? "",
    }));
    const engineKey = `${engine.path}|${JSON.stringify(engineOptions)}`;

    return (fen: string, request: AnalysisRequest): Promise<BestMoves[]> => {
        const depth = isPreciseAnalysis(request.purpose) ? report.preciseDepth : report.fastDepth;
        const searchMoves = request.searchMoves ?? [];
        const asked = request.multipv ?? BEST_LINE_MULTIPV;
        const multipv = searchMoves.length > 0 ? Math.min(asked, searchMoves.length) : asked;
        const key = `${engineKey}|${depth}|${multipv}|${searchMoves.join(",")}|${analysisKey(fen)}`;
        if (engineCache.has(key)) report.cached++;
        return memoizeAsync(engineCache, key, async () => {
            const cloud =
                settings.useCloudEval && searchMoves.length === 0
                    ? await cloudLines(fen, depth, multipv)
                    : null;
            if (cloud) {
                report.cloud++;
                return cloud;
            }
            report.engine[request.purpose]++;
            const start = Date.now();
            try {
                return await enqueueAnalysis(tab, async () =>
                    unwrap(
                        await commands.analyzePosition(
                            analysisId(tab),
                            engine.path,
                            { t: "Depth", c: depth },
                            fen,
                            [],
                            multipv,
                            searchMoves,
                            engineOptions,
                        ),
                    ),
                );
            } finally {
                report.engineSeconds += (Date.now() - start) / 1000;
            }
        });
    };
}

/** One line, for the log, of everything a finished search spent its time on. */
export function formatSearchReport(report: SearchReport): string {
    const { engine } = report;
    const analyses = Object.values(engine).reduce((acc, n) => acc + n, 0);
    const round = (seconds: number) => Math.round(seconds);
    return [
        `Best line search: ${round(report.seconds)} s for ${report.moves} moves`,
        `local engine: ${analyses} analyses in ${round(report.engineSeconds)} s ` +
            `(fast depth ${report.fastDepth}: ${engine.candidates} candidate lists, ` +
            `${engine.evaluation} position evaluations; ` +
            `precise depth ${report.preciseDepth}: ${engine.decision} engine decisions, ` +
            `${engine.verification} checks)`,
        `Lichess cloud: ${report.cloud} analyses, ${report.cached} reused from the cache`,
        `Lichess explorer: ${report.explorer} requests in ${round(report.explorerSeconds)} s`,
        `search: ${report.expanded} positions opened, ${report.pruned} candidates dropped, ` +
            `${report.lowReach} replies left closed, ${report.outOfBook} out of book, ` +
            `covering ${Math.round(report.coverage * 100)}% of the games` +
            (report.exhausted ? " (stopped on its limit)" : ""),
        `checks: ${report.checked} positions re-analysed (${report.changed} changed)`,
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
    const analyze = createAnalyze(tab, config, report);
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

        if (config.settings.verifyFastChoice && !isCancelled()) {
            const checks = await verifyChoices(
                root,
                { ...params, mode: config.settings.mode },
                { analyze, isCancelled },
            );
            report.checked = checks.checked;
            report.changed = checks.changed;
        }

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

/** Continues the branch ending with the move at `path` of the result for `fullMoves` moves. */
export function extendLine(tab: string, config: SearchConfig, path: number[], fullMoves: number) {
    const result = getDefaultStore().get(bestLineResultFamily(tab));
    const node = result && nodeAt(result.nodes, path);
    if (!result || !node) return;
    const params = {
        ...searchParamsOf(config, fenAfter(node), fullMoves * 2),
        color: result.color,
    };
    return run(tab, config, params, (nodes) => ({
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
