/**
 * The 'node id' when an edge on the graph is selected: `edge:<from>→<to>`. Shared with nodes as selected,
 * Gestures like Esc and closing details don't need to be written separately for the edges. Arrows will not appear in the node IDs.
 */
const PREFIX = "edge:";
const SEPARATOR = "\u2192";

export function edgeSelection(from: string, to: string): string {
  return `${PREFIX}${from}${SEPARATOR}${to}`;
}

export function parseEdgeSelection(id: string | null): { from: string; to: string } | null {
  if (id === null || !id.startsWith(PREFIX)) return null;
  const rest = id.slice(PREFIX.length);
  const at = rest.indexOf(SEPARATOR);
  if (at <= 0 || at === rest.length - 1) return null;
  return { from: rest.slice(0, at), to: rest.slice(at + SEPARATOR.length) };
}

/** Endpoints that can be seen as a 'contract between modules': packages, directories, files */
export function isContractEnd(id: string): boolean {
  return /^(?:pkg|dir|file):./.test(id);
}
