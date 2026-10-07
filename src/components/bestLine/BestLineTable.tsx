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
import { formatPercent } from "@/utils/bestLine";
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
  return node.color === "white" ? `${fullMove}. ${node.san}` : `${fullMove}... ${node.san}`;
}

function ReasonBadge({ reason }: { reason: MoveReason }) {
  const { t } = useTranslation();
  const [color, label] = match(reason)
    .with("stats", () => ["green", t("BestLine.Reason.Stats")])
    .with("popular", () => ["gray", t("BestLine.Reason.Popular")])
    .with("engine", () => ["blue", t("BestLine.Reason.Engine")])
    .with("manual", () => ["violet", t("BestLine.Reason.Manual")])
    .exhaustive();
  return (
    <Badge size="sm" color={color} variant="light">
      {label}
    </Badge>
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

function StatsCells({ score, stats }: Pick<Candidate, "score" | "stats">) {
  return (
    <>
      <Table.Td>{score ? formatScore(score.value) : "-"}</Table.Td>
      <Table.Td>{stats ? formatPercent(stats.score) : "-"}</Table.Td>
      <Table.Td>{stats ? formatPercent(stats.share) : "-"}</Table.Td>
      <Table.Td>{stats ? formatNumber(stats.games) : "-"}</Table.Td>
    </>
  );
}

function Alternatives({
  node,
  disabled,
  onPlay,
}: {
  node: BestLineNode;
  disabled: boolean;
  onPlay: (san: string) => void;
}) {
  const { t } = useTranslation();
  if (node.candidates.length === 0) {
    return (
      <Text size="xs" c="dimmed">
        {t("BestLine.NoAlternatives")}
      </Text>
    );
  }
  return (
    <Table withRowBorders={false} verticalSpacing={2} fz="xs">
      <Table.Tbody>
        {node.candidates.map((c) => (
          <Table.Tr key={c.san}>
            <Table.Td>{c.san}</Table.Td>
            <StatsCells score={c.score} stats={c.stats} />
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
        ))}
      </Table.Tbody>
    </Table>
  );
}

export default function BestLineTable({
  nodes,
  color,
  disabled,
  onSelect,
  onReplay,
  onExtend,
}: {
  nodes: BestLineNode[];
  color: "white" | "black";
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
          <Table.Th>{t("BestLine.Table.Eval")}</Table.Th>
          <Table.Th>{t("BestLine.Table.Score")}</Table.Th>
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
                <StatsCells score={node.score} stats={node.stats} />
                <Table.Td>
                  <ReasonBadge reason={node.reason} />
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
                <Table.Tr>
                  <Table.Td colSpan={7}>
                    <Alternatives
                      node={node}
                      disabled={disabled}
                      onPlay={(san) => {
                        setExpanded(null);
                        onReplay(path, san);
                      }}
                    />
                  </Table.Td>
                </Table.Tr>
              )}
            </Fragment>
          );
        })}
      </Table.Tbody>
    </Table>
  );
}
