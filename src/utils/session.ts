import type { DatabaseInfo } from "@/bindings";
import type { ChessComStats } from "@/utils/chess.com/api";
import type { SuccessDatabaseInfo } from "@/utils/db";
import type { LichessAccount } from "@/utils/lichess/api";

export type LichessSession = {
    accessToken?: string;
    username: string;
    account: LichessAccount;
};

export type ChessComSession = {
    username: string;
    stats: ChessComStats;
};

export type Session = {
    lichess?: LichessSession;
    chessCom?: ChessComSession;
    player?: string;
    updatedAt: number;
};

export type PersonalDatabase = SuccessDatabaseInfo & { username: string };

export function getSessionUsername(session: Session): string {
    const username = session.lichess?.account.username || session.chessCom?.username;
    if (username === undefined) {
        throw new Error("Session does not have a username");
    }
    return username;
}

// Must match the title given by AccountCard to the account database, which uses
// lichess' canonical username casing
function getSessionDatabaseTitle(session: Session): string {
    return session.chessCom
        ? `${session.chessCom.username} Chess.com`
        : `${session.lichess?.account.username} Lichess`;
}

function isPlayerSession(session: Session, player: string): boolean {
    return (
        session.player === player ||
        session.lichess?.username === player ||
        session.chessCom?.username === player
    );
}

/** Account databases of the given player, with the username to look up in each. */
export function getPlayerDatabases(
    databases: DatabaseInfo[],
    sessions: Session[],
    player: string,
): PersonalDatabase[] {
    const playerSessions = sessions.filter((session) => isPlayerSession(session, player));
    return databases.flatMap((db) => {
        if (db.type !== "success") return [];
        const session = playerSessions.find((s) => getSessionDatabaseTitle(s) === db.title);
        return session ? [{ ...db, username: getSessionUsername(session) }] : [];
    });
}
