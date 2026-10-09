import type { BestMoves, Score } from "@/bindings";
import type { Outcome, Rates } from "./stats";
import { totalGames } from "./stats";
import { bestValue, lowerBound, mixValue, upperBound, type Value } from "./value";

/**
 * The search tree. Nodes are mutable and point back to their parent: an
 * expansion changes one leaf, and the new value is carried up the branch it
 * came from. Everything that *decides* something (values, bounds, mixing)
 * lives in pure functions; this module only applies them to the tree.
 */

export type EdgeStatus =
    /** The move the search plays here. */
    | "chosen"
    /** Still competing with the chosen move. */
    | "contender"
    /** Cannot catch up with the chosen move any more. */
    | "pruned"
    /** Rejected by the engine's tolerance. */
    | "outOfTolerance"
    /** Too few games to be ranked on its results. */
    | "fewGames"
    /** An opponent reply the search follows. */
    | "reply"
    /** Listed, never searched. */
    | "other";

export type Edge = {
    san: string;
    uci: string;
    /** Games played after this move, for the studied side. */
    outcome: Outcome;
    /** How likely the opponent is to play it (opponent nodes only). */
    probability: number;
    /** Engine line of the move, when it was analysed, and the depth it came from. */
    score?: Score;
    depth?: number;
    /**
     * Whether the engine has compared the move with its best one. Candidates
     * are taken from the explorer and only checked once the search needs them.
     */
    checked?: boolean;
    status: EdgeStatus;
    /** Value of its child once expanded, else the value of the move itself. */
    value: Value;
    child?: SearchNode;
    /** Played because it was asked for, not because the search chose it. */
    forced?: boolean;
    /** Expansions carried out in its subtree. */
    expansions: number;
};

export type StopReason = "checkmate" | "draw" | "maxPly" | "outOfBook" | "lowReach" | "noMove";

export type SearchNode = {
    fen: string;
    /** Whether the studied side is to move. */
    studied: boolean;
    ply: number;
    /** How likely a game is to reach this position (product of the opponent's shares). */
    reach: number;
    parent?: { node: SearchNode; edge: Edge };
    /** Shrunk rates of the position: what its own moves are shrunk towards. */
    rates?: Rates;
    outcome: Outcome;
    edges?: Edge[];
    /** Replies the search leaves out, with the value of the position itself. */
    rest?: { weight: number; value: Value };
    /** Games the opponent's shares are measured on. */
    weightSamples?: number;
    value: Value;
    stopped?: StopReason;
    /** The engine's first lines at the fast depth, the best one being what candidates are checked against. */
    engineLines?: BestMoves[];
};

export type BackupOptions = {
    /** Standard errors taken off a value before comparing it (risk aversion). */
    risk: number;
    /** Standard errors a candidate is given before being dropped. */
    pruneZ: number;
    /** Difference under which two candidates are considered equal. */
    indifference: number;
};

/** Standard errors a candidate is given before it is dropped. */
export const PRUNE_Z = 2.5;

/** Difference under which two candidates are considered equal. */
export const INDIFFERENCE = 0.005;

export function backupOptionsOf(risk: number): BackupOptions {
    return { risk, pruneZ: PRUNE_Z, indifference: INDIFFERENCE };
}

/** Candidates still competing at a studied node. */
export function liveEdges(node: SearchNode): Edge[] {
    return (node.edges ?? []).filter((e) => e.status === "contender" || e.status === "chosen");
}

/** Whether every move leading to this node is still being searched. */
export function isLive(node: SearchNode): boolean {
    for (let current = node; current.parent; current = current.parent.node) {
        const { status } = current.parent.edge;
        if (status === "pruned" || status === "outOfTolerance") return false;
    }
    return true;
}

/**
 * Recomputes the value of a node from its moves, then carries it up to the
 * root. At a studied node the best candidate is picked and the ones that can
 * no longer catch up are dropped; at an opponent node the replies are averaged
 * by how often they are played.
 */
export function backup(node: SearchNode, options: BackupOptions): { pruned: number } {
    let pruned = 0;
    let current: SearchNode = node;
    for (;;) {
        if (current.edges && current.edges.length > 0) {
            if (current.studied) {
                const decided = decide(current, options);
                current.value = decided.value;
                pruned += decided.pruned;
            } else {
                current.value = expectation(current);
            }
        }
        const parent: SearchNode["parent"] = current.parent;
        if (!parent) return { pruned };
        parent.edge.value = current.value;
        current = parent.node;
    }
}

/**
 * Value of an opponent node: its replies, weighted by how often they are played.
 * The replies only listed are part of the games the rest stands for.
 */
function expectation(node: SearchNode): Value {
    const parts = (node.edges ?? [])
        .filter((edge) => edge.status !== "other")
        .map((edge) => ({
            weight: edge.probability,
            value: edge.value,
        }));
    if (node.rest) parts.push(node.rest);
    return mixValue(parts, node.weightSamples ?? Number.POSITIVE_INFINITY);
}

/**
 * Value of a studied node: the best candidate, compared on its lower bound so
 * that a flattering small sample has to beat a solid move by more than its own
 * noise. Candidates that cannot be told apart are settled on the most played
 * one, which both reproduces the previous behaviour and guarantees the search
 * stops: an expansion never brings in new games, so two equal candidates would
 * otherwise compete forever.
 */
function decide(node: SearchNode, options: BackupOptions): { value: Value; pruned: number } {
    const live = liveEdges(node);
    if (live.length === 0) return { value: node.value, pruned: 0 };

    const leader = bestValue(
        live.map((e) => e.value),
        options.risk,
    ).value;
    const tied = live.filter((e) => Math.abs(e.value.mean - leader.mean) <= options.indifference);
    const chosen = tied.reduce((a, b) => (totalGames(b.outcome) > totalGames(a.outcome) ? b : a));

    let pruned = 0;
    for (const edge of live) {
        if (edge === chosen) {
            edge.status = "chosen";
            continue;
        }
        const drop = edge.expansions > 0 && cannotCatchUp(edge, chosen, options);
        if (drop && edge.status !== "pruned") pruned++;
        edge.status = drop ? "pruned" : "contender";
    }
    return { value: chosen.value, pruned };
}

/**
 * Whether searching `edge` further cannot change the decision: either its best
 * case stays under the chosen move's worst case, or the two are so close that
 * the chosen move's larger sample settles it.
 */
function cannotCatchUp(edge: Edge, chosen: Edge, options: BackupOptions): boolean {
    if (Math.abs(edge.value.mean - chosen.value.mean) <= options.indifference) return true;
    return (
        upperBound(edge.value, options.pruneZ) + options.indifference <
        lowerBound(chosen.value, options.pruneZ)
    );
}
