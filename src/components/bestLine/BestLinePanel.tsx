import {
  Accordion,
  Alert,
  Anchor,
  Badge,
  Button,
  Checkbox,
  Group,
  Input,
  Loader,
  NumberInput,
  Paper,
  Progress,
  ScrollArea,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  Text,
  Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
  IconAdjustments,
  IconBookmarkPlus,
  IconInfoCircle,
  IconListTree,
  IconPlayerPlay,
  IconPlayerStop,
  IconRefresh,
  IconZoomCheck,
} from "@tabler/icons-react";
import type { TFunction } from "i18next";
import { useAtom, useAtomValue } from "jotai";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { EnginesSelect } from "@/components/boards/EnginesSelect";
import ConfirmModal from "@/components/common/ConfirmModal";
import ExplorerAuthAlert from "@/components/common/ExplorerAuthAlert";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import LichessOptionsPanel from "@/components/panels/database/options/LichessOptionsPanel";
import FenInput from "@/components/panels/info/FenInput";
import { useExplorerToken } from "@/hooks/useExplorerToken";
import { useOpenInAnalysis } from "@/hooks/useOpenInAnalysis";
import {
  bestLinePanelTabFamily,
  bestLineResultFamily,
  bestLineRunFamily,
  bestLineSettingsAtom,
  enginesAtom,
  lichessOptionsAtom,
} from "@/state/atoms";
import {
  type BestLineNode,
  type BestLineSettings,
  movesTo,
  resultPathOf,
  sansBetween,
  TRAP_MIN_GAIN,
  TRAP_MIN_GAMES,
} from "@/utils/bestLine";
import type { LocalEngine } from "@/utils/engines";
import { formatNumber } from "@/utils/format";
import { getNodeAtPath } from "@/utils/treeReducer";
import AddToRepertoireModal from "./AddToRepertoireModal";
import BestLineTable from "./BestLineTable";
import ImportPgn from "./ImportPgn";
import { reportRows } from "./report";
import {
  cancelBestLine,
  extendLine,
  goToResultMove,
  replayMove,
  resetBestLine,
  type SearchConfig,
  startBestLine,
} from "./runner";

const EXPLORER_MOVES = 30;

/** Input label with an explanation shown on hover. */
function HelpLabel({ label, help }: { label: string; help: string }) {
  return (
    <Group gap={4} wrap="nowrap" component="span" style={{ display: "inline-flex" }}>
      {label}
      <Tooltip label={help} multiline w={300} withArrow>
        <IconInfoCircle size="0.9rem" style={{ opacity: 0.6, cursor: "help" }} />
      </Tooltip>
    </Group>
  );
}

function countMoves(nodes: BestLineNode[]): number {
  return nodes.reduce((acc, n) => acc + 1 + countMoves(n.children), 0);
}

type Update = <K extends keyof BestLineSettings>(key: K, value: BestLineSettings[K]) => void;

/** One line summing up the advanced settings, shown while they are folded. */
function settingsSummary(settings: BestLineSettings, t: TFunction) {
  const parts = [
    t("BestLine.Summary.Depth", { fast: settings.fastDepth, precise: settings.depth }),
    t("BestLine.Summary.Tolerance", {
      tolerance:
        settings.toleranceMode === "pawns"
          ? settings.engineTolerance.toFixed(2)
          : `${settings.winChanceTolerance}%`,
    }),
    t(settings.metric === "wins" ? "BestLine.Metric.Wins" : "BestLine.Metric.Score"),
    t("BestLine.Summary.PerMove", { games: formatNumber(settings.minGamesPerMove) }),
    t("BestLine.Summary.Position", { games: formatNumber(settings.minimumGames) }),
  ];
  parts.push(
    t("BestLine.Summary.Reach", { share: Math.round(settings.reachThreshold * 1000) / 10 }),
  );
  return parts.join(" · ");
}

