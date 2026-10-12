import type { Edge, SearchNode } from "./node";
import { settleAll } from "./parallel";
import { keptEdges } from "./project";
import type { SearchDeps } from "./search";

/**
 * Evaluates the positions a result ends on. The search itself never analyses
 * the opponent's positions — his replies come from the explorer — so the last
 * move of a branch would have no evaluation to show. One fast single-line
 * analysis per kept leaf fills that in, and nothing else: a move of the studied
 * side already has the evaluation the engine gave it when it was chosen, and
 * nothing is looked at below the `keepPlies` first plies. They are asked
 * together: the engines the analyses run on take them as they come.
 */
export async function evaluateLeaves(
    root: SearchNode,
    options: { mode: "line" | "tree"; keepPlies?: number },
    deps: Pick<SearchDeps, "analyze"> & Pick<SearchDeps, "isCancelled">,
): Promise<number> {
    const keepPlies = options.keepPlies ?? Number.POSITIVE_INFINITY;
    const leaves: SearchNode[] = [];
    const collect = (node: SearchNode, via?: Edge) => {
        const kept = node.ply >= keepPlies ? [] : keptEdges(node, options.mode);
        if (kept.length === 0) {
            // A finished game is already worth a win, a loss or a draw.
            const finished = node.stopped === "checkmate" || node.stopped === "draw";
            if (!node.evaluation && !finished && !via?.score) leaves.push(node);
            return;
        }
        for (const edge of kept) if (edge.child) collect(edge.child, edge);
    };
    collect(root);

    let evaluated = 0;
    const evaluate = async (leaf: SearchNode) => {
        if (deps.isCancelled?.()) return;
        let best: Awaited<ReturnType<typeof deps.analyze>>[number] | undefined;
        try {
            [best] = await deps.analyze(leaf.fen, { purpose: "evaluation", multipv: 1 });
        } catch (e) {
            // An analysis the engine gave up because the search was stopped.
            if (deps.isCancelled?.()) return;
            throw e;
        }
        if (!best) return;
        leaf.evaluation = best.score;
        evaluated++;
    };
    await settleAll(leaves.map(evaluate));
    return evaluated;
}
