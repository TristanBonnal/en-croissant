import { useNavigate } from "@tanstack/react-router";
import { useSetAtom } from "jotai";
import { useContext } from "react";
import { useTranslation } from "react-i18next";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { activeTabAtom, tabsAtom } from "@/state/atoms";
import { getPGN } from "@/utils/chess";
import { createTab } from "@/utils/tabs";

/** Opens the current tab's game in a new analysis tab, at the same position. */
export function useOpenInAnalysis(name: string) {
    const { t } = useTranslation();
    const store = useContext(TreeStateContext)!;
    const setTabs = useSetAtom(tabsAtom);
    const setActiveTab = useSetAtom(activeTabAtom);
    const navigate = useNavigate();

    return async () => {
        const { root, headers, position } = store.getState();
        const pgn = getPGN(root, {
            headers,
            comments: true,
            extraMarkups: true,
            glyphs: true,
            variations: true,
        });
        await createTab({
            tab: { name: t(name), type: "analysis" },
            setTabs,
            setActiveTab,
            pgn,
            headers,
            position,
        });
        navigate({ to: "/" });
    };
}
