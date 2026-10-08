import {
  Alert,
  Button,
  Group,
  Modal,
  SegmentedControl,
  Select,
  Stack,
  TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useLoaderData } from "@tanstack/react-router";
import { useContext, useState } from "react";
import { useTranslation } from "react-i18next";
import useSWR, { mutate } from "swr";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import type { BestLineResult } from "@/state/atoms";
import { getNodeAtPath } from "@/utils/treeReducer";
import { addToRepertoire, createRepertoire, listRepertoires, repertoireColor } from "./repertoire";
import { toTreeMoves } from "./runner";

/** Moves played from the root of the move tree to `path`. */
function sansAlong(root: Parameters<typeof getNodeAtPath>[0], path: number[]) {
  return path.map((_, i) => getNodeAtPath(root, path.slice(0, i + 1)).san ?? "");
}

export default function AddToRepertoireModal({
  opened,
  onClose,
  result,
}: {
  opened: boolean;
  onClose: () => void;
  result: BestLineResult;
}) {
  const { t } = useTranslation();
  const { documentDir } = useLoaderData({ from: "/" });
  const store = useContext(TreeStateContext)!;

  const [target, setTarget] = useState<"existing" | "new">("existing");
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [color, setColor] = useState<"white" | "black">(result.color);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const { data: repertoires } = useSWR(opened ? ["best-line-repertoires", documentDir] : null, () =>
    listRepertoires(documentDir),
  );
  const selectedFile = repertoires?.find((f) => f.path === selected);
  const { data: selectedColor } = useSWR(
    selectedFile ? ["repertoire-color", selectedFile.path] : null,
    () => repertoireColor(selectedFile!),
  );
  const targetColor = target === "existing" ? selectedColor : color;

  async function add() {
    setError(null);
    setSaving(true);
    try {
      const file =
        target === "existing"
          ? selectedFile
          : await createRepertoire(documentDir, name.trim(), color);
      if (!file) return;
      const { root } = store.getState();
      const where = await addToRepertoire(file, {
        rootFen: root.fen,
        prefix: sansAlong(root, result.startPath),
        moves: toTreeMoves(result.nodes, result.color, result.metric),
      });
      mutate((key) => Array.isArray(key) && key[0] === "file-directory");
      notifications.show({
        color: "green",
        title: t("BestLine.Repertoire.Added", { name: file.name }),
        message: where === "tab" ? t("BestLine.Repertoire.AddedToTab") : "",
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal opened={opened} onClose={onClose} title={t("BestLine.Repertoire.Title")}>
      <Stack>
        <SegmentedControl
          value={target}
          onChange={(v) => setTarget(v as "existing" | "new")}
          data={[
            { label: t("BestLine.Repertoire.Existing"), value: "existing" },
            { label: t("BestLine.Repertoire.New"), value: "new" },
          ]}
        />
        {target === "existing" ? (
          <Select
            label={t("Files.FileType.Repertoire")}
            placeholder={t("BestLine.Repertoire.Pick")}
            data={(repertoires ?? []).map((f) => ({ value: f.path, label: f.name }))}
            value={selected}
            onChange={setSelected}
            nothingFoundMessage={t("BestLine.Repertoire.None")}
            searchable
          />
        ) : (
          <>
            <TextInput
              label={t("Common.Name")}
              placeholder={t("Home.Card.NewRepertoire.NamePlaceholder")}
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
            />
            <SegmentedControl
              value={color}
              onChange={(v) => setColor(v as "white" | "black")}
              data={[
                { label: t("Fen.White"), value: "white" },
                { label: t("Fen.Black"), value: "black" },
              ]}
            />
          </>
        )}
        {targetColor && targetColor !== result.color && (
          <Alert color="yellow">{t("BestLine.Repertoire.ColorMismatch")}</Alert>
        )}
        {error && <Alert color="red">{error}</Alert>}
        <Group justify="right">
          <Button
            onClick={add}
            loading={saving}
            disabled={target === "existing" ? !selectedFile : !name.trim()}
          >
            {t("BestLine.Repertoire.Add")}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
