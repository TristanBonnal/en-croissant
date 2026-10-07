import i18n from "i18next";
import { getDefaultStore } from "jotai";
import { commands, type EngineOption } from "@/bindings";
import { bestLineResultFamily, bestLineRunFamily } from "@/state/atoms";
import type { TreeStore } from "@/state/store/tree";
import {
    BEST_LINE_MULTIPV,
    type BestLineParams,
    findBestLine,
    type LineCommentLabels,
    lineComment,
} from "@/utils/bestLine";
import { colorComment } from "@/utils/commentColor";
import { formatNumber } from "@/utils/format";
import { getLichessGames } from "@/utils/lichess/api";
import type { LichessGamesOptions } from "@/utils/lichess/explorer";
import { getNodeAtPath } from "@/utils/treeReducer";
import { unwrap } from "@/utils/unwrap";

// The search outlives the tab's components (switching tabs unmounts them), so
// its state lives in atoms and the line is added to the tree store currently
// mounted for the tab, or when the tab is shown again.

const treeStores = new Map<string, TreeStore>();
const cancelFlags = new Map<string, boolean>();

const analysisId = (tab: string) => `bestline_${tab}`;

/** Registers the tree store of a mounted tab, and adds a pending line to it. */
export function registerTreeStore(tab: string, store: TreeStore) {
    treeStores.set(tab, store);
    insertPendingLine(tab);
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

export async function startBestLine({
    tab,
    params,
    engine,
    engineOptions,
    depth,
    explorerOptions,
    token,
}: {
    tab: string;
    params: BestLineParams;
    engine: string;
    engineOptions: EngineOption[];
    depth: number;
    explorerOptions: LichessGamesOptions;
    token?: string;
}) {
    const tree = treeStores.get(tab);
    if (!tree || cancelFlags.has(tab)) return;
    const startPath = tree.getState().position;

    const store = getDefaultStore();
    const runAtom = bestLineRunFamily(tab);
    store.set(runAtom, { running: true, progress: 0, error: null });
    store.set(bestLineResultFamily(tab), null);
    cancelFlags.set(tab, false);

    try {
        const steps = await findBestLine(params, {
            analyze: async (fen) =>
                unwrap(
                    await commands.analyzePosition(
                        analysisId(tab),
                        engine,
                        { t: "Depth", c: depth },
                        fen,
                        [],
                        BEST_LINE_MULTIPV,
                        engineOptions,
                    ),
                ),
            explore: (fen) => getLichessGames(fen, explorerOptions, token),
            isCancelled: () => cancelFlags.get(tab) === true,
            onProgress: (done, total) =>
                store.set(runAtom, (prev) => ({ ...prev, progress: (done / total) * 100 })),
        });
        store.set(bestLineResultFamily(tab), {
            fen: params.fen,
            color: params.color,
            startPath,
            steps,
            inserted: false,
        });
        insertPendingLine(tab);
    } catch (e) {
        store.set(runAtom, (prev) => ({
            ...prev,
            error: e instanceof Error ? e.message : String(e),
        }));
    } finally {
        cancelFlags.delete(tab);
        store.set(runAtom, (prev) => ({ ...prev, running: false }));
    }
}

function insertPendingLine(tab: string) {
    const store = getDefaultStore();
    const resultAtom = bestLineResultFamily(tab);
    const result = store.get(resultAtom);
    const tree = treeStores.get(tab);
    if (!result || result.inserted || !tree) return;
    store.set(resultAtom, { ...result, inserted: true });
    if (result.steps.length === 0) return;

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

    const labels: LineCommentLabels = {
        winrate: (score) => i18n.t("BestLine.Comment.Winrate", { score }),
        played: (share, games) =>
            i18n.t("BestLine.Comment.Played", { share, games: formatNumber(games) }),
        engine: (evaluation) => i18n.t("BestLine.Comment.Engine", { eval: evaluation }),
    };
    tree.getState().addLine(
        result.steps.map((step) => {
            const { text, color } = lineComment(step, result.color, labels);
            return {
                san: step.san,
                comment: color ? colorComment(text, color) : text,
                score: step.score,
            };
        }),
        from,
    );
}
