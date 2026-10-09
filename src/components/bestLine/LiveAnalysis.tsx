import { Alert, Button, Group, Loader, NumberInput, Stack, Switch, Text } from "@mantine/core";
import { IconRefresh } from "@tabler/icons-react";
import { useAtomValue } from "jotai";
import { useTranslation } from "react-i18next";
import { bestLineResultFamily, bestLineRunFamily } from "@/state/atoms";
import BestLineTable from "./BestLineTable";
import { isTurnOf } from "@/utils/bestLine";
import { liveKeyOf } from "./runner";

/**
 * The search of the best move for the position of the board, run again at
 * every move played there while it is on. It is a search of its own, one move
 * deep, with its own result and engine: it neither uses nor disturbs the
 * search of the Result tab, which can run meanwhile.
 */
function LiveAnalysis({
  tab,
  on,
  onChange,
  blocker,
  boardFen,
  lookahead,
  onLookahead,
  studied,
  onReset,
}: {
  tab: string;
  on: boolean;
  onChange: (on: boolean) => void;
  blocker: string | null;
  boardFen: string;
  lookahead: number;
  onLookahead: (moves: number) => void;
  studied: "white" | "black";
  onReset: () => void;
}) {
  const { t } = useTranslation();
  const key = liveKeyOf(tab);
  const result = useAtomValue(bestLineResultFamily(key));
  const { running, error } = useAtomValue(bestLineRunFamily(key));
  const current = result?.fen === boardFen;

  return (
    <Stack gap="sm" pt="sm">
      <Text size="sm" c="dimmed">
        {t("BestLine.Live.Desc")}
      </Text>
      <Group gap="sm">
        <Switch
          label={t("BestLine.Live.Switch")}
          checked={on}
          disabled={!!blocker && !on}
          onChange={(e) => onChange(e.currentTarget.checked)}
        />
        {on && running && <Loader size="xs" />}
        <Button
          size="compact-sm"
          variant="default"
          leftSection={<IconRefresh size="0.9rem" />}
          disabled={!result && !running}
          onClick={onReset}
        >
          {t("BestLine.Live.Reset")}
        </Button>
      </Group>
      {on && !blocker && !isTurnOf(boardFen, studied) && (
        <Text size="sm" c="dimmed">
          {t("BestLine.Live.OpponentTurn")}
        </Text>
      )}
      <NumberInput
        label={t("BestLine.Live.Lookahead")}
        description={t("BestLine.Live.Lookahead.Desc")}
        min={1}
        max={6}
        allowDecimal={false}
        allowNegative={false}
        value={lookahead}
        onChange={(v) => onLookahead(Number(v) || 1)}
      />
      {blocker && (
        <Text size="sm" c="orange">
          {blocker}
        </Text>
      )}
      {error && <Alert color="red">{error}</Alert>}
      {!result && (
        <Text size="sm" c="dimmed">
          {on ? t("BestLine.Live.Waiting") : t("BestLine.Live.Off")}
        </Text>
      )}
      {result && result.nodes.length === 0 && !running && (
        <Text size="sm" c="dimmed">
          {t("BestLine.NoMoves")}
        </Text>
      )}
      {result && result.nodes.length > 0 && (
        <div style={{ opacity: current ? 1 : 0.5 }}>
          <BestLineTable
            nodes={result.nodes}
            color={result.color}
            metric={result.metric ?? "score"}
            disabled
            onSelect={() => {}}
            onReplay={() => {}}
            onExtend={() => {}}
          />
        </div>
      )}
    </Stack>
  );
}

export default LiveAnalysis;
