import { expect, test } from "vitest";
import { clearBestLineCaches, explorerCache, memoizeAsync } from "../bestLineCache";

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
