import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { clearLichessCloudCache, getBestMoves } from "@/utils/lichess/api";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: fetchMock }));
vi.mock("@tauri-apps/plugin-log", () => ({ error: vi.fn(), info: vi.fn() }));

const INITIAL = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";

const ask = (fen: string) =>
    getBestMoves(
        "",
        { t: "Depth", c: 18 },
        { fen, moves: [], extraOptions: [{ name: "MultiPV", value: "1" }] },
    );

const answer = (body: unknown, status = 200) => ({
    ok: status === 200,
    status,
    json: async () => {
        if (typeof body === "string") throw new SyntaxError("not json");
        return body;
    },
});

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-10T10:00:00Z"));
    clearLichessCloudCache();
    fetchMock.mockReset();
});

afterEach(() => {
    vi.useRealTimers();
});

test("the cloud evaluation is left alone for a minute after a rate limit", async () => {
    fetchMock.mockResolvedValueOnce(answer("Too many requests", 429));

    await expect(ask(INITIAL)).rejects.toThrow("rate limited");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Asking again at once would only extend the ban: nothing is sent.
    await expect(ask(AFTER_E4)).rejects.toThrow("paused");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A minute later the cloud is asked again.
    vi.setSystemTime(new Date("2026-10-10T10:01:01Z"));
    fetchMock.mockResolvedValueOnce(
        answer({ fen: AFTER_E4, knodes: 10, depth: 30, pvs: [{ cp: 30, moves: "e7e5 g1f3" }] }),
    );
    const [, lines] = (await ask(AFTER_E4)) ?? [0, []];
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(lines[0].sanMoves).toEqual(["e5", "Nf3"]);
});

test("a position the cloud does not know is not a rate limit", async () => {
    fetchMock.mockResolvedValue(answer({ error: "Not found" }, 200));

    expect(await ask(INITIAL)).toEqual([100, []]);
    expect(await ask(AFTER_E4)).toEqual([100, []]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
});
