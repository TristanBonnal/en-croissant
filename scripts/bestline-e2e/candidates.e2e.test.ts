import { expect, test } from "vitest";
import { admissibleMoves } from "@/utils/bestLine";
import { playSan } from "@/utils/bestLine/position";
import { UciEngine } from "./uciEngine";

/**
 * How many of an engine's moves are within the search's tolerance in typical
 * opening positions, and what asking for more lines costs. The search only
 * proposes the engine's first `MAX_CANDIDATES` lines, so a position where more
 * moves are admissible leaves some of them out.
 */
const ENGINE = process.env.E2E_ENGINE;
const DEPTH = Number(process.env.E2E_PRECISE ?? 18);
const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const LINES: Record<string, string> = {
    start: "",
    "1.e4": "e4",
    "1.e4 e5 2.Nf3": "e4 e5 Nf3",
    "Sicilian 2.Nf3": "e4 c5 Nf3",
    "Queen's Gambit": "d4 d5 c4",
    "Ruy Lopez 3.Bb5": "e4 e5 Nf3 Nc6 Bb5",
    "Closed Ruy": "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O",
    "Nimzo 4.e3": "d4 Nf6 c4 e6 Nc3 Bb4 e3",
    "French Classical": "e4 e6 d4 d5 Nc3 Nf6 Bg5",
    "English 1...e5": "c4 e5",
    "Italian 6...Bb4+": "e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d4 exd4 cxd4 Bb4+",
    "Najdorf 5.Nc3": "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3",
};

function fenAfter(sans: string): string {
    let fen = START;
    for (const san of sans.split(" ").filter(Boolean)) {
        const next = playSan(fen, san);
        if (!next) throw new Error(`illegal ${san}`);
        fen = next.fen;
    }
    return fen;
}

test.skipIf(!ENGINE)(
    "candidates within tolerance",
    async () => {
        const engine = new UciEngine(ENGINE as string, { Threads: 16, Hash: 2048 });
        const rows: string[] = [];
        let total5 = 0;
        let total8 = 0;
        let total12 = 0;
        for (const [name, sans] of Object.entries(LINES)) {
            const fen = fenAfter(sans);
            const color = fen.split(" ")[1] === "w" ? "white" : "black";
            const time = async (multipv: number) => {
                const start = Date.now();
                const lines = await engine.analyze(fen, DEPTH, multipv);
                return { lines, seconds: (Date.now() - start) / 1000 };
            };
            const five = await time(5);
            const eight = await time(8);
            const twelve = await time(12);
            total5 += five.seconds;
            total8 += eight.seconds;
            total12 += twelve.seconds;
            const count = (mode: "pawns" | "winChance", value: number) =>
                admissibleMoves(twelve.lines, color, { mode, value }).length;
            rows.push(
                `${name.padEnd(18)} pawns0.3: ${String(count("pawns", 0.3)).padStart(2)} | ` +
                    `win3%: ${String(count("winChance", 3)).padStart(2)} | ` +
                    `time mpv5 ${five.seconds.toFixed(1)}s mpv8 ${eight.seconds.toFixed(1)}s mpv12 ${twelve.seconds.toFixed(1)}s | ` +
                    `moves ${twelve.lines.map((l) => `${l.sanMoves[0]}:${l.score.value.type === "cp" ? l.score.value.value : "M"}`).join(" ")}`,
            );
        }
        console.log(
            `depth ${DEPTH}\n${rows.join("\n")}\ntotal mpv5 ${total5.toFixed(1)}s mpv8 ${total8.toFixed(1)}s mpv12 ${total12.toFixed(1)}s`,
        );
        engine.quit();
        expect(rows.length).toBe(Object.keys(LINES).length);
    },
    1_800_000,
);
