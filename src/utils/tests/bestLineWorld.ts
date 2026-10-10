import type { Color } from "chessops";
import { INITIAL_FEN } from "chessops/fen";
import type { BestMoves } from "@/bindings";
import { admissibleMoves, type AnalysisRequest, type ExplorerPosition } from "@/utils/bestLine";
import { legalSans, playSan, sanKey, uciOf } from "@/utils/bestLine/position";
import type { SearchNode } from "@/utils/bestLine/node";
import type { SearchParams } from "@/utils/bestLine/search";
import { positionKey } from "@/utils/bestLineCache";

/**
 * A made-up opening whose truth is known, to judge the choices of a search
 * against what they really are worth. Every position has a few moves with a
 * popularity, an engine loss, and a result for the games played from it; the
 * explorer a search sees is a *sample* of those games, and the engine's answers
 * are exact. The truth never leaks: a policy is only given the sample.
 *
 * The result of the games played from a position is the average of its moves'
 * (`W`): what everybody who got there scored, the studied side's own mistakes
 * included. What a *careful* player can get by choosing his moves (`V`) is
 * what a search is after.
 */

export type WorldOptions = {
    seed: number;
    studied: Color;
    rootFen?: string;
    /** Moves known in each position. */
    branching?: number;
    /** Plies from the root after which a position has no move. */
    horizon?: number;
    /** Games at the root. */
    games?: number;
    drawRate?: number;
    /** Spread of what a continuation is worth beyond what the engine says. */
    practicalNoise?: number;
    /**
     * Centipawns per logit of the result the engine's evaluation predicts: the
     * search assumes 271.6 (Lichess' win chance), club players' results follow
     * the evaluation less steeply.
     */
    engineScale?: number;
};

type WorldMove = {
    san: string;
    uci: string;
    child: WorldNode;
    /** How often the move is played. */
    pop: number;
    /** What the move costs its player, in centipawns. */
    loss: number;
};

type WorldNode = {
    fen: string;
    key: string;
    ply: number;
    studiedToMove: boolean;
    /** Engine evaluation, in centipawns for the studied side. */
    cp: number;
    moves: WorldMove[];
    /** Result of the games played from here for the studied side, in [0, 1]. */
    W: number;
};

/** Small, seedable generator: the same seed always makes the same world. */
export function rng(seed: number) {
    let a = seed >>> 0;
    const next = () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const normal = () => {
        const u = Math.max(next(), 1e-12);
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
    };
    return { next, normal };
}

function hash(text: string, seed: number) {
    let h = 2166136261 ^ seed;
    for (let i = 0; i < text.length; i++) {
        h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    }
    return h >>> 0;
}

