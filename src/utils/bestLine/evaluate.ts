import type { SearchNode } from "./node";
import { keptEdges } from "./project";
import type { SearchDeps } from "./search";

/**
 * Evaluates the positions a result ends on. The search itself never analyses
 * the opponent's positions — his replies come from the explorer — so the last
 * move of a branch would have no evaluation to show. One fast single-line
 * analysis per kept leaf fills that in, and nothing else.
 */
export async function evaluateLeaves(
    root: SearchNode,
    options: { mode: "line" | "tree" },
    deps: Pick<SearchDeps, "analyze"> & Pick<SearchDeps, "isCancelled">,
): Promise<number> {
    const leaves: SearchNode[] = [];
    const collect = (node: SearchNode) => {
        const kept = keptEdges(node, options.mode);
        if (kept.length === 0) {
            // A finished game is already worth a win, a loss or a draw.
            if (!node.evaluation && node.stopped !== "checkmate" && node.stopped !== "draw") {
                leaves.push(node);
            }
            return;
        }
        for (const edge of kept) if (edge.child) collect(edge.child);
    };
    collect(root);

    let evaluated = 0;
    for (const leaf of leaves) {
        if (deps.isCancelled?.()) break;
        let best: Awaited<ReturnType<typeof deps.analyze>>[number] | undefined;
        try {
            [best] = await deps.analyze(leaf.fen, { purpose: "evaluation", multipv: 1 });
        } catch (e) {
            // An analysis the engine gave up because the search was stopped.
            if (deps.isCancelled?.()) break;
            throw e;
        }
        if (!best) continue;
        leaf.evaluation = best.score;
        evaluated++;
    }
    return evaluated;
}
