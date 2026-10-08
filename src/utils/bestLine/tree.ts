import type { Edge, SearchNode } from "./node";

/**
 * The branch the search plays: the move chosen at the studied side's positions,
 * the most likely reply at the opponent's.
 */
export function mainBranch(root: SearchNode): Edge[] {
    const branch: Edge[] = [];
    let node: SearchNode | undefined = root;
    while (node?.edges && node.edges.length > 0) {
        const edge: Edge | undefined = node.studied
            ? node.edges.find((e) => e.status === "chosen")
            : node.edges
                  .filter((e) => e.status === "reply")
                  .reduce<Edge | undefined>(
                      (best, e) => (!best || e.probability > best.probability ? e : best),
                      undefined,
                  );
        if (!edge) break;
        branch.push(edge);
        node = edge.child;
    }
    return branch;
}
