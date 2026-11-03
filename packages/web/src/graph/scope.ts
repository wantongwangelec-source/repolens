import type { GraphDto, GraphNodeKind, OverviewDto } from "@repolens/core/types";
import { findNode } from "./model";

/** The space that a node occupies in the repository. The structure tree expands according to the selected item, and the sidebar list narrows based on focus, all relying on it. */
export interface NodeScope {
  id: string;
  kind: "package" | "directory" | "file" | "symbol";
  label: string;
  /** Relative path of the repository, the symbol takes the location of the file, the repository root is '.' */
  path: string;
}

const SCOPE_KINDS = new Set<GraphNodeKind>(["package", "directory", "file", "symbol"]);

/**
 * If it can be determined without sending a request, calculate it locally. Returning undefined indicates it is a file or symbol and is not in the already loaded graph.
 * Ask the server; null indicates that this node has no landing point (aggregated node, external dependency).
 */
export function scopeOf(
  nodeId: string,
  subgraphs: Record<string, GraphDto>,
  packages: OverviewDto["packages"],
): NodeScope | null | undefined {
  const dto = findNode(subgraphs, nodeId);
  if (dto && dto.path != null && SCOPE_KINDS.has(dto.kind)) {
    return { id: nodeId, kind: dto.kind as NodeScope["kind"], label: dto.label, path: dto.path };
  }
  const colon = nodeId.indexOf(":");
  const prefix = nodeId.slice(0, colon);
  const rest = nodeId.slice(colon + 1);
  if (prefix === "dir") return { id: nodeId, kind: "directory", label: baseName(rest), path: rest };
  if (prefix === "raw") return { id: nodeId, kind: "file", label: baseName(rest), path: rest };
  if (prefix === "pkg") {
    const pkg = packages.find((p) => p.id === nodeId);
    return pkg ? { id: nodeId, kind: "package", label: pkg.name, path: pkg.dir } : null;
  }
  return prefix === "file" || prefix === "sym" ? undefined : null;
}

/** Entries that fall within the range. Entries with a symbolId are compared by id within the symbol range, while all others are compared by path. */
export function inScope(scope: NodeScope, path: string, symbolId?: string | null): boolean {
  if (scope.kind === "symbol") return symbolId !== undefined ? symbolId === scope.id : path === scope.path;
  if (scope.kind === "file") return path === scope.path;
  return scope.path === "." || path === scope.path || path.startsWith(`${scope.path}/`);
}

export function baseName(path: string): string {
  return path.split("/").at(-1) || path;
}
