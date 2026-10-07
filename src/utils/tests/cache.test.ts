import { beforeEach, expect, test, vi } from "vitest";
import type { EngineOptions, GoMode } from "@/bindings";
import { clearAppCaches } from "@/utils/cache";
import * as chessdb from "@/utils/chessdb/api";
import * as lichess from "@/utils/lichess/api";

const { fetchMock, mutateMock, clearAppCachesCommand } = vi.hoisted(() => ({
    fetchMock: vi.fn(),
    mutateMock: vi.fn(),
    clearAppCachesCommand: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: fetchMock }));
vi.mock("@tauri-apps/plugin-log", () => ({ error: vi.fn(), info: vi.fn() }));
vi.mock("swr", async (importOriginal) => ({
    ...(await importOriginal<typeof import("swr")>()),
    mutate: mutateMock,
}));
vi.mock("@/utils/directories", () => ({
    getDatabasesDir: vi.fn(async () => "/data/db"),
}));
vi.mock("@/bindings", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/bindings")>()),
    commands: { clearAppCaches: clearAppCachesCommand },
}));

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const goMode: GoMode = { t: "Infinite" };
const engineOptions: EngineOptions = { fen: START_FEN, moves: [], extraOptions: [] };
const backendResult = { removedIndexes: 2, failedIndexes: 0, webviewCleared: true };

function jsonResponse(data: unknown) {
    return { json: async () => data };
}

beforeEach(() => {
    vi.clearAllMocks();
    clearAppCachesCommand.mockResolvedValue({ status: "ok", data: backendResult });
    fetchMock.mockImplementation(async (url: string) => {
        if (url.includes("lichess.org")) {
            return jsonResponse({
                fen: START_FEN,
                knodes: 1000,
                depth: 30,
                pvs: [{ cp: 20, moves: "e2e4 e7e5" }],
            });
        }
        if (url.includes("querypv")) {
            return jsonResponse({
                status: "ok",
                depth: 30,
                score: 20,
                pv: ["e2e4"],
                pvSAN: ["e4"],
            });
        }
        return jsonResponse({
            status: "ok",
            moves: [{ uci: "e2e4", san: "e4", score: 20, rank: 2, note: "", winrate: "50" }],
        });
    });
});

test("clears backend caches for the databases directory", async () => {
    const result = await clearAppCaches();

    expect(clearAppCachesCommand).toHaveBeenCalledWith("/data/db");
    expect(result).toEqual(backendResult);
});

test("throws when the backend fails", async () => {
    clearAppCachesCommand.mockResolvedValue({ status: "error", error: "boom" });

    await expect(clearAppCaches()).rejects.toThrow("boom");
});

test("revalidates every SWR key except the native menu", async () => {
    await clearAppCaches();

    expect(mutateMock).toHaveBeenCalledTimes(1);
    const [filter, data, options] = mutateMock.mock.calls[0];
    expect(data).toBeUndefined();
    expect(options).toEqual({ revalidate: true });
    expect(filter(["menu", {}])).toBe(false);
    expect(filter("os")).toBe(true);
    expect(filter(["personalInfo", "user"])).toBe(true);
});

test("clears the lichess cloud evaluation cache", async () => {
    await lichess.getBestMoves("tab", goMode, engineOptions);
    await lichess.getBestMoves("tab", goMode, engineOptions);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await clearAppCaches();
    await lichess.getBestMoves("tab", goMode, engineOptions);

    expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("clears the chessdb cache", async () => {
    await chessdb.getBestMoves("tab", goMode, engineOptions);
    const callsPerQuery = fetchMock.mock.calls.length;
    await chessdb.getBestMoves("tab", goMode, engineOptions);
    expect(fetchMock).toHaveBeenCalledTimes(callsPerQuery);

    await clearAppCaches();
    await chessdb.getBestMoves("tab", goMode, engineOptions);

    expect(fetchMock).toHaveBeenCalledTimes(callsPerQuery * 2);
});
