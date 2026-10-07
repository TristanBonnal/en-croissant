import { mutate } from "swr";
import { type ClearCachesResult, commands } from "@/bindings";
import { clearChessdbCache } from "@/utils/chessdb/api";
import { getDatabasesDir } from "@/utils/directories";
import { clearLichessCloudCache } from "@/utils/lichess/api";
import { unwrap } from "@/utils/unwrap";

// The native menu is stored in SWR (see __root.tsx) but isn't a data cache:
// revalidating it would rebuild the menu for nothing.
const MENU_KEY = "menu";

export async function clearAppCaches(): Promise<ClearCachesResult> {
    const result = unwrap(await commands.clearAppCaches(await getDatabasesDir()));
    clearLichessCloudCache();
    clearChessdbCache();
    await mutate((key) => !(Array.isArray(key) && key[0] === MENU_KEY), undefined, {
        revalidate: true,
    });
    return result;
}
