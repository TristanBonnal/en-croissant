import { Alert, Button, Group, Stack, Textarea } from "@mantine/core";
import { IconFileImport, IconUpload } from "@tabler/icons-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useContext, useState } from "react";
import { useTranslation } from "react-i18next";
import { commands } from "@/bindings";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { getLastMainlinePosition, parsePGN } from "@/utils/chess";
import { unwrap } from "@/utils/unwrap";

/** Replaces the tab's game by a PGN (pasted or from a file), at the end of its main line. */
export default function ImportPgn({ onLoad }: { onLoad?: (side: "white" | "black") => void }) {
  const { t } = useTranslation();
  const store = useContext(TreeStateContext)!;
  const [pgn, setPgn] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function load(content: string) {
    setError(null);
    try {
      const tree = await parsePGN(content);
      tree.dirty = true;
      tree.position = getLastMainlinePosition(tree.root);
      store.getState().setState(tree);
      onLoad?.(tree.headers.orientation ?? "white");
      setPgn("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function openFile() {
    const file = await open({
      multiple: false,
      filters: [{ name: t("Common.PGNFile"), extensions: ["pgn"] }],
    });
    if (typeof file !== "string") return;
    try {
      const [game = ""] = unwrap(await commands.readGames(file, 0, 0));
      await load(game);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Stack gap="xs">
      <Textarea
        label={t("BestLine.ImportPgn")}
        description={t("BestLine.ImportPgn.Desc")}
        placeholder="1. e4 e5 2. Nf3 Nc6 3. Bb5"
        autosize
        minRows={2}
        maxRows={8}
        value={pgn}
        onChange={(e) => setPgn(e.currentTarget.value)}
      />
      <Group gap="xs">
        <Button
          size="xs"
          leftSection={<IconUpload size="0.9rem" />}
          disabled={!pgn.trim()}
          onClick={() => load(pgn)}
        >
          {t("BestLine.ImportPgn.Load")}
        </Button>
        <Button
          size="xs"
          variant="default"
          leftSection={<IconFileImport size="0.9rem" />}
          onClick={openFile}
        >
          {t("BestLine.ImportPgn.File")}
        </Button>
      </Group>
      {error && <Alert color="red">{error}</Alert>}
    </Stack>
  );
}
