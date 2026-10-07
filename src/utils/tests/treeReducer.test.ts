import { expect, test } from "vitest";
import { createTreeStore } from "@/state/store/tree";
import { findPathBySans } from "../treeReducer";

function rootWith(lines: string[][]) {
    const store = createTreeStore();
    for (const line of lines) {
        store.getState().addLine(
            line.map((san) => ({ san })),
            [],
        );
    }
    return store.getState().root;
}

test("findPathBySans follows the moves from a node", () => {
    const root = rootWith([
        ["e4", "e5"],
        ["e4", "c5", "Nf3"],
    ]);
    expect(findPathBySans(root, [], ["e4", "c5", "Nf3"])).toEqual([0, 1, 0]);
    expect(findPathBySans(root, [0], ["e5"])).toEqual([0, 0]);
});

test("findPathBySans ignores check marks", () => {
    const root = rootWith([["e4", "f5", "Qh5+"]]);
    expect(findPathBySans(root, [], ["e4", "f5", "Qh5"])).toEqual([0, 0, 0]);
});

test("findPathBySans returns null when a move is missing", () => {
    const root = rootWith([["e4", "e5"]]);
    expect(findPathBySans(root, [], ["e4", "c5"])).toBeNull();
});
