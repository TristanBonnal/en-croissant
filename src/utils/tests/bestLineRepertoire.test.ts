import { INITIAL_FEN } from "chessops/fen";
import { expect, test } from "vitest";
import { mergeIntoRepertoire } from "@/components/bestLine/repertoire";
import { createTreeStore } from "@/state/store/tree";
import { defaultTree, getNodeAtPath, type TreeState } from "@/utils/treeReducer";

function treeWith(moves: string[]): TreeState {
    const store = createTreeStore();
    store.getState().addLine(moves.map((san) => ({ san })));
    const { root, headers } = store.getState();
    return { ...defaultTree(), root, headers };
}

const sans = (tree: TreeState, path: number[]) =>
    getNodeAtPath(tree.root, path).children.map((c) => c.san);

test("mergeIntoRepertoire adds the line after the moves leading to its start", () => {
    const merged = mergeIntoRepertoire(
        treeWith(["e4", "e5"]),
        INITIAL_FEN,
        ["e4"],
        [
            {
                san: "e5",
                comment: "played",
                children: [{ san: "Nf3", comment: "winrate", children: [] }],
            },
        ],
    );
    expect(merged).not.toBeNull();
    expect(sans(merged!, [])).toEqual(["e4"]);
    expect(sans(merged!, [0])).toEqual(["e5"]);
    expect(sans(merged!, [0, 0])).toEqual(["Nf3"]);
    expect(getNodeAtPath(merged!.root, [0, 0, 0]).comment).toBe("winrate");
    expect(merged!.dirty).toBe(true);
});

test("mergeIntoRepertoire adds new moves as variations", () => {
    const merged = mergeIntoRepertoire(
        treeWith(["e4", "e5"]),
        INITIAL_FEN,
        [],
        [{ san: "e4", children: [{ san: "c5", children: [] }] }],
    );
    expect(sans(merged!, [0])).toEqual(["e5", "c5"]);
});

test("mergeIntoRepertoire keeps the repertoire headers", () => {
    const tree = treeWith([]);
    tree.headers = { ...tree.headers, event: "My repertoire", orientation: "black" };
    const merged = mergeIntoRepertoire(tree, INITIAL_FEN, [], [{ san: "e4", children: [] }]);
    expect(merged!.headers.event).toBe("My repertoire");
    expect(merged!.headers.orientation).toBe("black");
});

test("mergeIntoRepertoire refuses a line from another starting position", () => {
    const fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
    expect(mergeIntoRepertoire(treeWith([]), fen, [], [{ san: "e5", children: [] }])).toBeNull();
});

test("mergeIntoRepertoire refuses moves that cannot be played", () => {
    expect(mergeIntoRepertoire(treeWith([]), INITIAL_FEN, ["e5"], [])).toBeNull();
});
