import { Chess } from "chessops/chess";
import { makeFen, parseFen } from "chessops/fen";
import { makeSanAndPlay, parseSan } from "chessops/san";

/** Chess helpers the search needs, kept in one place so the rules live in chessops only. */

export function positionOf(fen: string): Chess | null {
    const setup = parseFen(fen);
    if (setup.isErr) return null;
    const position = Chess.fromSetup(setup.unwrap());
    return position.isErr ? null : position.unwrap();
}

/** Number of legal moves, which the smoothing of the explorer shares needs. */
export function legalMoveCount(fen: string): number {
    const position = positionOf(fen);
    if (!position) return 0;
    let count = 0;
    for (const [, dests] of position.allDests()) count += dests.size();
    return count;
}

/** The first `max` legal moves in SAN, in chessops' order (used by tests). */
export function legalSans(fen: string, max: number): string[] {
    const position = positionOf(fen);
    if (!position) return [];
    const sans: string[] = [];
    for (const [from, dests] of position.allDests()) {
        for (const to of dests) {
            if (sans.length >= max) return sans;
            const clone = position.clone();
            sans.push(makeSanAndPlay(clone, { from, to }));
        }
    }
    return sans;
}

/** Position after `san`, or null when the move is not legal there. */
export function playSan(fen: string, san: string): { fen: string; position: Chess } | null {
    const position = positionOf(fen);
    if (!position) return null;
    const move = parseSan(position, san);
    if (!move) return null;
    position.play(move);
    return { fen: makeFen(position.toSetup()), position };
}

/** Moves are matched by SAN, ignoring the check and comment marks engines add. */
export function sanKey(san: string): string {
    return san.replace(/[+#!?]/g, "");
}
