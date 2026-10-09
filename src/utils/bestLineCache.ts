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
 * Explorer requests of a search, memoized in `cache` under `keyOf(fen)`.
 * `explore` always sends its request (the search waits on it); `prefetch`
 * starts one ahead of need only while fewer than `concurrency` requests are
 * running, a request waiting out a rate limit included, and otherwise declines
 * so that it never queues behind the search or piles up on the rate limit.
 */
export function prefetchingExplorer<T>(
    cache: Map<string, Promise<T>>,
    keyOf: (fen: string) => string,
    fetch: (fen: string) => Promise<T>,
    concurrency: number,
) {
    let running = 0;
    const explore = (fen: string) =>
        memoizeAsync(cache, keyOf(fen), () => {
            running++;
            return fetch(fen).finally(() => running--);
        });
    const prefetch = (fen: string) => {
        if (cache.has(keyOf(fen))) return true;
        if (running >= concurrency) return false;
        // A failure is forgotten by the cache and met again by `explore`.
        explore(fen).catch(() => {});
        return true;
    };
    return { explore, prefetch };
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
