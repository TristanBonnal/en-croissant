/**
 * Colored text in move comments. The color is only shown in the app: PGN
 * export keeps the text and drops the markup.
 */
export type CommentColor = "green" | "blue";

const COLOR_CLASS = "ec-comment-color";
const COLORED_SPAN = new RegExp(`<span class="${COLOR_CLASS}"[^>]*>([\\s\\S]*?)</span>`, "g");

export function colorComment(text: string, color: CommentColor): string {
    return `<span class="${COLOR_CLASS}" style="color: var(--mantine-color-${color}-6)">${text}</span>`;
}

export function stripCommentColors(comment: string): string {
    return comment.replace(COLORED_SPAN, "$1");
}
