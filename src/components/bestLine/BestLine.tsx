import { Portal, Stack } from "@mantine/core";
import { useHotkeys, useToggle } from "@mantine/hooks";
import type { Piece } from "chessops";
import { useAtomValue } from "jotai";
import { useContext, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { useOpenInAnalysis } from "@/hooks/useOpenInAnalysis";
import { useSaveFile } from "@/hooks/useSaveFile";
import { keyMapAtom } from "@/state/keybinds";
import Board from "../boards/Board";
import BoardControls from "../boards/BoardControls";
import EditingCard from "../boards/EditingCard";
import GameNotation from "../common/GameNotation";
import MoveControls from "../common/MoveControls";
import { TreeStateContext } from "../common/TreeStateContext";
import BestLinePanel from "./BestLinePanel";
import { registerTreeStore } from "./runner";

function BestLine({ id }: { id: string }) {
  const [editingMode, toggleEditingMode] = useToggle();
  const [selectedPiece, setSelectedPiece] = useState<Piece | null>(null);
  const boardRef = useRef(null);

  const store = useContext(TreeStateContext)!;
  const clearShapes = useStore(store, (s) => s.clearShapes);
  const { dirty, userSaveFile } = useSaveFile();
  const keyMap = useAtomValue(keyMapAtom);
  const openInAnalysis = useOpenInAnalysis("BestLine.Title");

  useEffect(() => registerTreeStore(id, store), [id, store]);

  useHotkeys([
    [keyMap.SAVE_FILE.keys, () => userSaveFile()],
    [keyMap.CLEAR_SHAPES.keys, () => clearShapes()],
  ]);

  return (
    <>
      <Portal target="#left" style={{ height: "100%" }}>
        <Board editingMode={editingMode} boardRef={boardRef} selectedPiece={selectedPiece} />
      </Portal>
      <Portal target="#topRight" style={{ height: "100%" }}>
        <BestLinePanel id={id} />
      </Portal>
      <Portal target="#bottomRight" style={{ height: "100%" }}>
        {editingMode ? (
          <EditingCard
            boardRef={boardRef}
            setEditingMode={toggleEditingMode}
            selectedPiece={selectedPiece}
            setSelectedPiece={setSelectedPiece}
          />
        ) : (
          <Stack h="100%" gap="xs">
            <GameNotation
              topBar
              controls={
                <BoardControls
                  editingMode={editingMode}
                  toggleEditingMode={toggleEditingMode}
                  dirty={dirty}
                  saveFile={userSaveFile}
                  onOpenInAnalysis={openInAnalysis}
                />
              }
            />
            <MoveControls />
          </Stack>
        )}
      </Portal>
    </>
  );
}

export default BestLine;
