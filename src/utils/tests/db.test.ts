import { beforeEach, expect, test, vi } from "vitest";
import { invalidatePersonalStats, PERSONAL_DATABASES_KEY, PERSONAL_INFO_KEY } from "@/utils/db";

const { mutateMock } = vi.hoisted(() => ({ mutateMock: vi.fn() }));

vi.mock("swr", async (importOriginal) => ({
    ...(await importOriginal<typeof import("swr")>()),
    mutate: mutateMock,
}));

beforeEach(() => {
    vi.clearAllMocks();
});

test("invalidatePersonalStats only targets the personal stats keys", async () => {
    await invalidatePersonalStats();

    expect(mutateMock).toHaveBeenCalledTimes(1);
    const [filter, data] = mutateMock.mock.calls[0];
    expect(data).toBeUndefined();
    expect(filter([PERSONAL_DATABASES_KEY, []])).toBe(true);
    expect(filter([PERSONAL_INFO_KEY, "player", []])).toBe(true);
    expect(filter(["players", "file.db3"])).toBe(false);
    expect(filter(PERSONAL_INFO_KEY)).toBe(false);
});
