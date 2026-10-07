import {
  Accordion,
  Alert,
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
  Text,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
  IconBookmarkPlus,
  IconPlayerPlay,
  IconPlayerStop,
  IconZoomCheck,
} from "@tabler/icons-react";
import { useAtom, useAtomValue } from "jotai";
import { useContext, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { EnginesSelect } from "@/components/boards/EnginesSelect";
import ExplorerAuthAlert from "@/components/common/ExplorerAuthAlert";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import LichessOptionsPanel from "@/components/panels/database/options/LichessOptionsPanel";
import FenInput from "@/components/panels/info/FenInput";
import { useExplorerToken } from "@/hooks/useExplorerToken";
import { useOpenInAnalysis } from "@/hooks/useOpenInAnalysis";
import {
  bestLineResultFamily,
  bestLineRunFamily,
  bestLineSettingsAtom,
  enginesAtom,
  lichessOptionsAtom,
} from "@/state/atoms";
import type { LocalEngine } from "@/utils/engines";
import AddToRepertoireModal from "./AddToRepertoireModal";
import BestLineTable from "./BestLineTable";
import {
  cancelBestLine,
  extendLine,
  goToResultMove,
  replayMove,
  type SearchConfig,
  startBestLine,
} from "./runner";

const EXPLORER_MOVES = 30;

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

  const openInAnalysis = useOpenInAnalysis("BestLine.Title");

  const { running, progress, positions, waitingUntil, error } = useAtomValue(bestLineRunFamily(id));
  const result = useAtomValue(bestLineResultFamily(id));
  const [repertoireOpened, repertoireModal] = useDisclosure(false);

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

  function update<K extends keyof typeof settings>(key: K, value: (typeof settings)[K]) {
    setSettings((prev) => ({ ...prev, [key]: value }));
  }

  const canRun = !!engine && !!explorerToken && !running;

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
          </SimpleGrid>

          {localEngines.length === 0 ? (
            <Alert color="yellow">{t("Board.Analysis.EngineRequired")}</Alert>
          ) : (
            <Input.Wrapper label={t("Common.Engine")}>
              <EnginesSelect engine={engine} setEngine={(e) => update("engine", e?.id ?? "")} />
            </Input.Wrapper>
          )}

          <SimpleGrid cols={2}>
            <NumberInput
              label={t("GoMode.Depth")}
              min={1}
              allowDecimal={false}
              allowNegative={false}
              value={settings.depth}
              onChange={(v) => update("depth", Number(v) || 1)}
            />
            <NumberInput
              label={t("BestLine.FullMoves")}
              min={1}
              allowDecimal={false}
              allowNegative={false}
              value={settings.fullMoves}
              onChange={(v) => update("fullMoves", Number(v) || 1)}
            />
            {settings.mode === "tree" && (
              <>
                <NumberInput
                  label={t("BestLine.BranchMinShare")}
                  description={t("BestLine.BranchMinShare.Desc")}
                  min={0}
                  max={100}
                  suffix="%"
                  allowNegative={false}
                  value={Math.round(settings.branchMinShare * 1000) / 10}
                  onChange={(v) => update("branchMinShare", (Number(v) || 0) / 100)}
                />
                <NumberInput
                  label={t("BestLine.BranchDepth")}
                  description={t("BestLine.BranchDepth.Desc")}
                  min={1}
                  allowDecimal={false}
                  allowNegative={false}
                  value={settings.branchDepth}
                  onChange={(v) => update("branchDepth", Number(v) || 1)}
                />
                <NumberInput
                  label={t("BestLine.BranchMaxReplies")}
                  description={t("BestLine.BranchMaxReplies.Desc")}
                  min={1}
                  allowDecimal={false}
                  allowNegative={false}
                  value={settings.branchMaxReplies}
                  onChange={(v) => update("branchMaxReplies", Number(v) || 1)}
                />
                <Checkbox
                  mt="md"
                  label={t("BestLine.TrapBranching")}
                  description={t("BestLine.TrapBranching.Desc")}
                  checked={settings.trapBranching}
                  onChange={(e) => update("trapBranching", e.currentTarget.checked)}
                />
                <NumberInput
                  label={t("BestLine.TrapMinShare")}
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
              label={t("BestLine.Ranking")}
              description={t(
                settings.ranking === "wilson"
                  ? "BestLine.Ranking.Wilson.Desc"
                  : "BestLine.Ranking.Raw.Desc",
              )}
              allowDeselect={false}
              value={settings.ranking}
              onChange={(v) => update("ranking", v as "wilson" | "raw")}
              data={[
                { label: t("BestLine.Ranking.Wilson"), value: "wilson" },
                { label: t("BestLine.Ranking.Raw"), value: "raw" },
              ]}
            />
            <NumberInput
              label={t("BestLine.MinGamesPerMove")}
              description={t("BestLine.MinGamesPerMove.Desc")}
              min={0}
              allowDecimal={false}
              allowNegative={false}
              thousandSeparator=" "
              value={settings.minGamesPerMove}
              onChange={(v) => update("minGamesPerMove", Number(v) || 0)}
            />
            <NumberInput
              label={t("BestLine.MinimumGames")}
              description={t("BestLine.MinimumGames.Desc")}
              min={0}
              allowDecimal={false}
              allowNegative={false}
              thousandSeparator=" "
              value={settings.minimumGames}
              onChange={(v) => update("minimumGames", Number(v) || 0)}
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
                disabled={!canRun}
                onClick={() => {
                  const c = config();
                  if (c) startBestLine(id, c);
                }}
              >
                {t("BestLine.Run")}
              </Button>
            )}
            {result && result.nodes.length > 0 && !running && (
              <>
                <Button
                  variant="default"
                  leftSection={<IconBookmarkPlus size="1rem" />}
                  onClick={repertoireModal.open}
                >
                  {t("BestLine.Repertoire.Add")}
                </Button>
                <Button
                  variant="default"
                  leftSection={<IconZoomCheck size="1rem" />}
                  onClick={openInAnalysis}
                >
                  {t("BestLine.OpenInAnalysis")}
                </Button>
              </>
            )}
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

          {result && result.nodes.length === 0 && (
            <Text size="sm" c="dimmed">
              {t("BestLine.NoMoves")}
            </Text>
          )}
          {result && result.nodes.length > 0 && (
            <BestLineTable
              nodes={result.nodes}
              color={result.color}
              disabled={!canRun}
              onSelect={(path) => goToResultMove(id, path)}
              onReplay={(path, san) => {
                const c = config();
                if (c) replayMove(id, c, path, san);
              }}
              onExtend={(path, fullMoves) => {
                const c = config();
                if (c) extendLine(id, c, path, fullMoves);
              }}
            />
          )}
          {result && (
            <AddToRepertoireModal
              opened={repertoireOpened}
              onClose={repertoireModal.close}
              result={result}
            />
          )}
        </Stack>
      </ScrollArea>
    </Paper>
  );
}

export default BestLinePanel;
