import { Chess, castlingSide } from "chessops/chess";
import { makeFen, parseFen } from "chessops/fen";
import { makeSanAndPlay, parseSan } from "chessops/san";
import { makeUci, squareRank } from "chessops/util";

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

/**
 * `san` in the UCI notation an engine expects, castling included (king to its
 * destination, not onto the rook as chessops and the explorer write it).
 */
export function uciOf(fen: string, san: string): string | undefined {
    const position = positionOf(fen);
    const move = position && parseSan(position, san);
    if (!position || !move || !("from" in move)) return undefined;
    const side = castlingSide(position, move);
    if (!side) return makeUci(move);
    const to = squareRank(move.from) * 8 + (side === "h" ? 6 : 2);
    return makeUci({ from: move.from, to });
}

/** Moves are matched by SAN, ignoring the check and comment marks engines add. */
export function sanKey(san: string): string {
    return san.replace(/[+#!?]/g, "");
}
