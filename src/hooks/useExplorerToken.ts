import { useAtomValue } from "jotai";
import { sessionsAtom } from "@/state/atoms";

/** Access token of the first Lichess session, required by the Lichess explorer. */
export function useExplorerToken(): string | undefined {
    const sessions = useAtomValue(sessionsAtom);
    return sessions.find((session) => session.lichess?.accessToken)?.lichess?.accessToken;
}
