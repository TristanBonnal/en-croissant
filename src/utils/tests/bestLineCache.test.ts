import { expect, test } from "vitest";
import {
    analysisKey,
    clearBestLineCaches,
    explorerCache,
    memoizeAsync,
    positionKey,
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