/** Binomial sample, exact for small counts and normal beyond. */
function binomial(n: number, p: number, random: ReturnType<typeof rng>): number {
    if (n <= 0 || p <= 0) return 0;
    if (p >= 1) return n;
    if (n < 40) {
        let k = 0;
        for (let i = 0; i < n; i++) if (random.next() < p) k++;
        return k;
    }
    const k = Math.round(n * p + Math.sqrt(n * p * (1 - p)) * random.normal());
    return Math.min(n, Math.max(0, k));
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export class World {
    readonly root: WorldNode;
    readonly studied: Color;
    readonly options: Required<Omit<WorldOptions, "rootFen" | "studied" | "seed">> & {
        seed: number;
    };
    private nodes = new Map<string, WorldNode>();
    private games = new Map<string, number>();
    private samples = new Map<string, ExplorerPosition>();

    constructor(options: WorldOptions) {
        this.studied = options.studied;
        this.options = {
            seed: options.seed,
            branching: options.branching ?? 4,
            horizon: options.horizon ?? 7,
            games: options.games ?? 1_000_000,
            drawRate: options.drawRate ?? 0.25,
            practicalNoise: options.practicalNoise ?? 0.35,
            engineScale: options.engineScale ?? 271.6,
        };
        const rootFen = options.rootFen ?? INITIAL_FEN;
        this.root = this.build(rootFen);
        this.games.set(this.root.key, this.options.games);
        // Every sample is drawn now, from the top: what a position holds must not
        // depend on which policy happens to look at it first.
        const byPly = [...this.nodes.values()].sort((a, b) => a.ply - b.ply);
        for (const node of byPly) this.exploreSync(node.fen);
    }

    private build(rootFen: string): WorldNode {
        const make = (fen: string, ply: number, cp: number): WorldNode => ({
            fen,
            key: positionKey(fen),
            ply,
            studiedToMove: (fen.split(" ")[1] === "w") === (this.studied === "white"),
            cp,
            moves: [],
            W: 0.5,
        });
        const root = make(rootFen, 0, 0);
        this.nodes.set(root.key, root);
        const queue = [root];
        for (let head = 0; head < queue.length; head++) {
            const node = queue[head];
            if (node.ply >= this.options.horizon) continue;
            const random = rng(hash(node.key, this.options.seed));
            const sans = legalSans(node.fen, this.options.branching);
            const losses = sans.map(() => {
                const sound = Math.abs(random.normal()) * 45;
                return random.next() < 0.15 ? sound + 150 + random.next() * 150 : sound;
            });
            const best = Math.min(...losses);
            const weights = sans.map((_, i) => {
                const loss = losses[i] - best;
                return random.next() ** 3 * Math.exp(-loss / 150) + 1e-3;
            });
            const total = weights.reduce((a, b) => a + b, 0);
            sans.forEach((san, i) => {
                const next = playSan(node.fen, san);
                if (!next) return;
                const loss = losses[i] - best;
                const cp = node.cp + (node.studiedToMove ? -loss : loss);
                const key = positionKey(next.fen);
                let child = this.nodes.get(key);
                if (!child) {
                    child = make(next.fen, node.ply + 1, cp);
                    this.nodes.set(key, child);
                    queue.push(child);
                } else if (child.ply !== node.ply + 1) {
                    // Back to an earlier position, or reached in another number of moves.
                    return;
                }
                node.moves.push({
                    san,
                    uci: uciOf(node.fen, san) ?? "",
                    child,
                    pop: weights[i] / total,
                    loss,
                });
            });
            const sum = node.moves.reduce((a, m) => a + m.pop, 0);
            for (const move of node.moves) move.pop /= sum;
        }
        // Results, from the leaves up.
        const byPly = [...this.nodes.values()].sort((a, b) => b.ply - a.ply);
        for (const node of byPly) {
            if (node.moves.length === 0) {
                const noise = rng(hash(`${node.key}|leaf`, this.options.seed)).normal();
                node.W = sigmoid(
                    node.cp / this.options.engineScale + noise * this.options.practicalNoise,
                );
            } else {
                node.W = node.moves.reduce((acc, m) => acc + m.pop * m.child.W, 0);
            }
        }
        return root;
    }

    nodeAt(fen: string): WorldNode | undefined {
        return this.nodes.get(positionKey(fen));
    }

    get size() {
        return this.nodes.size;
    }

    // --- what a search is given ---------------------------------------------

    /** The sample of games the explorer answers for a position. */
    exploreSync(fen: string): ExplorerPosition {
        const key = positionKey(fen);
        const known = this.samples.get(key);
        if (known) return known;
        const node = this.nodes.get(key);
        if (!node) return { white: 0, draws: 0, black: 0, moves: [] };
        const random = rng(hash(`${key}|games`, this.options.seed));
        let left = this.games.get(key) ?? 0;
        let mass = 1;
        const draw = this.options.drawRate;
        const moves = node.moves.map((move) => {
            const n = binomial(left, Math.min(1, move.pop / mass), random);
            left -= n;
            mass -= move.pop;
            if (!this.games.has(move.child.key)) this.games.set(move.child.key, n);
            // A drawn game is half a point: the share of wins is what is left of the score.
            const pWin = Math.min(1 - draw, Math.max(0, move.child.W - draw / 2));
            const wins = binomial(n, pWin, random);
            const draws = binomial(n - wins, draw / (1 - pWin), random);
            const losses = n - wins - draws;
            const studiedWhite = this.studied === "white";
            return {
                san: move.san,
                uci: move.uci,
                white: studiedWhite ? wins : losses,
                draws,
                black: studiedWhite ? losses : wins,
            };
        });
        const sum = (pick: (m: (typeof moves)[number]) => number) =>
            moves.reduce((acc, m) => acc + pick(m), 0);
        const sample = {
            white: sum((m) => m.white),
            draws: sum((m) => m.draws),
            black: sum((m) => m.black),
            moves,
        };
        this.samples.set(key, sample);
        return sample;
    }

    explore = async (fen: string) => this.exploreSync(fen);

    /** The engine's lines for a position, exact: best first for the side to move. */
    linesOf(fen: string, request: AnalysisRequest = { purpose: "candidates" }): BestMoves[] {
        const node = this.nodes.get(positionKey(fen));
        if (!node) return [];
        const precise = request.purpose !== "evaluation";
        const restricted = request.searchMoves?.length
            ? node.moves.filter((m) => request.searchMoves?.includes(m.uci))
            : node.moves;
        const mover = node.studiedToMove ? 1 : -1;
        const sign = this.studied === "white" ? 1 : -1;
        return [...restricted]
            .map((move) => ({
                move,
                // Studied-side centipawns after the move. (Not the child's own: a
                // position reached by two move orders has only one of them.)
                cp: node.cp + (node.studiedToMove ? -move.loss : move.loss),
            }))
            .sort((a, b) => mover * (b.cp - a.cp))
            .slice(0, request.multipv ?? 5)
            .map(
                ({ move, cp }, i): BestMoves => ({
                    depth: precise ? 18 : 14,
                    multipv: i + 1,
                    nodes: 0,
                    nps: 0,
                    score: { value: { type: "cp", value: sign * cp }, wdl: null },
                    sanMoves: [move.san],
                    uciMoves: [move.uci],
                }),
            );
    }

    analyze = async (fen: string, request: AnalysisRequest) => this.linesOf(fen, request);

    // --- what the choices are worth -----------------------------------------

    /**
     * Result a careful player gets from `node` by choosing his moves with
     * `choose` (returning undefined where the policy has no move, which leaves
     * the rest of the game to chance): the opponent's replies weighted by how
     * often they are played, those rarer than `minReach` left to chance too.
     */
    valueOf(
        choose: (node: WorldNode) => string | undefined,
        { maxPlies, minReach }: { maxPlies: number; minReach: number },
        node: WorldNode = this.root,
        reach = 1,
    ): number {
        if (node.ply - this.root.ply >= maxPlies || node.moves.length === 0) return node.W;
        if (node.studiedToMove) {
            const san = choose(node);
            const move = san ? node.moves.find((m) => sanKey(m.san) === sanKey(san)) : undefined;
            if (!move) return node.W;
            return this.valueOf(choose, { maxPlies, minReach }, move.child, reach);
        }
        const mostPlayed = node.moves.reduce((a, b) => (b.pop > a.pop ? b : a));
        return node.moves.reduce((acc, move) => {
            const r = reach * move.pop;
            const followed = r >= minReach || move === mostPlayed;
            const value = followed
                ? this.valueOf(choose, { maxPlies, minReach }, move.child, r)
                : move.child.W;
            return acc + move.pop * value;
        }, 0);
    }

    /** The best a careful player can do: true expectimax among the moves the engine allows. */
    oracle(
        tolerance: number,
        { maxPlies, minReach }: { maxPlies: number; minReach: number },
    ): number {
        const memo = new Map<WorldNode, string | undefined>();
        const choose = (node: WorldNode): string | undefined => {
            if (memo.has(node)) return memo.get(node);
            const allowed = node.moves.filter((m) => m.loss <= tolerance);
            let best: WorldMove | undefined;
            let bestValue = -1;
            for (const move of allowed) {
                const v = this.valueOf(
                    choose,
                    { maxPlies, minReach },
                    move.child,
                    // Reach does not matter for the choice: the oracle knows every branch.
                    1,
                );
                if (v > bestValue) {
                    bestValue = v;
                    best = move;
                }
            }
            memo.set(node, best?.san);
            return best?.san;
        };
        return this.valueOf(choose, { maxPlies, minReach });
    }
}

export type Rule = "engine" | "mostPlayed" | "bestScore";

/**
 * A simple way to choose the studied side's move: the engine's best, the most
 * played of the engine's sound moves, or the one with the best raw score among
 * them (only moves played enough to be ranked, and positions known enough).
 */
export function ruleChoice(world: World, rule: Rule, p: SearchParams) {
    return (node: WorldNode): string | undefined => {
        const explorer = world.exploreSync(node.fen);
        const total = explorer.white + explorer.draws + explorer.black;
        const lines = world.linesOf(node.fen, { purpose: "candidates", multipv: 5 });
        const best = lines[0]?.sanMoves[0];
        if (rule === "engine" || total < p.minimumGames) return best;
        const color = node.fen.split(" ")[1] === "w" ? "white" : "black";
        const allowed = new Set(
            admissibleMoves(lines, color, p.tolerance).map((l) => l.sanMoves[0]),
        );
        const games = (m: { white: number; draws: number; black: number }) =>
            m.white + m.draws + m.black;
        const eligible = explorer.moves.filter(
            (m) =>
                allowed.has(m.san) &&
                games(m) >= p.minGamesPerMove &&
                games(m) >= p.minMoveShare * total,
        );
        if (eligible.length === 0) return best;
        const mine = (m: { white: number; draws: number; black: number }) =>
            (p.color === "white" ? m.white : m.black) + 0.5 * m.draws;
        const pick = (better: (a: (typeof eligible)[0], b: (typeof eligible)[0]) => boolean) =>
            eligible.reduce((a, b) => (better(b, a) ? b : a)).san;
        return rule === "mostPlayed"
            ? pick((b, a) => games(b) > games(a))
            : pick((b, a) => mine(b) / games(b) > mine(a) / games(a));
    };
}

/** The move a search tree plays in each position it opened for the studied side. */
export function chosenMoves(root: SearchNode): Map<string, string> {
    const chosen = new Map<string, string>();
    const walk = (node: SearchNode) => {
        for (const edge of node.edges ?? []) {
            if (node.studied && edge.status === "chosen")
                chosen.set(positionKey(node.fen), edge.san);
            if (edge.child) walk(edge.child);
        }
    };
    walk(root);
    return chosen;
}

export type { WorldNode };
