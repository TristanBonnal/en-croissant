import type { TFunction } from "i18next";
import { expect, test } from "vitest";
import { reportRows } from "@/components/bestLine/report";
import type { SearchReport } from "@/state/atoms";

/** Returns the key and its interpolations, so a row can be asserted exactly. */
const t = ((key: string, vars?: Record<string, unknown>) =>
    vars === undefined
        ? key
        : `${key}(${Object.entries(vars)
              .map(([name, value]) => `${name}=${value}`)
              .join(",")})`) as unknown as TFunction;

const report: SearchReport = {
    seconds: 125.4,
    moves: 11,
    fastDepth: 14,
    preciseDepth: 18,
    cached: 12,
    cloud: 31,
    engine: { candidates: 6, evaluation: 9, decision: 2, verification: 4 },
    engineSeconds: 23.2,
    explorer: 24,
    explorerSeconds: 3.4,
    expanded: 120,
    pruned: 8,
    lowReach: 44,
    outOfBook: 3,
    coverage: 0.86,
    checked: 9,
    changed: 1,
    exhausted: false,
};

test("reportRows sums the analyses of each depth", () => {
    expect(reportRows(report, t)).toEqual([
        {
            label: "BestLine.Report.Duration",
            value: "BestLine.Report.Minutes(minutes=2,seconds=05)",
        },
        { label: "BestLine.Report.Cloud", value: "31" },
        // The candidate lists and the position evaluations run at the fast depth.
        { label: "BestLine.Report.Fast(depth=14)", value: "15" },
        // The engine decisions and the checks run at the precise depth.
        { label: "BestLine.Report.Precise(depth=18)", value: "6" },
    ]);
});

test("reportRows reads a short search in seconds", () => {
    const rows = reportRows({ ...report, seconds: 42.4 }, t);
    expect(rows[0].value).toBe("BestLine.Report.Seconds(seconds=42)");
});

test("reportRows rounds a duration up to the next minute", () => {
    const rows = reportRows({ ...report, seconds: 119.6 }, t);
    expect(rows[0].value).toBe("BestLine.Report.Minutes(minutes=2,seconds=00)");
});

test("reportRows shows a search that never reached the engine", () => {
    const rows = reportRows(
        {
            ...report,
            cloud: 0,
            engine: { candidates: 0, evaluation: 0, decision: 0, verification: 0 },
        },
        t,
    );
    expect(rows.map((row) => row.value)).toEqual([
        "BestLine.Report.Minutes(minutes=2,seconds=05)",
        "0",
        "0",
        "0",
    ]);
});
