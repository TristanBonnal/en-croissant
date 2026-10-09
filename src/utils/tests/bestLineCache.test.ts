import { expect, test } from "vitest";
import {
    analysisKey,
    clearBestLineCaches,
    explorerCache,
    memoizeAsync,
    positionKey,
    prefetchingExplorer,
} from "../bestLineCache";

test("memoizeAsync reuses the result of a previous call with the same key", async () => {
    const cache = new Map<string, Promise<number>>();
    let calls = 0;
    const fn = async () => ++calls;
    expect(await memoizeAsync(cache, "a", fn)).toBe(1);
    expect(await memoizeAsync(cache, "a", fn)).toBe(1);
    expect(await memoizeAsync(cache, "b", fn)).toBe(2);
});

test("memoizeAsync shares a pending call", async () => {
    const cache = new Map<string, Promise<number>>();
    let calls = 0;
    const fn = async () => ++calls;
    const [a, b] = await Promise.all([memoizeAsync(cache, "a", fn), memoizeAsync(cache, "a", fn)]);
    expect([a, b]).toEqual([1, 1]);
    expect(calls).toBe(1);
});

test("memoizeAsync does not keep failures", async () => {
    const cache = new Map<string, Promise<number>>();
    let calls = 0;
    const fn = async () => {
        calls++;
        if (calls === 1) throw new Error("429");
        return calls;
    };
    await expect(memoizeAsync(cache, "a", fn)).rejects.toThrow("429");
    expect(await memoizeAsync(cache, "a", fn)).toBe(2);
});

test("clearBestLineCaches empties the caches", async () => {
    await memoizeAsync(explorerCache, "a", async () => ({
        white: 0,
        draws: 0,
        black: 0,
        moves: [],
    }));
    clearBestLineCaches();
    expect(explorerCache.size).toBe(0);
});

const INITIAL = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

test("positionKey ignores the move counters: the explorer does too", () => {
    expect(positionKey(INITIAL)).toBe(
        positionKey("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 3 7"),
    );
    // Everything the position is made of is kept, en passant square included.
    expect(positionKey("rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq c6 0 2")).not.toBe(
        positionKey("rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2"),
    );
});

test("analysisKey keeps the halfmove clock, which changes an endgame evaluation", () => {
    expect(analysisKey("8/8/8/4k3/8/8/4K3/7R w - - 40 60")).toBe(
        analysisKey("8/8/8/4k3/8/8/4K3/7R w - - 40 99"),
    );
    expect(analysisKey("8/8/8/4k3/8/8/4K3/7R w - - 40 60")).not.toBe(
        analysisKey("8/8/8/4k3/8/8/4K3/7R w - - 2 60"),
    );
});

test("prefetchingExplorer prefetches only while few requests run, and shares them", async () => {
    const cache = new Map<string, Promise<string>>();
    const pending: (() => void)[] = [];
    let calls = 0;
    const fetch = (fen: string) => {
        calls++;
        return new Promise<string>((resolve) => pending.push(() => resolve(fen)));
    };
    const { explore, prefetch } = prefetchingExplorer(cache, (fen) => fen, fetch, 2);

    expect(prefetch("a")).toBe(true);
    expect(prefetch("b")).toBe(true);
    // Two requests are running: a third waits for its turn.
    expect(prefetch("c")).toBe(false);
    // The search's own request never waits, and a prefetched one is shared.
    const c = explore("c");
    const a = explore("a");
    expect(calls).toBe(3);
    for (const resolve of pending) resolve();
    expect(await Promise.all([a, c])).toEqual(["a", "c"]);
    // A position already fetched counts as prefetched.
    expect(prefetch("b")).toBe(true);
    expect(prefetch("d")).toBe(true);
    expect(calls).toBe(4);
});

test("prefetchingExplorer forgets a failed prefetch so the search can retry it", async () => {
    const cache = new Map<string, Promise<string>>();
    let calls = 0;
    const fetch = async (fen: string) => {
        if (++calls === 1) throw new Error("network");
        return fen;
    };
    const { explore, prefetch } = prefetchingExplorer(cache, (fen) => fen, fetch, 2);
    prefetch("a");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await explore("a")).toBe("a");
    expect(calls).toBe(2);
});
