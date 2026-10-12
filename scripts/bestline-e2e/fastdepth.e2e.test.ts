import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect, test } from "vitest";
import type { BestMoves } from "@/bindings";
import { admissibleMoves } from "@/utils/bestLine";
import { playSan } from "@/utils/bestLine/position";
import { getWinChance, normalizeScore } from "@/utils/score";
import { UciEngine } from "./uciEngine";

/**
 * Does a shallower "fast" analysis still propose the same moves? For many
 * opening positions, the moves within the tolerance found by a reference
 * analysis (E2E_REFERENCE, default depth 20, 8 lines) are compared with those
 * of the app's fast analysis (5 lines, on one worker's 4 threads) at several
 * depths: moves it misses among the reference's first five lines (a fifth line
 * is all the fast analysis can show, whatever its depth), moves it adds, and
 * whether it finds the same best move. E2E_DEPTHS lists the depths to compare.
 * The reference analyses are kept in node_modules/.cache/bestline to be reused.
 */
const ENGINE = process.env.E2E_ENGINE;
const REFERENCE = Number(process.env.E2E_REFERENCE ?? 20);
const DEPTHS = (process.env.E2E_DEPTHS ?? "10,12,14,16").split(",").map(Number);
const TOLERANCE = Number(process.env.E2E_TOLERANCE ?? 3);
const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const LINES = [
    "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O",
    "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Be3 e5 Nb3 Be6",
    "d4 d5 c4 e6 Nc3 Nf6 Bg5 Be7 e3 O-O Nf3 h6 Bh4 b6",
    "d4 Nf6 c4 e6 Nc3 Bb4 e3 O-O Bd3 d5 Nf3 c5 O-O Nc6",
    "e4 e6 d4 d5 Nc3 Nf6 Bg5 Be7 e5 Nfd7 Bxe7 Qxe7 f4 O-O",
    "c4 e5 Nc3 Nf6 Nf3 Nc6 g3 d5 cxd5 Nxd5 Bg2 Nb6 O-O Be7",
    "e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d4 exd4 cxd4 Bb4+ Nc3 Nxe4",
    "e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5 Ng3 Bg6 h4 h6 Nf3 Nd7",
    "d4 Nf6 c4 g6 Nc3 Bg7 e4 d6 Nf3 O-O Be2 e5 O-O Nc6",
    "Nf3 d5 g3 Nf6 Bg2 c6 O-O Bg4 d3 Nbd7 Nbd2 e6 h3 Bh5",
    "e4 e5 Nf3 Nf6 Nxe5 d6 Nf3 Nxe4 d4 d5 Bd3 Nc6 O-O Be7",
    "e4 d6 d4 Nf6 Nc3 g6 f4 Bg7 Nf3 O-O Bd3 Na6 O-O c5",
];

const CACHE = `node_modules/.cache/bestline/reference-${REFERENCE}.json`;

function readCache(): Record<string, BestMoves[]> {
    try {
        return JSON.parse(readFileSync(CACHE, "utf8"));
    } catch {
        return {};
    }
}

function positions(): string[] {
    const seen = new Set<string>();
    for (const line of LINES) {
        let fen = START;
        seen.add(fen);
        for (const san of line.split(" ")) {
            const next = playSan(fen, san);
            if (!next) throw new Error(`illegal ${san} in ${line}`);
            fen = next.fen;
            seen.add(fen);
        }
    }
    return [...seen];
}

test.skipIf(!ENGINE)(
    "a shallower fast analysis finds the same admissible moves",
    async () => {
        const reference = new UciEngine(ENGINE as string, { Threads: 16, Hash: 2048 });
        const worker = new UciEngine(ENGINE as string, { Threads: 4, Hash: 512 });
        const fens = positions();
        const tolerance = { mode: "winChance", value: TOLERANCE } as const;
        const cache = readCache();
        const rows: Record<
            number,
            {
                missed: number;
                clearMissed: number;
                clear: number;
                badPositions: number;
                added: number;
                sameBest: number;
                seconds: number;
                truth: number;
                evalError: number;
            }
        > = {};
        for (const d of DEPTHS) {
            rows[d] = {
                missed: 0,
                clearMissed: 0,
                clear: 0,
                badPositions: 0,
                added: 0,
                sameBest: 0,
                seconds: 0,
                truth: 0,
                evalError: 0,
            };
        }
        for (const fen of fens) {
            const color = fen.split(" ")[1] === "w" ? "white" : "black";
            if (!cache[fen]) {
                cache[fen] = await reference.analyze(fen, REFERENCE, 8);
                mkdirSync("node_modules/.cache/bestline", { recursive: true });
                writeFileSync(CACHE, JSON.stringify(cache));
            }
            const truthLines = cache[fen];
            const everything = new Set(
                admissibleMoves(truthLines, color, tolerance).map((l) => l.sanMoves[0]),
            );
            const truth = new Set(
                admissibleMoves(truthLines.slice(0, 5), color, tolerance).map((l) => l.sanMoves[0]),
            );
            // The moves well inside the tolerance: missing one of those is a real loss.
            const clear = new Set(
                admissibleMoves(truthLines.slice(0, 5), color, {
                    mode: "winChance",
                    value: TOLERANCE / 2,
                }).map((l) => l.sanMoves[0]),
            );
            for (const d of DEPTHS) {
                const start = Date.now();
                const lines = await worker.analyze(fen, d, 5);
                rows[d].seconds += (Date.now() - start) / 1000;
                const found = new Set(
                    admissibleMoves(lines, color, tolerance).map((l) => l.sanMoves[0]),
                );
                rows[d].truth += truth.size;
                // How far the evaluation of the position is from the reference's, in win chance.
                const chance = (line?: BestMoves) =>
                    line ? getWinChance(normalizeScore(line.score.value, "white")) : 50;
                rows[d].evalError += Math.abs(chance(lines[0]) - chance(truthLines[0]));
                const missed = [...truth].filter((san) => !found.has(san)).length;
                rows[d].missed += missed;
                rows[d].clear += clear.size;
                rows[d].clearMissed += [...clear].filter((san) => !found.has(san)).length;
                if (missed > 0) rows[d].badPositions++;
                for (const san of found) if (!everything.has(san)) rows[d].added++;
                if (lines[0]?.sanMoves[0] === truthLines[0]?.sanMoves[0]) rows[d].sameBest++;
            }
        }
        console.log(
            `${fens.length} positions, reference depth ${REFERENCE}, tolerance ${TOLERANCE}%\n` +
                DEPTHS.map(
                    (d) =>
                        `depth ${String(d).padStart(2)}: missed ${rows[d].missed}/${rows[d].truth} admissible moves (in ${rows[d].badPositions} positions), ` +
                        `of which well inside the tolerance ${rows[d].clearMissed}/${rows[d].clear}, ` +
                        `added ${rows[d].added}, same best move ${rows[d].sameBest}/${fens.length}, ` +
                        `evaluation off by ${(rows[d].evalError / fens.length).toFixed(2)} win-chance points, ` +
                        `${rows[d].seconds.toFixed(1)}s`,
                ).join("\n"),
        );
        reference.quit();
        worker.quit();
        expect(fens.length).toBeGreaterThan(0);
    },
    3_600_000,
);
