import i18n from "i18next";
import { getDefaultStore } from "jotai";
import { commands } from "@/bindings";
import { type BestLineResult, bestLineResultFamily, bestLineRunFamily } from "@/state/atoms";
import type { TreeMove, TreeStore } from "@/state/store/tree";
import {
    BEST_LINE_MULTIPV,
    type BestLineNode,
    type BestLineParams,
    type BestLineSettings,
    fenAfter,
    findBestLine,
    type LineCommentLabels,
    lineComment,
    nodeAt,
    opponentMovesTo,
    replaceNodeAt,
    sansAlong,
    sansTo,
    subtreeHeight,
    withRateLimitRetry,
} from "@/utils/bestLine";
import { engineCache, explorerCache, memoizeAsync } from "@/utils/bestLineCache";
import { colorComment } from "@/utils/commentColor";
import type { LocalEngine } from "@/utils/engines";
import { formatNumber } from "@/utils/format";
import { getLichessGames, LichessHttpError } from "@/utils/lichess/api";
import type { LichessGamesOptions } from "@/utils/lichess/explorer";
import { findPathBySans, getNodeAtPath } from "@/utils/treeReducer";
import { unwrap } from "@/utils/unwrap";

// The search outlives the tab's components (switching tabs unmounts them), so
// its state lives in atoms and the result is added to the tree store currently
// mounted for the tab, or when the tab is shown again.

const treeStores = new Map<string, TreeStore>();
const cancelFlags = new Map<string, boolean>();

const analysisId = (tab: string) => `bestline_${tab}`;

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

function searchParams(config: SearchConfig, fen: string, plies: number): BestLineParams {
    const { settings } = config;
    return {
        fen,
        color: settings.color,
        plies,
        tolerance:
            settings.toleranceMode === "winChance"
                ? { mode: "winChance", value: settings.winChanceTolerance }
                : { mode: "pawns", value: settings.engineTolerance },
        ranking: settings.ranking,
        minimumGames: settings.minimumGames,
        minGamesPerMove: settings.minGamesPerMove,
        branching: {
            minShare: settings.branchMinShare,
            maxReplies: settings.mode === "tree" ? settings.branchMaxReplies : 1,
            maxDepth: settings.branchDepth,
            trapMinShare:
                settings.mode === "tree" && settings.trapBranching
                    ? settings.trapMinShare
                    : undefined,
        },
    };
}

/** Continues a search after `opponentMoves` opponent moves already played in the result. */
function withBranchingFrom(params: BestLineParams, opponentMoves: number): BestLineParams {
    return {
        ...params,
        branching: {
            ...params.branching,
            maxDepth: Math.max(0, params.branching.maxDepth - opponentMoves),
        },
    };
}

/**
 * Runs a search with the engine and explorer of `config`, then stores the
 * result built by `toResult` from the found nodes and adds it to the tree.
 */
async function run(
    tab: string,
    config: SearchConfig,
    params: BestLineParams,
    toResult: (nodes: BestLineNode[]) => BestLineResult,
) {
    if (cancelFlags.has(tab)) return;
    const store = getDefaultStore();
    const runAtom = bestLineRunFamily(tab);
    const singleLine = config.settings.mode === "line" && !params.forcedMove;
    store.set(runAtom, {
        running: true,
        progress: singleLine ? 0 : null,
        positions: 0,
        waitingUntil: null,
        error: null,
    });
    cancelFlags.set(tab, false);
    const isCancelled = () => cancelFlags.get(tab) === true;

    const { engine, settings, explorerOptions, token } = config;
    const engineOptions = (engine.settings ?? []).map((s) => ({
        ...s,
        value: s.value?.toString() ?? "",
    }));
    const engineKey = `${engine.path}|${settings.depth}|${BEST_LINE_MULTIPV}|${JSON.stringify(engineOptions)}`;
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

    try {
        const nodes = await findBestLine(params, {
            analyze: (fen) =>
                memoizeAsync(engineCache, `${engineKey}|${fen}`, async () =>
                    unwrap(
                        await commands.analyzePosition(
                            analysisId(tab),
                            engine.path,
                            { t: "Depth", c: settings.depth },
                            fen,
                            [],
                            BEST_LINE_MULTIPV,
                            engineOptions,
                        ),
                    ),
                ),
            explore: (fen) =>
                memoizeAsync(explorerCache, `${explorerKey}|${fen}`, () =>
                    withRateLimitRetry(() => getLichessGames(fen, explorerOptions, token), {
                        isRateLimited: (e) => e instanceof LichessHttpError && e.status === 429,
                        sleep,
                        isCancelled,
                        onWait: (ms) =>
                            store.set(runAtom, (prev) => ({
                                ...prev,
                                waitingUntil: Date.now() + ms,
                            })),
                    }).finally(() =>
                        store.set(runAtom, (prev) => ({ ...prev, waitingUntil: null })),
                    ),
                ),
            isCancelled,
            onPosition: () =>
                store.set(runAtom, (prev) => ({
                    ...prev,
                    positions: prev.positions + 1,
                    progress: singleLine
                        ? Math.min(100, ((prev.positions + 1) / params.plies) * 100)
                        : null,
                })),
        });
        store.set(bestLineResultFamily(tab), toResult(nodes));
        insertPendingResult(tab);
    } catch (e) {
        store.set(runAtom, (prev) => ({
            ...prev,
            error: e instanceof Error ? e.message : String(e),
        }));
    } finally {
        cancelFlags.delete(tab);
        commands.closeAnalysisSession(analysisId(tab));
        store.set(runAtom, (prev) => ({ ...prev, running: false, waitingUntil: null }));
    }
}

/** New search from the current position of the tab; replaces the previous result. */
export function startBestLine(tab: string, config: SearchConfig) {
    const tree = treeStores.get(tab);
    if (!tree || cancelFlags.has(tab)) return;
    const fen = tree.getState().currentNode().fen;
    const startPath = tree.getState().position;
    getDefaultStore().set(bestLineResultFamily(tab), null);
    return run(tab, config, searchParams(config, fen, config.settings.fullMoves * 2), (nodes) => ({
        fen,
        color: config.settings.color,
        startPath,
        nodes,
        inserted: false,
        focus: [0],
    }));
}

/** Plays `san` instead of the move at `path` of the result, and searches on to the same depth. */
export function replayMove(tab: string, config: SearchConfig, path: number[], san: string) {
    const result = getDefaultStore().get(bestLineResultFamily(tab));
    const node = result && nodeAt(result.nodes, path);
    if (!result || !node) return;
    const params = withBranchingFrom(
        {
            ...searchParams(config, node.fen, subtreeHeight(node)),
            color: result.color,
            forcedMove: san,
        },
        opponentMovesTo(result.nodes, path, result.color),
    );
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
    const params = withBranchingFrom(
        { ...searchParams(config, fenAfter(node), fullMoves * 2), color: result.color },
        opponentMovesTo(result.nodes, path, result.color, true),
    );
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

export function toTreeMoves(nodes: BestLineNode[], color: "white" | "black"): TreeMove[] {
    const labels: LineCommentLabels = {
        winrate: (score) => i18n.t("BestLine.Comment.Winrate", { score }),
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

    tree.getState().addTree(toTreeMoves(result.nodes, result.color), from);
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
