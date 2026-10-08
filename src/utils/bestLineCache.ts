import type { BestMoves } from "@/bindings";
import type { ExplorerPosition } from "./bestLine";

// Results of the "find the best line" searches, kept for the session so that a
// new search with other settings doesn't analyse the same positions again.
export const engineCache = new Map<string, Promise<BestMoves[]>>();
export const explorerCache = new Map<string, Promise<ExplorerPosition>>();

/** Calls `fn` once per key; a failed call is forgotten so it can be retried. */
export function memoizeAsync<T>(
    cache: Map<string, Promise<T>>,
    key: string,
    fn: () => Promise<T>,
): Promise<T> {
    const cached = cache.get(key);
    if (cached) return cached;
    const promise = fn();
    cache.set(key, promise);
    promise.catch(() => {
        if (cache.get(key) === promise) cache.delete(key);
    });
    return promise;
}

/**
 * Cache key of a position for the explorer: the move counters are dropped, as
 * Lichess ignores them, so transpositions share an entry.
 */
export function positionKey(fen: string) {
    return fen.split(" ").slice(0, 4).join(" ");
}

/**
 * Cache key of a position for the engine: the halfmove clock is kept (it
 * changes an endgame evaluation through the fifty-move rule), the move number
 * is not.
 */
export function analysisKey(fen: string) {
    return fen.split(" ").slice(0, 5).join(" ");
}

export function clearBestLineCaches() {
    engineCache.clear();
    explorerCache.clear();
}
