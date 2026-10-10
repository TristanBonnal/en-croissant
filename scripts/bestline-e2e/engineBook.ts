import type { BestMoves } from "@/bindings";
import type { ExplorerPosition } from "@/utils/bestLine";
import { playSan } from "@/utils/bestLine/position";
import type { UciEngine } from "./uciEngine";

/**
 * A made-up Lichess explorer for the end-to-end checks (the real one needs a
 * token): humans-like replies in each position, weighted by how good the engine
 * finds them, with results that follow its evaluation. The games of a position
 * are those of the move that led to it, so counts shrink along a line.
 */
export function engineBook(
    engine: UciEngine,
    startFen: string,
    startGames = 2_000_000,
    unknownGames = 600,
) {
    const games = new Map<string, number>([[startFen, startGames]]);
    const memo = new Map<string, Promise<ExplorerPosition>>();
    return (fen: string): Promise<ExplorerPosition> => {
        const key = fen.split(" ").slice(0, 4).join(" ");
        let known = memo.get(key);
        if (!known) {
            known = (async () => {
                const total = games.get(fen) ?? unknownGames;
                const lines = await engine.analyze(fen, 8, 8);
                const white = fen.split(" ")[1] === "w";
                // Scores are White's; a player's own point of view is what weighs his moves.
                const whiteCp = (l: BestMoves) =>
                    l.score.value.type === "cp"
                        ? l.score.value.value
                        : Math.sign(l.score.value.value) * 1000;
                const moverCp = (l: BestMoves) => whiteCp(l) * (white ? 1 : -1);
                const best = lines[0] ? moverCp(lines[0]) : 0;
                const weights = lines.map((l) => Math.exp((moverCp(l) - best) / 60));
                const sum = weights.reduce((a, b) => a + b, 0);
                const moves = lines.map((l, i) => {
                    const n = Math.round((total * weights[i]) / sum);
                    const pw = 1 / (1 + Math.exp(-whiteCp(l) / 250));
                    const next = playSan(fen, l.sanMoves[0]);
                    if (next) games.set(next.fen, n);
                    return {
                        san: l.sanMoves[0],
                        uci: l.uciMoves[0],
                        white: Math.round(n * pw * 0.8),
                        draws: Math.round(n * 0.2 + n * 0.1 * (1 - Math.abs(2 * pw - 1))),
                        black: n - Math.round(n * pw * 0.8) - Math.round(n * 0.2),
                    };
                });
                const t = moves.reduce((a, m) => a + m.white + m.draws + m.black, 0);
                return {
                    white: moves.reduce((a, m) => a + m.white, 0),
                    draws: moves.reduce((a, m) => a + m.draws, 0),
                    black: t - moves.reduce((a, m) => a + m.white + m.draws, 0),
                    moves,
                };
            })();
            memo.set(key, known);
        }
        return known;
    };
}
