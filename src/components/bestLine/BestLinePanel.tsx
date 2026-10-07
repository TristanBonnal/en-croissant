import {
  Accordion,
  Alert,
  Badge,
  Button,
  Group,
  Input,
  NumberInput,
  Paper,
  Progress,
  ScrollArea,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Table,
  Text,
} from "@mantine/core";
import { IconPlayerPlay, IconPlayerStop, IconZoomCheck } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useContext, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { match } from "ts-pattern";
import { useStore } from "zustand";
import { EnginesSelect } from "@/components/boards/EnginesSelect";
import ExplorerAuthAlert from "@/components/common/ExplorerAuthAlert";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import LichessOptionsPanel from "@/components/panels/database/options/LichessOptionsPanel";
import FenInput from "@/components/panels/info/FenInput";
import { useExplorerToken } from "@/hooks/useExplorerToken";
import {
  activeTabAtom,
  bestLineResultFamily,
  bestLineRunFamily,
  bestLineSettingsAtom,
  enginesAtom,
  lichessOptionsAtom,
  tabsAtom,
} from "@/state/atoms";
import { type BestLineStep, formatPercent, type MoveReason } from "@/utils/bestLine";
import { getPGN } from "@/utils/chess";
import type { LocalEngine } from "@/utils/engines";
import { formatNumber } from "@/utils/format";
import { formatScore } from "@/utils/score";
import { createTab } from "@/utils/tabs";
import { cancelBestLine, startBestLine } from "./runner";

const EXPLORER_MOVES = 30;

function moveLabels(fen: string, steps: BestLineStep[]) {
  let fullMove = Number(fen.split(" ")[5]) || 1;
  return steps.map((step) => {
    const label = step.color === "white" ? `${fullMove}.` : `${fullMove}...`;
    if (step.color === "black") fullMove++;
    return label;
  });
}

function ReasonBadge({ reason }: { reason: MoveReason }) {
  const { t } = useTranslation();
  return match(reason)
    .with("stats", () => (
      <Badge size="sm" color="green" variant="light">
        {t("BestLine.Reason.Stats")}
      </Badge>
    ))
    .with("popular", () => (
      <Badge size="sm" color="gray" variant="light">
        {t("BestLine.Reason.Popular")}
      </Badge>
    ))
    .with("engine", () => (
      <Badge size="sm" color="blue" variant="light">
        {t("BestLine.Reason.Engine")}
      </Badge>
    ))
    .exhaustive();
}

