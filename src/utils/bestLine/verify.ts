import type { Color } from "chessops";
import { admissibleMoves } from "@/utils/bestLine";
import { backup, backupOptionsOf, type Edge, type SearchNode } from "./node";
import { sanKey } from "./position";
import { keptEdges } from "./project";
import type { SearchDeps, SearchParams } from "./search";

/**
 * Checks at the precise depth the moves the statistics chose. The fast
 * analysis only had to rule out the clearly bad ones; one deeper analysis,
 * restricted to the candidates and the engine's best move, says whether they
 * really are within tolerance. A candidate
 * the precise depth puts out of tolerance is dropped and the position is
 * decided again.
 */

export type VerifyOptions = SearchParams & { mode?: "line" | "tree" };

export type VerifyStats = {
    /** Positions analysed again at the precise depth. */
    checked: number;
    /** Positions whose move changed because of it. */
    changed: number;
};

/** Candidates that competed at a studied position. */
function contenders(node: SearchNode): Edge[] {
    return (node.edges ?? []).filter(
        (edge) =>
            edge.status === "chosen" || edge.status === "contender" || edge.status === "pruned",
    );
}

function turnOf(fen: string): Color {
    return fen.split(" ")[1] === "b" ? "black" : "white";
}

export async function verifyChoices(
    root: SearchNode,
    options: VerifyOptions,
    deps: Pick<SearchDeps, "analyze"> & Pick<SearchDeps, "isCancelled">,
): Promise<VerifyStats> {
    const stats: VerifyStats = { checked: 0, changed: 0 };
    if (options.preciseDepth === undefined) return stats;

    const nodes: SearchNode[] = [];
    const collect = (node: SearchNode) => {
        if (node.studied && node.edges) nodes.push(node);
        for (const edge of keptEdges(node, options.mode ?? "tree")) {
            if (edge.child) collect(edge.child);
        }
    };
    collect(root);

    for (const node of nodes) {
        if (deps.isCancelled?.()) break;
        const candidates = contenders(node);
        if (candidates.length === 0) continue;
        if (candidates.every((edge) => (edge.depth ?? 0) >= options.preciseDepth!)) continue;

        // The engine's best move, when it is no candidate, is what they are measured against.
        const best = node.engineBest;
        const reference =
            best && !candidates.some((edge) => sanKey(edge.san) === sanKey(best.sanMoves[0]))
                ? [best.uciMoves[0]]
                : [];
        const searchMoves = [...candidates.map((edge) => edge.uci), ...reference];
        const lines = await deps.analyze(node.fen, {
            purpose: "verification",
            multipv: searchMoves.length,
            searchMoves,
        });
        stats.checked++;

        const found = lines.flatMap((line) => {
            const edge = candidates.find(
                (candidate) => sanKey(candidate.san) === sanKey(line.sanMoves[0]),
            );
            return edge ? [{ edge, line }] : [];
        });
        // An engine that ignored the restriction tells us nothing about them.
        if (found.length === 0) continue;
        for (const { edge, line } of found) {
            edge.score = line.score;
            edge.depth = line.depth;
        }

        const admissible = admissibleMoves(lines, turnOf(node.fen), options.tolerance);
        const dropped = found.filter(({ line }) => !admissible.includes(line));
        if (dropped.length === 0) continue;
        const choiceDropped = dropped.some(({ edge }) => edge.status === "chosen");
        for (const { edge } of dropped) edge.status = "outOfTolerance";
        if (choiceDropped) {
            stats.changed++;
            // The others were only dropped against a move that is now gone.
            for (const edge of candidates) {
                if (edge.status === "pruned") edge.status = "contender";
            }
        }
        backup(node, backupOptionsOf(options.risk));
    }
    return stats;
}