function AdvancedSettings({ settings, update }: { settings: BestLineSettings; update: Update }) {
  const { t } = useTranslation();
  return (
    <Stack gap="sm">
      <SimpleGrid cols={2}>
        <NumberInput
          label={t("BestLine.FastDepth")}
          description={t("BestLine.FastDepth.Desc")}
          min={1}
          allowDecimal={false}
          allowNegative={false}
          value={settings.fastDepth}
          onChange={(v) => update("fastDepth", Number(v) || 1)}
        />
        <NumberInput
          label={t("BestLine.PreciseDepth")}
          description={t("BestLine.PreciseDepth.Desc")}
          min={1}
          allowDecimal={false}
          allowNegative={false}
          value={settings.depth}
          onChange={(v) => update("depth", Number(v) || 1)}
        />
        <Select
          label={t("BestLine.ToleranceMode")}
          allowDeselect={false}
          value={settings.toleranceMode}
          onChange={(v) => update("toleranceMode", v as "pawns" | "winChance")}
          data={[
            { label: t("BestLine.ToleranceMode.Pawns"), value: "pawns" },
            { label: t("BestLine.ToleranceMode.WinChance"), value: "winChance" },
          ]}
        />
        {settings.toleranceMode === "pawns" ? (
          <NumberInput
            label={t("BestLine.Tolerance")}
            description={t("BestLine.Tolerance.Desc")}
            min={0}
            step={0.05}
            decimalScale={2}
            allowNegative={false}
            value={settings.engineTolerance}
            onChange={(v) => update("engineTolerance", Number(v) || 0)}
          />
        ) : (
          <NumberInput
            label={t("BestLine.Tolerance")}
            description={t("BestLine.WinChanceTolerance.Desc")}
            min={0}
            max={100}
            step={0.5}
            decimalScale={1}
            suffix="%"
            allowNegative={false}
            value={settings.winChanceTolerance}
            onChange={(v) => update("winChanceTolerance", Number(v) || 0)}
          />
        )}
        <Select
          label={t("BestLine.Metric")}
          description={t("BestLine.Metric.Desc")}
          allowDeselect={false}
          value={settings.metric}
          onChange={(v) => update("metric", v as "wins" | "score")}
          data={[
            { label: t("BestLine.Metric.Wins"), value: "wins" },
            { label: t("BestLine.Metric.Score"), value: "score" },
          ]}
        />
        <NumberInput
          label={
            <HelpLabel
              label={t("BestLine.MinGamesPerMove")}
              help={t("BestLine.MinGamesPerMove.Help")}
            />
          }
          description={t("BestLine.MinGamesPerMove.Desc")}
          min={0}
          allowDecimal={false}
          allowNegative={false}
          thousandSeparator=" "
          value={settings.minGamesPerMove}
          onChange={(v) => update("minGamesPerMove", Number(v) || 0)}
        />
        <NumberInput
          label={
            <HelpLabel label={t("BestLine.MinimumGames")} help={t("BestLine.MinimumGames.Help")} />
          }
          description={t("BestLine.MinimumGames.Desc")}
          min={0}
          allowDecimal={false}
          allowNegative={false}
          thousandSeparator=" "
          value={settings.minimumGames}
          onChange={(v) => update("minimumGames", Number(v) || 0)}
        />
        <NumberInput
          label={<HelpLabel label={t("BestLine.Reach")} help={t("BestLine.Reach.Help")} />}
          description={t("BestLine.Reach.Desc")}
          min={0.1}
          max={50}
          step={0.5}
          decimalScale={1}
          suffix="%"
          allowNegative={false}
          value={Math.round(settings.reachThreshold * 1000) / 10}
          onChange={(v) => update("reachThreshold", (Number(v) || 2) / 100)}
        />
        {settings.mode === "tree" && (
          <>
            <NumberInput
              label={
                <HelpLabel
                  label={t("BestLine.TrapMinShare")}
                  help={t("BestLine.TrapMinShare.Help", {
                    games: TRAP_MIN_GAMES,
                    gain: TRAP_MIN_GAIN * 100,
                  })}
                />
              }
              description={t("BestLine.TrapMinShare.Desc")}
              disabled={!settings.trapBranching}
              min={0}
              max={100}
              suffix="%"
              allowNegative={false}
              value={Math.round(settings.trapMinShare * 1000) / 10}
              onChange={(v) => update("trapMinShare", (Number(v) || 0) / 100)}
            />
          </>
        )}
      </SimpleGrid>
      <Stack gap="xs">
        {settings.mode === "tree" && (
          <Checkbox
            label={t("BestLine.TrapBranching")}
            description={t("BestLine.TrapBranching.Desc")}
            checked={settings.trapBranching}
            onChange={(e) => update("trapBranching", e.currentTarget.checked)}
          />
        )}
        <Checkbox
          label={t("BestLine.VerifyFastChoice")}
          description={t("BestLine.VerifyFastChoice.Desc")}
          checked={settings.verifyFastChoice}
          onChange={(e) => update("verifyFastChoice", e.currentTarget.checked)}
        />
        <Checkbox
          label={t("BestLine.UseCloudEval")}
          description={t("BestLine.UseCloudEval.Desc")}
          checked={settings.useCloudEval}
          onChange={(e) => update("useCloudEval", e.currentTarget.checked)}
        />
      </Stack>
    </Stack>
  );
}

