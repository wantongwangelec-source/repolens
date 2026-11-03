import type { ParsedSymbol } from "../types.js";

/**
 * Code line count.
 *
 * What is being counted is 'non-empty, non-pure comment lines,' not the total number of lines in the file. The reason is that this number will be directly encoded into
 * The heat of the directory tree and the size of the nodes on the graph—counting the 200 lines of license headers will make users
 * Focus your attention on the wrong place.
 */
export function countLoc(source: string, language: string): number {
  const commentPrefixes = lineCommentPrefixes(language);
  const block = blockCommentDelimiters(language);

  let loc = 0;
  let inBlock = false;

  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    if (inBlock) {
      if (block && line.includes(block[1])) inBlock = false;
      continue;
    }

    if (block && line.startsWith(block[0])) {
      // Single-line inline block comments do not enter block state
      if (!line.slice(block[0].length).includes(block[1])) inBlock = true;
      continue;
    }

    if (commentPrefixes.some((prefix) => line.startsWith(prefix))) continue;

    loc++;
  }

  return loc;
}

/**
 * Complexity is measured by the number of AST subtrees, functions nested within other functions but forming their own symbols (inline route handlers,
 * The local functions in the component) are also counted towards the outer layer, resulting in double counting when calculating the total for the file. Here, each function is accounted for as
 * Considering only my own part, the caliber is consistent with ESLint's complexity rule.
 */
export function excludeNestedComplexity(symbols: readonly ParsedSymbol[]): ParsedSymbol[] {
  const functions = symbols
    .map((symbol, index) => ({ symbol, index }))
    .filter(({ symbol }) => symbol.kind === "function" || symbol.kind === "method");
  const own = symbols.map((symbol) => symbol.complexity);
  const span = (s: ParsedSymbol) => s.endByte - s.startByte;

  for (const inner of functions) {
    let parent: (typeof functions)[number] | null = null;
    for (const outer of functions) {
      const o = outer.symbol;
      const i = inner.symbol;
      if (outer === inner || o.startByte > i.startByte || i.endByte > o.endByte || span(o) === span(i)) continue;
      if (parent === null || span(o) < span(parent.symbol)) parent = outer;
    }
    if (parent !== null) own[parent.index]! -= inner.symbol.complexity - 1;
  }

  return symbols.map((symbol, index) =>
    own[index] === symbol.complexity ? symbol : { ...symbol, complexity: Math.max(1, own[index]!) });
}

function lineCommentPrefixes(language: string): string[] {
  switch (language) {
    case "python":
    case "yaml":
    case "shell":
    case "toml":
      return ["#"];
    default:
      return ["//"];
  }
}

function blockCommentDelimiters(language: string): [string, string] | null {
  switch (language) {
    case "python":
    case "yaml":
    case "shell":
    case "toml":
      return null;
    default:
      return ["/*", "*/"];
  }
}
