import { expect, test } from "vitest";
import { getMoveText } from "../chess";
import { colorComment, stripCommentColors } from "../commentColor";
import { defaultTree } from "../treeReducer";

test("colorComment wraps the text in a colored span", () => {
    expect(colorComment("57.8%", "green")).toBe(
        '<span class="ec-comment-color" style="color: var(--mantine-color-green-6)">57.8%</span>',
    );
});

test("stripCommentColors keeps only the text of colored spans", () => {
    expect(stripCommentColors(`${colorComment("57.8%", "green")} and more`)).toBe("57.8% and more");
});

test("stripCommentColors leaves other markup untouched", () => {
    expect(stripCommentColors("<u>under</u> <span>plain</span>")).toBe(
        "<u>under</u> <span>plain</span>",
    );
});

test("getMoveText exports colored comments as plain text", () => {
    const node = { ...defaultTree().root, comment: colorComment("+0.45", "blue") };
    expect(getMoveText(node, { glyphs: false, comments: true, extraMarkups: false })).toBe(
        "{+0.45} ",
    );
});