function BestLinePanel({ id }: { id: string }) {
  const { t } = useTranslation();
  const store = useContext(TreeStateContext)!;
  const currentFen = useStore(store, (s) => s.currentNode().fen);
  const root = useStore(store, (s) => s.root);
  const position = useStore(store, (s) => s.position);

  const [settings, setSettings] = useAtom(bestLineSettingsAtom);

  // Flipping the board studies the side now at the bottom; the side can still be picked by hand.
  const orientation = useStore(store, (s) => s.headers.orientation ?? "white");
  const previousOrientation = useRef(orientation);
  const studySide = useCallback(
    (side: "white" | "black") =>
      setSettings((prev) => (prev.color === side ? prev : { ...prev, color: side })),
    [setSettings],
  );
  useEffect(() => {
    if (orientation === previousOrientation.current) return;
    previousOrientation.current = orientation;
    studySide(orientation);
  }, [orientation, studySide]);

  // Loading a position studies the side at the bottom of the board again, even
  // if the side was picked by hand before.
  const loadedFen = useRef(root.fen);
  useEffect(() => {
    if (root.fen === loadedFen.current) return;
    loadedFen.current = root.fen;
    studySide(orientation);
  }, [root.fen, orientation, studySide]);

  const lichessOptions = useAtomValue(lichessOptionsAtom);
  const engines = useAtomValue(enginesAtom);
  const localEngines = (engines ?? []).filter((e): e is LocalEngine => e.type === "local");
  const engine = localEngines.find((e) => e.id === settings.engine) ?? null;
  const explorerToken = useExplorerToken();

  const openInAnalysis = useOpenInAnalysis("BestLine.Title");

  const { running, progress, positions, waitingUntil, error, report } = useAtomValue(
    bestLineRunFamily(id),
  );
  const result = useAtomValue(bestLineResultFamily(id));
  const [panelTab, setPanelTab] = useAtom(bestLinePanelTabFamily(id));
  const [fromBoard, setFromBoard] = useState(false);
  const [repertoireOpened, repertoireModal] = useDisclosure(false);
  const [resetOpened, resetModal] = useDisclosure(false);

  const config = (): SearchConfig | null =>
    engine && {
      settings,
      engine,
      explorerOptions: {
        ...lichessOptions,
        player: undefined,
        topGames: 0,
        recentGames: 0,
        moves: EXPLORER_MOVES,
      },
      token: explorerToken,
    };

  const update: Update = (key, value) => setSettings((prev) => ({ ...prev, [key]: value }));

  // Why the search can't be started, if it can't.
  const blocker = !engine
    ? t("BestLine.Blocked.NoEngine")
    : !explorerToken
      ? t("BestLine.Blocked.NoAccount")
      : null;
  const canRun = !blocker && !running;

  function run(action: (c: SearchConfig) => void) {
    const c = config();
    if (!c || !canRun) return;
    setPanelTab("result");
    action(c);
  }

  // While the board shows a move of the last result (it goes to its end), a new
  // search starts again from the same position, unless asked otherwise.
  const onLastResult =
    !!result &&
    result.inserted &&
    getNodeAtPath(root, result.startPath).fen === result.fen &&
    resultPathOf(result.nodes, sansBetween(root, result.startPath, position) ?? []) !== null;
  const startPath = onLastResult && !fromBoard ? result.startPath : position;
  const startMoves = movesTo(root, startPath, 8);
  const turn =
    getNodeAtPath(root, startPath).fen.split(" ")[1] === "w"
      ? t("Fen.WhiteToMove")
      : t("Fen.BlackToMove");
  const start = startMoves
    ? t("BestLine.Start.After", { moves: startMoves, turn })
    : t("BestLine.Start.Initial", { turn });

  return (
    <Paper withBorder h="100%" p="md" style={{ display: "flex", flexDirection: "column" }}>
      <Stack gap="xs" mb="xs">
        <Text fw="bold" size="lg">
          {t("BestLine.Title")}
        </Text>

        {localEngines.length === 0 && (
          <Alert color="yellow">{t("Board.Analysis.EngineRequired")}</Alert>
        )}
        {!explorerToken && <ExplorerAuthAlert />}

        <Stack gap={0}>
          <Text size="sm">
            <Text span c="dimmed">
              {t("BestLine.Start")}
            </Text>{" "}
            {start}
            {onLastResult && !fromBoard && (
              <Text span size="xs" c="dimmed">
                {" "}
                {t("BestLine.Start.SameAsLast")}
              </Text>
            )}
          </Text>
          {onLastResult && (
            <Anchor
              component="button"
              type="button"
              size="xs"
              ta="left"
              onClick={() => setFromBoard(!fromBoard)}
            >
              {fromBoard ? t("BestLine.Start.UseLast") : t("BestLine.Start.UseBoard")}
            </Anchor>
          )}
        </Stack>

        <Group gap="xs">
          {running ? (
            <Button
              color="red"
              leftSection={<IconPlayerStop size="1rem" />}
              onClick={() => cancelBestLine(id)}
            >
              {t("Common.Cancel")}
            </Button>
          ) : (
            <Tooltip label={blocker} disabled={!blocker} withArrow>
              <Button
                leftSection={<IconPlayerPlay size="1rem" />}
                data-disabled={blocker ? true : undefined}
                onClick={(e) => {
                  if (blocker) {
                    e.preventDefault();
                    return;
                  }
                  setFromBoard(false);
                  run((c) => startBestLine(id, c, startPath));
                }}
              >
                {t("BestLine.Run")}
              </Button>
            </Tooltip>
          )}
          <Button
            variant="default"
            leftSection={<IconRefresh size="1rem" />}
            disabled={running}
            onClick={resetModal.open}
          >
            {t("BestLine.Reset")}
          </Button>
        </Group>

        {running && (
          <Stack gap={4}>
            {progress !== null ? (
              <Progress value={progress} animated />
            ) : (
              <Group gap="xs">
                <Loader size="xs" />
                <Text size="sm" c="dimmed">
                  {t("BestLine.Positions", { positions })}
                </Text>
              </Group>
            )}
            {waitingUntil && (
              <Text size="sm" c="orange">
                {t("BestLine.RateLimited")}
              </Text>
            )}
          </Stack>
        )}
        {error && <Alert color="red">{error}</Alert>}
      </Stack>

      <Tabs
        value={panelTab}
        onChange={(v) => setPanelTab((v as "settings" | "result") ?? "settings")}
        keepMounted={false}
        flex={1}
        style={{ display: "flex", flexDirection: "column", minHeight: 0 }}
      >
        <Tabs.List grow>
          <Tabs.Tab value="settings" leftSection={<IconAdjustments size="1rem" />}>
            {t("BestLine.Tab.Settings")}
          </Tabs.Tab>
          <Tabs.Tab
            value="result"
            leftSection={<IconListTree size="1rem" />}
            rightSection={
              result && result.nodes.length > 0 ? (
                <Badge size="xs" variant="light">
                  {countMoves(result.nodes)}
                </Badge>
              ) : undefined
            }
          >
            {t("BestLine.Tab.Result")}
          </Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="settings" flex={1} style={{ minHeight: 0 }}>
          <ScrollArea h="100%" offsetScrollbars>
            <Stack gap="sm" pt="sm">
              <Text size="sm" c="dimmed">
                {t("BestLine.Desc")}
              </Text>
              <SimpleGrid cols={2}>
                <Input.Wrapper label={t("BestLine.Color")}>
                  <SegmentedControl
                    fullWidth
                    value={settings.color}
                    onChange={(v) => update("color", v as "white" | "black")}
                    data={[
                      { label: t("Fen.White"), value: "white" },
                      { label: t("Fen.Black"), value: "black" },
                    ]}
                  />
                </Input.Wrapper>
                <Input.Wrapper label={t("BestLine.Mode")}>
                  <SegmentedControl
                    fullWidth
                    value={settings.mode}
                    onChange={(v) => update("mode", v as "line" | "tree")}
                    data={[
                      { label: t("BestLine.Mode.Line"), value: "line" },
                      { label: t("BestLine.Mode.Tree"), value: "tree" },
                    ]}
                  />
                </Input.Wrapper>
                <NumberInput
                  label={t("BestLine.FullMoves")}
                  min={1}
                  allowDecimal={false}
                  allowNegative={false}
                  value={settings.fullMoves}
                  onChange={(v) => update("fullMoves", Number(v) || 1)}
                />
                {localEngines.length > 0 && (
                  <Input.Wrapper label={t("Common.Engine")}>
                    <EnginesSelect
                      engine={engine}
                      setEngine={(e) => update("engine", e?.id ?? "")}
                    />
                  </Input.Wrapper>
                )}
              </SimpleGrid>

              <Accordion variant="contained" multiple>
                <Accordion.Item value="advanced">
                  <Accordion.Control>
                    <Text size="sm">{t("BestLine.Advanced")}</Text>
                    <Text size="xs" c="dimmed">
                      {settingsSummary(settings, t)}
                    </Text>
                  </Accordion.Control>
                  <Accordion.Panel>
                    <AdvancedSettings settings={settings} update={update} />
                  </Accordion.Panel>
                </Accordion.Item>
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
                      <ImportPgn onLoad={studySide} />
                    </Stack>
                  </Accordion.Panel>
                </Accordion.Item>
              </Accordion>
            </Stack>
          </ScrollArea>
        </Tabs.Panel>

        <Tabs.Panel value="result" flex={1} style={{ minHeight: 0 }}>
          <ScrollArea h="100%" offsetScrollbars>
            <Stack gap="sm" pt="sm">
              {!result && !running && (
                <Text size="sm" c="dimmed">
                  {t("BestLine.NoResult")}
                </Text>
              )}
              {result && result.nodes.length === 0 && (
                <Text size="sm" c="dimmed">
                  {t("BestLine.NoMoves")}
                </Text>
              )}
              {result && result.nodes.length > 0 && (
                <>
                  <Group gap="xs">
                    <Button
                      size="xs"
                      variant="default"
                      leftSection={<IconBookmarkPlus size="0.9rem" />}
                      disabled={running}
                      onClick={repertoireModal.open}
                    >
                      {t("BestLine.Repertoire.Add")}
                    </Button>
                    <Button
                      size="xs"
                      variant="default"
                      leftSection={<IconZoomCheck size="0.9rem" />}
                      disabled={running}
                      onClick={openInAnalysis}
                    >
                      {t("BestLine.OpenInAnalysis")}
                    </Button>
                  </Group>
                  {report && !running && (
                    <Accordion variant="contained" chevronPosition="left">
                      <Accordion.Item value="report">
                        <Accordion.Control>
                          <Text size="xs" c="dimmed">
                            {t("BestLine.Report.Title")}
                          </Text>
                        </Accordion.Control>
                        <Accordion.Panel>
                          <Table withRowBorders={false} verticalSpacing={2} fz="xs">
                            <Table.Tbody>
                              {reportRows(report, t).map(({ label, value }) => (
                                <Table.Tr key={label}>
                                  <Table.Td c="dimmed">{label}</Table.Td>
                                  <Table.Td ta="right">{value}</Table.Td>
                                </Table.Tr>
                              ))}
                            </Table.Tbody>
                          </Table>
                        </Accordion.Panel>
                      </Accordion.Item>
                    </Accordion>
                  )}
                  <BestLineTable
                    nodes={result.nodes}
                    color={result.color}
                    metric={result.metric ?? "score"}
                    disabled={!canRun}
                    onSelect={(path) => goToResultMove(id, path)}
                    onReplay={(path, san) => run((c) => replayMove(id, c, path, san))}
                    onExtend={(path, fullMoves) => run((c) => extendLine(id, c, path, fullMoves))}
                  />
                </>
              )}
            </Stack>
          </ScrollArea>
        </Tabs.Panel>
      </Tabs>

      <ConfirmModal
        title={t("BestLine.Reset.Title")}
        description={t("BestLine.Reset.Desc")}
        confirmLabel={t("BestLine.Reset")}
        opened={resetOpened}
        onClose={resetModal.close}
        onConfirm={() => {
          if (resetBestLine(id)) setFromBoard(false);
          resetModal.close();
        }}
      />
      {result && (
        <AddToRepertoireModal
          opened={repertoireOpened}
          onClose={repertoireModal.close}
          result={result}
        />
      )}
    </Paper>
  );
}

export default BestLinePanel;
