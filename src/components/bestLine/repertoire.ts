import { readDir } from "@tauri-apps/plugin-fs";
import { INITIAL_FEN } from "chessops/fen";
import { parseSan } from "chessops/san";
import i18n from "i18next";
import { getDefaultStore } from "jotai";
import { commands } from "@/bindings";
import {
    type Directory,
    type FileMetadata,
    processEntriesRecursively,
} from "@/components/files/file";
import { tabsAtom } from "@/state/atoms";
import { createDebouncedSessionStorage } from "@/state/store/debouncedStorage";
import { createTreeStore, type TreeMove, type TreeStoreState } from "@/state/store/tree";
import { getPGN, headersToPGN, parsePGN } from "@/utils/chess";
import { positionFromFen } from "@/utils/chessops";
import { createFile } from "@/utils/files";
import type { TreeState } from "@/utils/treeReducer";
import { unwrap } from "@/utils/unwrap";

function isPlayable(fen: string, moves: string[]) {
    const [pos] = positionFromFen(fen);
    if (!pos) return false;
    for (const san of moves) {
        const move = parseSan(pos, san);
        if (!move) return false;
        pos.play(move);
    }
    return true;
}

/**
 * Adds `moves` to a repertoire game: `prefix` (SAN moves from the start
 * position `rootFen`) leads to the position the moves start from. Existing
 * moves are kept, new ones are added as variations.
 * Returns null when the repertoire starts from another position or the moves
 * cannot be played.
 */
export function mergeIntoRepertoire(
    tree: TreeState,
    rootFen: string,
    prefix: string[],
    moves: TreeMove[],
): TreeState | null {
    if (tree.root.fen !== rootFen || !isPlayable(rootFen, prefix)) return null;

    const chain = prefix.reduceRight<TreeMove[]>((children, san) => [{ san, children }], moves);
    const store = createTreeStore(undefined, { ...tree, position: [] });
    store.getState().addTree(chain);

    const { root, headers, position, dirty, report } = store.getState();
    return { ...tree, root, headers, position, dirty, report };
}

function flattenFiles(entries: (FileMetadata | Directory)[]): FileMetadata[] {
    return entries.flatMap((e) => (e.type === "directory" ? flattenFiles(e.children) : [e]));
}

/** Repertoire files of the documents directory. */
export async function listRepertoires(dir: string): Promise<FileMetadata[]> {
    const entries = await processEntriesRecursively(dir, await readDir(dir));
    return flattenFiles(entries).filter((f) => f.metadata.type === "repertoire");
}

/** Color of a repertoire (the orientation of its game). */
export async function repertoireColor(file: FileMetadata): Promise<"white" | "black"> {
    const [pgn = ""] = unwrap(await commands.readGames(file.path, 0, 0));
    return (await parsePGN(pgn)).headers.orientation ?? "white";
}

export async function createRepertoire(
    dir: string,
    name: string,
    color: "white" | "black",
): Promise<FileMetadata> {
    const result = await createFile({
        filename: name,
        filetype: "repertoire",
        pgn: headersToPGN({
            id: 0,
            fen: INITIAL_FEN,
            black: "",
            white: "",
            result: "*",
            event: name,
            site: "",
            orientation: color,
        }),
        dir,
    });
    if (result.isErr) throw result.error;
    return result.value;
}

/**
 * Adds moves to the first game of a repertoire file. When the file is open in
 * a tab, the moves are added to that tab (saved from there) so its unsaved
 * changes aren't overwritten.
 */
export async function addToRepertoire(
    file: FileMetadata,
    line: { rootFen: string; prefix: string[]; moves: TreeMove[] },
): Promise<"tab" | "file"> {
    const merge = (tree: TreeState) => {
        const merged = mergeIntoRepertoire(tree, line.rootFen, line.prefix, line.moves);
        if (!merged) throw new Error(i18n.t("BestLine.Repertoire.Mismatch"));
        return merged;
    };

    const openTab = getDefaultStore()
        .get(tabsAtom)
        .find(
            (tab) =>
                (tab.gameOrigin.kind === "file" || tab.gameOrigin.kind === "temp_file") &&
                tab.gameOrigin.file.path === file.path &&
                tab.gameOrigin.gameNumber === 0,
        );
    if (openTab) {
        const storage = createDebouncedSessionStorage<TreeStoreState>();
        const stored = storage.getItem(openTab.value);
        if (stored && !(stored instanceof Promise)) {
            const merged = merge(stored.state);
            storage.setItem(openTab.value, { ...stored, state: { ...stored.state, ...merged } });
            return "tab";
        }
    }

    const [pgn = ""] = unwrap(await commands.readGames(file.path, 0, 0));
    const merged = merge(await parsePGN(pgn));
    const content = getPGN(merged.root, {
        headers: merged.headers,
        comments: true,
        extraMarkups: true,
        glyphs: true,
        variations: true,
    });
    unwrap(await commands.writeGame(file.path, 0, `${content}\n\n`));
    return "file";
}
