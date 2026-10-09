import { Frontier } from "./frontier";
import { type BackupOptions, type Edge, liveEdges, type SearchNode } from "./node";

/**
 * Which position to open next. The search opens the positions that can still
 * change a decision, not the ones that merely carry the most uncertainty.
 *
 * Every position not opened yet is given an optimistic value: its own, plus
 * what the studied side is hoped to gain by choosing its moves at the
 * positions left below it (`Lookahead`). These values are backed up with the
 * search's own rules, the studied side picking the move whose optimistic mean
 * has the best lower bound. The moves picked that way form the *candidate
 * tree*: the tree that would be best if every hope came true.
 *
 * The candidate tree is searched first, at the position that adds the most
 * optimism to the result. Searching it either confirms it or brings it down
 * until another move takes over. Once it holds no unopened position, no other
 * move can beat it even with the same hopes, so the moves it plays are the
 * ones the search keeps, and positions below the other moves stay closed.
 */

/** What searching below a position the search has not opened can add. */
export type Lookahead = {
    /** Plies the search goes down to. */
    maxPlies: number;
    /** What choosing its move is hoped to add at each studied position. */
    choiceGain: number;
};

/** Keeps the order of positions readable when no hope is left. */
const SIGMA_FLOOR = 0.01;

/** Studied positions between a node and the end of the search, the node included. */
function choicesLeft(node: SearchNode, maxPlies: number): number {
    const plies = Math.max(0, maxPlies - node.ply);
    return node.studied ? Math.ceil(plies / 2) : Math.floor(plies / 2);
}

/** Whether the search still has to open a node. */
function isOpen(node: SearchNode): boolean {
    return !node.edges && !node.stopped;
}

/** Replies of an opponent node that the search goes on below. */
function followed(node: SearchNode): Edge[] {
    return (node.edges ?? []).filter((edge) => edge.status !== "other");
}

/**
 * The candidate the studied side plays in the candidate tree: the best lower
 * bound once every hope came true, the uncertainty kept as it is. Ties keep
 * the chosen move.
 */
function pickOptimistic(
    node: SearchNode,
    meanOf: (edge: Edge) => number,
    options: BackupOptions,
): Edge | undefined {
    const live = liveEdges(node);
    const bound = (edge: Edge) => meanOf(edge) - options.risk * edge.value.sigma;
    let pick = live.find((edge) => edge.status === "chosen") ?? live[0];
    for (const edge of live) if (pick && bound(edge) > bound(pick)) pick = edge;
    return pick;
}

/** Optimistic mean of every node below `root`. */
function optimisticMeans(
    root: SearchNode,
    options: BackupOptions,
    lookahead: Lookahead,
): Map<SearchNode, number> {
    const means = new Map<SearchNode, number>();
    const edgeMean = (edge: Edge) => (edge.child ? meanOf(edge.child) : edge.value.mean);
    const meanOf = (node: SearchNode): number => {
        const known = means.get(node);
        if (known !== undefined) return known;
        let mean = node.value.mean;
        if (isOpen(node)) {
            const hope = lookahead.choiceGain * choicesLeft(node, lookahead.maxPlies);
            mean = Math.min(1, mean + hope);
        } else if (node.studied) {
            const pick = pickOptimistic(node, edgeMean, options);
            if (pick) mean = edgeMean(pick);
        } else if (node.edges && node.edges.length > 0) {
            mean = followed(node).reduce((acc, edge) => acc + edge.probability * edgeMean(edge), 0);
            if (node.rest) mean += node.rest.weight * node.rest.value.mean;
        }
        means.set(node, mean);
        return mean;
    };
    meanOf(root);
    return means;
}

/** Unopened positions of the tree the moves picked by `pick` play, with their priority. */
function leavesOf(
    root: SearchNode,
    pick: (node: SearchNode) => Edge | undefined,
    priority: (node: SearchNode) => number,
): Frontier<SearchNode> {
    const frontier = new Frontier<SearchNode>();
    const walk = (node: SearchNode) => {
        if (isOpen(node)) {
            frontier.push(node, priority(node));
            return;
        }
        if (node.studied) {
            const edge = pick(node);
            if (edge?.child) walk(edge.child);
            return;
        }
        for (const edge of followed(node)) if (edge.child) walk(edge.child);
    };
    walk(root);
    return frontier;
}

/**
 * The positions to open next, most urgent first: those of the candidate tree,
 * by how much optimism they add to the result. Once it has none left, those
 * the chosen moves still lead to, as the tree the search returns must be
 * complete. Empty when the search is over.
 */
export function nextPositions(
    root: SearchNode,
    options: BackupOptions,
    lookahead: Lookahead,
): Frontier<SearchNode> {
    const means = optimisticMeans(root, options, lookahead);
    const meanOf = (edge: Edge) =>
        edge.child ? (means.get(edge.child) ?? edge.value.mean) : edge.value.mean;
    const hopeOf = (node: SearchNode) => (means.get(node) ?? node.value.mean) - node.value.mean;
    const candidate = leavesOf(
        root,
        (node) => pickOptimistic(node, meanOf, options),
        (node) => node.reach * (hopeOf(node) + SIGMA_FLOOR),
    );
    if (candidate.size > 0) return candidate;
    return leavesOf(
        root,
        (node) => node.edges?.find((edge) => edge.status === "chosen"),
        (node) => node.reach * (node.value.sigma + SIGMA_FLOOR),
    );
}
