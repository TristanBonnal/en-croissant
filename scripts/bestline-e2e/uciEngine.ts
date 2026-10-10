import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { BestMoves } from "@/bindings";
import { playSan } from "@/utils/bestLine/position";
import { parseFen } from "chessops/fen";
import { Chess } from "chessops/chess";
import { makeSan } from "chessops/san";
import { parseUci } from "chessops/util";

/** A real UCI engine driven over stdio, for the end-to-end checks of the search. */
export class UciEngine {
    private proc: ChildProcessWithoutNullStreams;
    private waiting: ((line: string) => void) | null = null;
    private lines: string[] = [];
    calls: { purpose: string; seconds: number; depth: number }[] = [];

    constructor(path: string, options: Record<string, string | number>) {
        this.proc = spawn(path, []);
        createInterface({ input: this.proc.stdout }).on("line", (line) => {
            if (this.waiting) this.waiting(line);
            else this.lines.push(line);
        });
        this.send("uci");
        for (const [name, value] of Object.entries(options)) {
            this.send(`setoption name ${name} value ${value}`);
        }
    }

    private send(cmd: string) {
        this.proc.stdin.write(`${cmd}\n`);
    }

    private next(): Promise<string> {
        const buffered = this.lines.shift();
        if (buffered !== undefined) return Promise.resolve(buffered);
        return new Promise((resolve) => {
            this.waiting = (line) => {
                this.waiting = null;
                resolve(line);
            };
        });
    }

    private queue: Promise<unknown> = Promise.resolve();

    /** One analysis at a time, like the app's per-tab queue. */
    analyze(
        fen: string,
        depth: number,
        multipv: number,
        searchMoves: string[] = [],
    ): Promise<BestMoves[]> {
        const run = async () => {
            const setup = parseFen(fen).unwrap();
            const position = Chess.fromSetup(setup).unwrap();
            this.send(`setoption name MultiPV value ${multipv}`);
            this.send(`position fen ${fen}`);
            this.send(
                `go depth ${depth}${searchMoves.length ? ` searchmoves ${searchMoves.join(" ")}` : ""}`,
            );
            const byPv = new Map<number, BestMoves>();
            for (;;) {
                const line = await this.next();
                if (line.startsWith("bestmove")) break;
                const m = line.match(
                    /^info depth (\d+).* multipv (\d+) score (cp|mate) (-?\d+).* pv (.+)$/,
                );
                if (!m) continue;
                const uciMoves = m[5].split(" ");
                const walk = position.clone();
                const sanMoves: string[] = [];
                for (const uci of uciMoves) {
                    const move = parseUci(uci);
                    if (!move || !walk.isLegal(move)) break;
                    sanMoves.push(makeSan(walk, move));
                    walk.play(move);
                }
                // UCI scores are from the side to move's point of view, the app's from White's.
                const sign = position.turn === "black" ? -1 : 1;
                byPv.set(Number(m[2]), {
                    depth: Number(m[1]),
                    multipv: Number(m[2]),
                    nodes: 0,
                    nps: 0,
                    score: {
                        value: { type: m[3] as "cp" | "mate", value: sign * Number(m[4]) },
                        wdl: null,
                    },
                    uciMoves,
                    sanMoves,
                });
            }
            return [...byPv.values()].sort((a, b) => a.multipv - b.multipv);
        };
        const result = this.queue.then(run, run);
        this.queue = result.catch(() => {});
        return result;
    }

    quit() {
        this.send("quit");
        this.proc.kill();
    }
}

export { playSan };
