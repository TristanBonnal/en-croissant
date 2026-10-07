import { useLoaderData } from "@tanstack/react-router";
import { useAtom, useAtomValue } from "jotai";
import { useCallback, useContext, useEffect } from "react";
import { useStore } from "zustand";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { autoSaveAtom, currentTabAtom } from "@/state/atoms";
import { saveToFile } from "@/utils/tabs";

/** Saving of the current tab's game, with auto-save once it is tied to a file or database. */
export function useSaveFile() {
    const [currentTab, setCurrentTab] = useAtom(currentTabAtom);
    const hasPersistentOrigin = currentTab?.gameOrigin.kind !== "none";
    const autoSave = useAtomValue(autoSaveAtom);
    const { documentDir } = useLoaderData({ from: "/" });
    const store = useContext(TreeStateContext)!;
    const dirty = useStore(store, (s) => s.dirty);

    const saveFile = useCallback(async () => {
        saveToFile({
            dir: documentDir,
            setCurrentTab,
            tab: currentTab,
            store,
        });
    }, [setCurrentTab, currentTab, documentDir, store]);
    const userSaveFile = useCallback(async () => {
        saveToFile({
            dir: documentDir,
            setCurrentTab,
            tab: currentTab,
            store,
            isUserSave: true,
        });
    }, [setCurrentTab, currentTab, documentDir, store]);
    useEffect(() => {
        if (hasPersistentOrigin && autoSave && dirty) {
            saveFile();
        }
    }, [hasPersistentOrigin, saveFile, autoSave, dirty]);

    return { dirty, userSaveFile };
}
