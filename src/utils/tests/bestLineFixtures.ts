import { INITIAL_FEN } from "chessops/fen";
import type { BestMoves } from "@/bindings";
import { legalSans } from "@/utils/bestLine/position";
import type { SearchParams } from "@/utils/bestLine/search";

/**
 * A book where every position looks the same: `shares` of its games go to its
 * first legal moves, the rest to moves the explorer does not list. Results are
 * asymmetric (50/20/30) so that a point of view can be told from its mirror.
 */
export function fakeBook({
    games = 100_000,
    shares = [0.6, 0.3],
    thin = {},
}: { games?: number; shares?: number[]; thin?: Record<string, number> } = {}) {
    const explored: string[] = [];
    const split = (total: number) => {
        const white = Math.round(total * 0.5);
        const draws = Math.round(total * 0.2);
        return { white, draws, black: total - white - draws };
    };
    const explore = async (fen: string) => {
        explored.push(fen);
        const total = thin[fen] ?? games;
        const moves = legalSans(fen, shares.length).map((san, i) => ({
            san,
            uci: san,
            ...split(Math.round(total * shares[i])),
        }));
        return { ...split(total), moves };
    };
    return { explore, explored };
}

type Request = { purpose: string; multipv?: number; searchMoves?: string[] };

/**
 * Engine lines for the first legal moves, the first one being the best. A
 * precise request answers with `precise` instead, and a request restricted to
 * some moves answers for those moves only, as a real engine does.
 */
export function fakeEngine(
    cps: number[] = [30, 20, 10, 0, -10],
    {
        precise,
        depth = 14,
        cpsOf,
    }: { precise?: number[]; depth?: number; cpsOf?: (fen: string) => number[] | undefined } = {},
) {
    const analysed: (Request & { fen: string })[] = [];
    const analyze = async (fen: string, request: Request) => {
        analysed.push({ fen, ...request });
        const deep = request.purpose === "decision" || request.purpose === "verification";
        const values = cpsOf?.(fen) ?? (deep && precise ? precise : cps);
        const sans = request.searchMoves?.length
            ? request.searchMoves
            : legalSans(fen, request.multipv ?? cps.length);
        return sans.map(
            (san, i): BestMoves => ({
                depth: deep ? 18 : depth,
                multipv: i + 1,
                nodes: 0,
                nps: 0,
                score: { value: { type: "cp", value: values[i] ?? -50 }, wdl: null },
                sanMoves: [san],
                uciMoves: [san],
            }),
        );
    };
    return { analyze, analysed };
}

export function searchParams(overrides: Partial<SearchParams> = {}): SearchParams {
    return {
        fen: INITIAL_FEN,
        color: "white",
        maxPlies: 4,
        tolerance: { mode: "pawns", value: 0.3 },
        metric: "score",
        minimumGames: 5000,
        minGamesPerMove: 100,
        minReach: 0.02,
        shrinkage: 100,
        risk: 1,
        smoothing: 1,
        ...overrides,
    };
}
