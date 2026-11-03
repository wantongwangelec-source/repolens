/**
 * A single line exceeding this length is most likely base64, compressed code, or inline data. Sending the entire line to the model makes it unreadable.
 * What, yet it can consume more than half of the budget in a single line, pushing out the real code that comes afterwards.
 */
export const MAX_SOURCE_LINE_CHARS = 400;
const ELIDED_LINE_KEEP = 120;
const ELIDED_LINE_MARK = /…（省略 \d+ 字符）$/m;

/**
 * Add the prefix 'line number | ' to the source code before giving it to the model. The model cannot count lines accurately, so only by using absolute line numbers
 * It is clearly written at the beginning of each line, only then can the indicated range match. For overly long lines, only the beginning is kept and noted.
 * The number of omissions does not affect the line numbers; when the budget is exceeded, it is truncated at the whole line.
 */
export function numberSourceLines(text: string, firstLine: number, maxChars: number): string {
  const lines = text.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  const out: string[] = [];
  let used = 0;
  for (const [index, line] of lines.entries()) {
    const numbered = String(firstLine + index) + "| " + elideLongLine(line);
    if (out.length > 0 && used + numbered.length + 1 > maxChars) break;
    out.push(numbered);
    used += numbered.length + 1;
  }
  return out.join("\n");
}

function elideLongLine(line: string): string {
  if (line.length <= MAX_SOURCE_LINE_CHARS) return line;
  return `${line.slice(0, ELIDED_LINE_KEEP)}…（省略 ${line.length - ELIDED_LINE_KEEP} 字符）`;
}

/** Whether there are shortened lines in the output of numberSourceLines, used to decide whether to explain this token to the model */
export function hasElidedLines(numbered: string): boolean {
  return ELIDED_LINE_MARK.test(numbered);
}
