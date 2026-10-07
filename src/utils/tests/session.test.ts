import { expect, test } from "vitest";
import type { DatabaseInfo } from "@/bindings";
import type { ChessComStats } from "@/utils/chess.com/api";
import type { LichessAccount } from "@/utils/lichess/api";
import { getPlayerDatabases, type Session } from "@/utils/session";

function lichess(username: string, player?: string): Session {
    return {
        lichess: { username: username.toLowerCase(), account: { username } as LichessAccount },
        player,
        updatedAt: 0,
    };
}

function chessCom(username: string, player?: string): Session {
    return { chessCom: { username, stats: {} as ChessComStats }, player, updatedAt: 0 };
}

function database(title: string, filename: string): DatabaseInfo {
    return {
        type: "success",
        file: `/db/${filename}`,
        filename,
        title,
        description: "",
        player_count: 0,
        event_count: 0,
        game_count: 0,
        storage_size: BigInt(0),
        indexed: false,
    };
}

const lichessDb = database("Tristan Lichess", "Tristan_lichess.db3");
const chessComDb = database("Tristan Chess.com", "Tristan_chesscom.db3");
const otherDb = database("Other Chess.com", "Other_chesscom.db3");

test("returns the databases of every account of the player, with their username", () => {
    const sessions = [lichess("Tristan", "Me"), chessCom("Tristan", "Me")];

    const result = getPlayerDatabases([lichessDb, chessComDb, otherDb], sessions, "Me");

    expect(result.map((db) => [db.file, db.username])).toEqual([
        [lichessDb.file, "Tristan"],
        [chessComDb.file, "Tristan"],
    ]);
});

test("ignores the database of a removed account sharing a username with another one", () => {
    const sessions = [lichess("Tristan", "Me")];

    const result = getPlayerDatabases([lichessDb, chessComDb], sessions, "Me");

    expect(result.map((db) => db.file)).toEqual([lichessDb.file]);
});

test("only returns the databases of the selected player", () => {
    const sessions = [lichess("Tristan", "Me"), chessCom("Other", "Someone")];

    expect(getPlayerDatabases([lichessDb, otherDb], sessions, "Me")).toHaveLength(1);
    expect(getPlayerDatabases([lichessDb, otherDb], sessions, "Someone")).toEqual([
        { ...otherDb, username: "Other" },
    ]);
});

test("matches a player without alias by username", () => {
    const result = getPlayerDatabases([chessComDb], [chessCom("Tristan")], "Tristan");

    expect(result).toHaveLength(1);
});

test("matches lichess databases with the canonical username casing", () => {
    const result = getPlayerDatabases([lichessDb], [lichess("Tristan", "Me")], "Me");

    expect(result).toHaveLength(1);
});

test("ignores databases that failed to load", () => {
    const broken: DatabaseInfo = {
        type: "error",
        file: "/db/Tristan_lichess.db3",
        filename: "Tristan_lichess.db3",
        error: "corrupted",
        indexed: false,
    };

    expect(getPlayerDatabases([broken], [lichess("Tristan", "Me")], "Me")).toEqual([]);
});

test("does not mutate the given databases", () => {
    const db = database("Tristan Lichess", "Tristan_lichess.db3");

    getPlayerDatabases([db], [lichess("Tristan", "Me")], "Me");

    expect(db).not.toHaveProperty("username");
});