function BestLinePanel({ id }: { id: string }) {
  const { t } = useTranslation();
  const store = useContext(TreeStateContext)!;
  const currentFen = useStore(store, (s) => s.currentNode().fen);

  const [settings, setSettings] = useAtom(bestLineSettingsAtom);

  // Flipping the board studies the side now at the bottom; the side can still be picked by hand.
  const orientation = useStore(store, (s) => s.headers.orientation ?? "white");
  const previousOrientation = useRef(orientation);
  useEffect(() => {
    if (orientation === previousOrientation.current) return;
    previousOrientation.current = orientation;
    setSettings((prev) => (prev.color === orientation ? prev : { ...prev, color: orientation }));
  }, [orientation, setSettings]);
  const lichessOptions = useAtomValue(lichessOptionsAtom);
  const engines = useAtomValue(enginesAtom);
  const localEngines = (engines ?? []).filter((e): e is LocalEngine => e.type === "local");
  const engine = localEngines.find((e) => e.id === settings.engine) ?? null;
  const explorerToken = useExplorerToken();

  const setTabs = useSetAtom(tabsAtom);
  const setActiveTab = useSetAtom(activeTabAtom);
  const navigate = useNavigate();

  const { running, progress, error } = useAtomValue(bestLineRunFamily(id));
  const result = useAtomValue(bestLineResultFamily(id));

  function run() {
    if (!engine) return;
    startBestLine({
      tab: id,
      params: {
        fen: currentFen,
        color: settings.color,
        fullMoves: settings.fullMoves,
        tolerance: settings.engineTolerance,
        minimumGames: settings.minimumGames,
        minGamesPerMove: settings.minGamesPerMove,
      },
      engine: engine.path,
      engineOptions: (engine.settings ?? []).map((s) => ({
        ...s,
        value: s.value?.toString() ?? "",
      })),
      depth: settings.depth,
      explorerOptions: {
        ...lichessOptions,
        player: undefined,
        topGames: 0,
        recentGames: 0,
        moves: EXPLORER_MOVES,
      },
      token: explorerToken,
    });
  }

  async function openInAnalysis() {
    const { root, headers, position } = store.getState();
    const pgn = getPGN(root, {
      headers,
      comments: true,
      extraMarkups: true,
      glyphs: true,
      variations: true,
    });
    await createTab({
      tab: { name: t("BestLine.Title"), type: "analysis" },
      setTabs,
      setActiveTab,
      pgn,
      headers,
      position,
    });
    navigate({ to: "/" });
  }

  const labels = result ? moveLabels(result.fen, result.steps) : [];

  return (
    <Paper withBorder h="100%" p="md">
      <ScrollArea h="100%" offsetScrollbars>
        <Stack gap="sm">
          <Text fw="bold" size="lg">
            {t("BestLine.Title")}
          </Text>
          <Text size="sm" c="dimmed">
            {t("BestLine.Desc")}
          </Text>

          <Input.Wrapper label={t("BestLine.Color")}>
            <SegmentedControl
              fullWidth
              value={settings.color}
              onChange={(v) => setSettings((prev) => ({ ...prev, color: v as "white" | "black" }))}
              data={[
                { label: t("Fen.White"), value: "white" },
                { label: t("Fen.Black"), value: "black" },
              ]}
            />
          </Input.Wrapper>

          {localEngines.length === 0 ? (
            <Alert color="yellow">{t("Board.Analysis.EngineRequired")}</Alert>
          ) : (
            <Input.Wrapper label={t("Common.Engine")}>
              <EnginesSelect
                engine={engine}
                setEngine={(e) => setSettings((prev) => ({ ...prev, engine: e?.id ?? "" }))}
              />
            </Input.Wrapper>
          )}

          <SimpleGrid cols={2}>
            <NumberInput
              label={t("GoMode.Depth")}
              min={1}
              allowDecimal={false}
              allowNegative={false}
              value={settings.depth}
              onChange={(v) => setSettings((prev) => ({ ...prev, depth: Number(v) || 1 }))}
            />
            <NumberInput
              label={t("BestLine.FullMoves")}
              min={1}
              allowDecimal={false}
              allowNegative={false}
              value={settings.fullMoves}
              onChange={(v) => setSettings((prev) => ({ ...prev, fullMoves: Number(v) || 1 }))}
            />
            <NumberInput
              label={t("BestLine.Tolerance")}
              description={t("BestLine.Tolerance.Desc")}
              min={0}
              step={0.05}
              decimalScale={2}
              allowNegative={false}
              value={settings.engineTolerance}
              onChange={(v) =>
                setSettings((prev) => ({ ...prev, engineTolerance: Number(v) || 0 }))
              }
            />
            <NumberInput
              label={t("BestLine.MinimumGames")}
              description={t("BestLine.MinimumGames.Desc")}
              min={0}
              allowDecimal={false}
              allowNegative={false}
              thousandSeparator=" "
              value={settings.minimumGames}
              onChange={(v) => setSettings((prev) => ({ ...prev, minimumGames: Number(v) || 0 }))}
            />
            <NumberInput
              label={t("BestLine.MinGamesPerMove")}
              description={t("BestLine.MinGamesPerMove.Desc")}
              min={0}
              allowDecimal={false}
              allowNegative={false}
              thousandSeparator=" "
              value={settings.minGamesPerMove}
              onChange={(v) =>
                setSettings((prev) => ({ ...prev, minGamesPerMove: Number(v) || 0 }))
              }
            />
          </SimpleGrid>

          <Accordion variant="contained" multiple>
            <Accordion.Item value="lichess">
              <Accordion.Control>{t("BestLine.LichessFilters")}</Accordion.Control>
              <Accordion.Panel>
                <LichessOptionsPanel hidePlayer />
              </Accordion.Panel>
            </Accordion.Item>
            <Accordion.Item value="start">
              <Accordion.Control>{t("BestLine.StartPosition")}</Accordion.Control>
              <Accordion.Panel>
                <Stack gap="xs">
                  <Text size="sm" c="dimmed">
                    {t("BestLine.StartPosition.Desc")}
                  </Text>
                  <FenInput currentFen={currentFen} />
                </Stack>
              </Accordion.Panel>
            </Accordion.Item>
          </Accordion>

          {!explorerToken && <ExplorerAuthAlert />}
          {error && <Alert color="red">{error}</Alert>}

          <Group>
            {running ? (
              <Button
                color="red"
                leftSection={<IconPlayerStop size="1rem" />}
                onClick={() => cancelBestLine(id)}
              >
                {t("Common.Cancel")}
              </Button>
            ) : (
              <Button
                leftSection={<IconPlayerPlay size="1rem" />}
                disabled={!engine || !explorerToken}
                onClick={run}
              >
                {t("BestLine.Run")}
              </Button>
            )}
            {result && result.steps.length > 0 && !running && (
              <Button
                variant="default"
                leftSection={<IconZoomCheck size="1rem" />}
                onClick={openInAnalysis}
              >
                {t("BestLine.OpenInAnalysis")}
              </Button>
            )}
          </Group>
          {running && <Progress value={progress} animated />}

          {result && result.steps.length === 0 && (
            <Text size="sm" c="dimmed">
              {t("BestLine.NoMoves")}
            </Text>
          )}
          {result && result.steps.length > 0 && (
            <Table striped>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t("BestLine.Table.Move")}</Table.Th>
                  <Table.Th>{t("BestLine.Table.Eval")}</Table.Th>
                  <Table.Th>{t("BestLine.Table.Score")}</Table.Th>
                  <Table.Th>{t("BestLine.Table.Share")}</Table.Th>
                  <Table.Th>{t("Common.Games")}</Table.Th>
                  <Table.Th>{t("BestLine.Table.Reason")}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {result.steps.map((step, i) => (
                  <Table.Tr key={i}>
                    <Table.Td>
                      <Text size="sm" fw={step.color === result.color ? "bold" : undefined}>
                        {labels[i]} {step.san}
                      </Text>
                    </Table.Td>
                    <Table.Td>{step.score ? formatScore(step.score.value) : "-"}</Table.Td>
                    <Table.Td>{step.stats ? formatPercent(step.stats.score) : "-"}</Table.Td>
                    <Table.Td>{step.stats ? formatPercent(step.stats.share) : "-"}</Table.Td>
                    <Table.Td>{step.stats ? formatNumber(step.stats.games) : "-"}</Table.Td>
                    <Table.Td>
                      <ReasonBadge reason={step.reason} />
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </Stack>
      </ScrollArea>
    </Paper>
  );
}

export default BestLinePanel;
