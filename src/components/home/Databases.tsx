import {
  Center,
  Loader,
  Paper,
  Progress,
  Select,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from "@mantine/core";
import { IconDatabaseOff } from "@tabler/icons-react";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import useSWRImmutable from "swr/immutable";
import type { DatabaseInfo, PlayerGameInfo } from "@/bindings";
import { commands, events } from "@/bindings";
import { sessionsAtom } from "@/state/atoms";
import { activeDatabaseViewStore } from "@/state/store/database";
import { error as logError } from "@tauri-apps/plugin-log";
import { getDatabases, PERSONAL_DATABASES_KEY, PERSONAL_INFO_KEY, query_players } from "@/utils/db";
import { getPlayerDatabases, getSessionUsername, type PersonalDatabase } from "@/utils/session";
import { unwrap } from "@/utils/unwrap";
import { DatabaseViewStateContext } from "../databases/DatabaseViewStateContext";
import PersonalPlayerCard from "./PersonalCard";

interface PersonalInfo {
  db: PersonalDatabase;
  info: PlayerGameInfo;
}

function Databases() {
  const { t } = useTranslation();
  const sessions = useAtomValue(sessionsAtom);

  const players = Array.from(
    new Set(sessions.map((s) => s.player || s.lichess?.username || s.chessCom?.username || "")),
  );
  const [name, setName] = useState("");
  useEffect(() => {
    if (sessions.length > 0) {
      setName(sessions[0].player || getSessionUsername(sessions[0]));
    }
  }, [sessions]);

  const { data: databases } = useSWRImmutable<DatabaseInfo[]>(
    sessions.length === 0 ? null : [PERSONAL_DATABASES_KEY, sessions],
    getDatabases,
  );
  // Part of the stats key so they are reloaded whenever the player's accounts
  // or their databases change
  const playerDatabases = databases && name ? getPlayerDatabases(databases, sessions, name) : null;

  const {
    data: personalInfo,
    isLoading,
    error,
  } = useSWRImmutable<PersonalInfo[]>(
    playerDatabases ? [PERSONAL_INFO_KEY, playerDatabases] : null,
    async ([, dbs]: [string, PersonalDatabase[]]) => {
      const results = await Promise.allSettled(
        dbs.map(async (db) => {
          const players = await query_players(db.file, {
            name: db.username,
            options: {
              pageSize: 1,
              direction: "asc",
              sort: "id",
              skipCount: false,
            },
          });
          if (players.data.length === 0) {
            throw new Error("Player not found in database");
          }
          const player = players.data[0];
          const info = unwrap(await commands.getPlayersGameInfo(db.file, player.id));
          return { db, info };
        }),
      );
      results.forEach((r, i) => {
        if (r.status === "rejected") {
          logError(`Failed to load personal stats from ${dbs[i].file}: ${r.reason}`);
        }
      });
      return results
        .filter((r) => r.status === "fulfilled")
        .map((r) => (r as PromiseFulfilledResult<PersonalInfo>).value);
    },
  );

  const [progress, setProgress] = useState(0);
  useEffect(() => {
    const unlisten = events.databaseProgress.listen((e) => {
      setProgress(e.payload.progress);
    });

    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  return (
    <>
      {isLoading && databases && (
        <Paper
          h="100%"
          shadow="sm"
          p="md"
          withBorder
          style={{
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <Center h="100%">
            <Stack w="100%" maw={400} align="center" gap="md">
              <ThemeIcon size={80} radius="100%" variant="light" color="blue">
                <Loader color="blue" type="bars" />
              </ThemeIcon>
              <Title order={3}>{t("Home.Databases.ProcessingGames")}</Title>
              <Progress w="100%" value={progress} animated striped size="md" radius="xl" />
              <Text fw="bold" fz="sm" c="dimmed">
                {Math.round(progress)}%
              </Text>
            </Stack>
          </Center>
        </Paper>
      )}
      {error && <Text ta="center">{t("Home.Databases.ErrorLoading", { error })}</Text>}
      {personalInfo &&
        (personalInfo.length === 0 ? (
          <Paper
            h="100%"
            shadow="sm"
            p="md"
            withBorder
            style={{
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <Center h="100%">
              <Stack align="center" gap="md">
                <ThemeIcon size={80} radius="100%" variant="light" color="blue">
                  <IconDatabaseOff size={40} />
                </ThemeIcon>
                <Title order={3}>{t("Home.Databases.Empty.Title")}</Title>
                <Text c="dimmed" ta="center" maw={400}>
                  {t("Home.Databases.Empty.Description")}
                </Text>

                <Select
                  value={name}
                  data={players}
                  onChange={(e) => setName(e || "")}
                  clearable={false}
                  allowDeselect={false}
                  fw="bold"
                  styles={{
                    input: {
                      textAlign: "center",
                      fontSize: "1.25rem",
                    },
                  }}
                  mt="md"
                />
              </Stack>
            </Center>
          </Paper>
        ) : (
          <DatabaseViewStateContext.Provider value={activeDatabaseViewStore}>
            <PersonalPlayerCard
              name={name}
              setName={setName}
              info={{
                site_stats_data: personalInfo.flatMap((i) => i.info.site_stats_data),
              }}
            />
          </DatabaseViewStateContext.Provider>
        ))}
    </>
  );
}

export default Databases;
