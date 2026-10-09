import {
  ActionIcon,
  Badge,
  Box,
  Group,
  Menu,
  Table,
  Text,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import {
  IconArrowForward,
  IconChevronDown,
  IconChevronRight,
  IconDots,
  IconListDetails,
  IconPlayerPlay,
} from "@tabler/icons-react";
import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";
import { match } from "ts-pattern";
import type { BestLineNode, Candidate, CandidateStatus, MoveReason } from "@/utils/bestLine";
import { formatPercent, isTrap } from "@/utils/bestLine";
import { formatNumber } from "@/utils/format";
import { formatScore } from "@/utils/score";

const EXTEND_OPTIONS = [1, 2, 3, 5];

type Row = { node: BestLineNode; path: number[]; level: number; branching: boolean };

/** Rows of the tree: a branch is indented under its parent, a single line stays flat. */
function flatten(nodes: BestLineNode[], collapsed: Set<string>): Row[] {
  const rows: Row[] = [];
  const visit = (level: BestLineNode[], path: number[], indent: number) => {
    const branching = level.length > 1;
    level.forEach((node, i) => {
      const nodePath = [...path, i];
      const nodeIndent = branching ? indent + 1 : indent;
      rows.push({ node, path: nodePath, level: nodeIndent, branching: node.children.length > 1 });
      if (!collapsed.has(nodePath.join("."))) {
        visit(node.children, nodePath, nodeIndent);
      }
    });
  };
  visit(nodes, [], nodes.length > 1 ? -1 : 0);
  return rows;
}

function moveLabel(node: BestLineNode) {
  const fullMove = Number(node.fen.split(" ")[5]) || 1;
  const san = `${node.san}${node.annotation ?? ""}`;
  return node.color === "white" ? `${fullMove}. ${san}` : `${fullMove}... ${san}`;
}

function TrapBadge({ node }: { node: BestLineNode }) {
  const { t } = useTranslation();
  const refutation = node.children[0]?.san;
  return (
    <Tooltip
      label={
        refutation ? t("BestLine.Trap.Refutation", { move: refutation }) : t("BestLine.Trap.Desc")
      }
    >
      <Badge size="sm" color="red" variant="filled">
        {t("BestLine.Trap")}
      </Badge>
    </Tooltip>
  );
}

/** Which criterion picked a move, with the rule behind it on hover. */
function ReasonBadge({ reason }: { reason: MoveReason }) {
  const { t } = useTranslation();
  const [color, label, help] = match(reason)
    .with("score", () => ["green", t("BestLine.Reason.Score"), t("BestLine.Reason.Score.Help")])
    .with("mostPlayed", () => [
      "green",
      t("BestLine.Reason.MostPlayed"),
      t("BestLine.Reason.MostPlayed.Help"),
    ])
    .with("onlyMove", () => [
      "teal",
      t("BestLine.Reason.OnlyMove"),
      t("BestLine.Reason.OnlyMove.Help"),
    ])
    .with("engineChoice", () => [
      "blue",
      t("BestLine.Reason.EngineChoice"),
      t("BestLine.Reason.EngineChoice.Help"),
    ])
    .with("outOfBook", () => [
      "indigo",
      t("BestLine.Reason.OutOfBook"),
      t("BestLine.Reason.OutOfBook.Help"),
    ])
    .with("popular", () => [
      "gray",
      t("BestLine.Reason.Popular"),
      t("BestLine.Reason.Popular.Help"),
    ])
    .with("trap", () => ["red", t("BestLine.Reason.Trap"), t("BestLine.Reason.Trap.Help")])
    .with("manual", () => ["violet", t("BestLine.Reason.Manual"), t("BestLine.Reason.Manual.Help")])
    // Results stored by an older version.
    .with("stats", () => ["green", t("BestLine.Reason.Stats"), t("BestLine.Reason.Score.Help")])
    .with("engine", () => [
      "blue",
      t("BestLine.Reason.Engine"),
      t("BestLine.Reason.EngineChoice.Help"),
    ])
    .exhaustive();
  return (
    <Tooltip label={help} multiline w={280} withArrow>
      <Badge size="sm" color={color} variant="light" style={{ cursor: "help" }}>
        {label}
      </Badge>
    </Tooltip>
  );
}

function StatusBadge({ status }: { status: CandidateStatus }) {
  const { t } = useTranslation();
  const [color, label] = match(status)
    .with("chosen", () => ["green", t("BestLine.Status.Chosen")])
    .with("outOfTolerance", () => ["red", t("BestLine.Status.OutOfTolerance")])
    .with("fewGames", () => ["orange", t("BestLine.Status.FewGames")])
    .with("lowerScore", () => ["gray", t("BestLine.Status.LowerScore")])
    .with("other", () => ["gray", t("BestLine.Status.Other")])
    .exhaustive();
  return (
    <Badge size="xs" color={color} variant="light">
      {label}
    </Badge>
  );
}

function StatsCells({
  score,
  stats,
  precise,
  value,
  bound,
}: Pick<Candidate, "score" | "stats" | "precise" | "value" | "bound">) {
  const { t } = useTranslation();
  return (
    <>
      {/* Blue marks an evaluation that comes from the precise depth. */}
      <Table.Td c={precise ? "blue" : undefined} fw={precise ? 500 : undefined}>
        {score ? formatScore(score.value) : "-"}
      </Table.Td>
      <Table.Td>{stats ? formatPercent(stats.score) : "-"}</Table.Td>
      {/* The number the choice is actually made on. */}
      <Table.Td>
        {value === undefined ? (
          "-"
        ) : (
          <Tooltip
            label={t("BestLine.Table.Decided.Tooltip", {
              value: formatPercent(value),
              bound: formatPercent(bound ?? value),
            })}
            multiline
            w={280}
            withArrow
          >
            <span style={{ cursor: "help" }}>{formatPercent(bound ?? value)}</span>
          </Tooltip>
        )}
      </Table.Td>
      <Table.Td>{stats ? formatPercent(stats.share) : "-"}</Table.Td>
      <Table.Td>{stats ? formatNumber(stats.games) : "-"}</Table.Td>
    </>
  );
}

/** Rows of the moves considered instead of `node`, aligned on the table columns. */
function AlternativeRows({
  node,
  indent,
  disabled,
  onPlay,
}: {
  node: BestLineNode;
  indent: number;
  disabled: boolean;
  onPlay: (san: string) => void;
}) {
  const { t } = useTranslation();
  const style = { backgroundColor: "var(--mantine-color-default-hover)" };
  if (node.candidates.length === 0) {
    return (
      <Table.Tr style={style}>
        <Table.Td colSpan={8}>
          <Text size="xs" c="dimmed" pl={`${indent + 1.4}rem`}>
            {t("BestLine.NoAlternatives")}
          </Text>
        </Table.Td>
      </Table.Tr>
    );
  }
  return node.candidates.map((c) => (
    <Table.Tr key={c.san} style={style} fz="xs">
      <Table.Td>
        <Text size="xs" pl={`${indent + 1.4}rem`}>
          ↳ {c.san}
        </Text>
      </Table.Td>
      <StatsCells
        score={c.score}
        stats={c.stats}
        precise={c.precise}
        value={c.value}
        bound={c.bound}
      />
      <Table.Td>
        <StatusBadge status={c.status} />
      </Table.Td>
      <Table.Td>
        {c.san !== node.san && (
          <Tooltip label={t("BestLine.PlayInstead")}>
            <ActionIcon
              size="sm"
              variant="subtle"
              disabled={disabled}
              onClick={() => onPlay(c.san)}
            >
              <IconPlayerPlay size="0.9rem" />
            </ActionIcon>
          </Tooltip>
        )}
      </Table.Td>
    </Table.Tr>
  ));
}

export default function BestLineTable({
  nodes,
  color,
  metric,
  disabled,
  onSelect,
  onReplay,
  onExtend,
}: {
  nodes: BestLineNode[];
  color: "white" | "black";
  metric: "wins" | "score";
  disabled: boolean;
  onSelect: (path: number[]) => void;
  onReplay: (path: number[], san: string) => void;
  onExtend: (path: number[], fullMoves: number) => void;
}) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);

  function toggleCollapsed(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const rows = flatten(nodes, collapsed);

  return (
    <Table striped fz="sm" verticalSpacing={4}>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>{t("BestLine.Table.Move")}</Table.Th>
          <Table.Th>
            <Tooltip label={t("BestLine.Table.Eval.Help")} multiline w={280} withArrow>
              <span style={{ textDecoration: "underline dotted", cursor: "help" }}>
                {t("BestLine.Table.Eval")}
              </span>
            </Tooltip>
          </Table.Th>
          <Table.Th>
            {t(metric === "wins" ? "BestLine.Table.Winrate" : "BestLine.Table.Score")}
          </Table.Th>
          <Table.Th>
            <Tooltip label={t("BestLine.Table.Decided.Help")} multiline w={300} withArrow>
              <span style={{ textDecoration: "underline dotted", cursor: "help" }}>
                {t("BestLine.Table.Decided")}
              </span>
            </Tooltip>
          </Table.Th>
          <Table.Th>{t("BestLine.Table.Share")}</Table.Th>
          <Table.Th>{t("Common.Games")}</Table.Th>
          <Table.Th>{t("BestLine.Table.Reason")}</Table.Th>
          <Table.Th />
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {rows.map(({ node, path, level, branching }) => {
          const key = path.join(".");
          return (
            <Fragment key={key}>
              <Table.Tr>
                <Table.Td>
                  <Group gap={4} wrap="nowrap" pl={`${Math.max(0, level) * 0.9}rem`}>
                    {branching ? (
                      <ActionIcon size="xs" variant="subtle" onClick={() => toggleCollapsed(key)}>
                        {collapsed.has(key) ? (
                          <IconChevronRight size="0.8rem" />
                        ) : (
                          <IconChevronDown size="0.8rem" />
                        )}
                      </ActionIcon>
                    ) : (
                      <Box w="1.1rem" />
                    )}
                    <UnstyledButton onClick={() => onSelect(path)}>
                      <Text
                        size="sm"
                        fw={node.color === color ? "bold" : undefined}
                        td="underline dotted"
                      >
                        {moveLabel(node)}
                      </Text>
                    </UnstyledButton>
                  </Group>
                </Table.Td>
                <StatsCells
                  score={node.score}
                  stats={node.stats}
                  precise={node.precise}
                  value={node.value}
                  bound={node.bound}
                />
                <Table.Td>
                  <Group gap={4} wrap="nowrap">
                    <ReasonBadge reason={node.reason} />
                    {isTrap(node) && <TrapBadge node={node} />}
                  </Group>
                </Table.Td>
                <Table.Td>
                  <Menu position="bottom-end" withinPortal>
                    <Menu.Target>
                      <ActionIcon size="sm" variant="subtle">
                        <IconDots size="0.9rem" />
                      </ActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item
                        leftSection={<IconListDetails size="0.9rem" />}
                        onClick={() => setExpanded(expanded === key ? null : key)}
                      >
                        {t("BestLine.ShowAlternatives")}
                      </Menu.Item>
                      {node.children.length === 0 && (
                        <>
                          <Menu.Divider />
                          <Menu.Label>{t("BestLine.Extend")}</Menu.Label>
                          {EXTEND_OPTIONS.map((n) => (
                            <Menu.Item
                              key={n}
                              disabled={disabled}
                              leftSection={<IconArrowForward size="0.9rem" />}
                              onClick={() => onExtend(path, n)}
                            >
                              +{n}
                            </Menu.Item>
                          ))}
                        </>
                      )}
                    </Menu.Dropdown>
                  </Menu>
                </Table.Td>
              </Table.Tr>
              {expanded === key && (
                <AlternativeRows
                  node={node}
                  indent={Math.max(0, level) * 0.9}
                  disabled={disabled}
                  onPlay={(san) => {
                    setExpanded(null);
                    onReplay(path, san);
                  }}
                />
              )}
            </Fragment>
          );
        })}
      </Table.Tbody>
    </Table>
  );
}
