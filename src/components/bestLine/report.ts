import type { TFunction } from "i18next";
import type { SearchReport } from "@/state/atoms";

/** A search's duration, read as a human would say it. */
function duration(seconds: number, t: TFunction): string {
    const total = Math.round(seconds);
    if (total < 60) return t("BestLine.Report.Seconds", { seconds: total });
    return t("BestLine.Report.Minutes", {
        minutes: Math.floor(total / 60),
        seconds: (total % 60).toString().padStart(2, "0"),
    });
}

/**
 * What a finished search spent its time on, as rows of a small table: how long
 * it took, and how many positions each source of evaluation answered for.
 */
export function reportRows(report: SearchReport, t: TFunction): { label: string; value: string }[] {
    const { engine } = report;
    return [
        { label: t("BestLine.Report.Duration"), value: duration(report.seconds, t) },
        { label: t("BestLine.Report.Cloud"), value: `${report.cloud}` },
        {
            label: t("BestLine.Report.Fast", { depth: report.fastDepth }),
            value: `${engine.evaluation}`,
        },
        {
            label: t("BestLine.Report.Precise", { depth: report.preciseDepth }),
            value: `${engine.candidates + engine.decision}`,
        },
    ];
}
