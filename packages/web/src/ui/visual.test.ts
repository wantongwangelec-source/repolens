import type { GraphNodeDto } from "@repolens/core/types";
import { describe, expect, it } from "vitest";
import { displayLabels } from "./visual";

function pkg(id: string, label: string, path: string): GraphNodeDto {
  return {
    id, kind: "package", label, path, childCount: 0, expandable: false,
    metrics: { loc: 0, files: 0, symbols: 0, complexity: 0, inDegree: 0, outDegree: 0 } as GraphNodeDto["metrics"],
  };
}

describe("displayLabels", () => {
  it("包名去掉 @scope/ 后不重名就去掉，重名的保留 scope 当区分", () => {
    const labels = displayLabels([
      pkg("pkg:@acme/ai", "@acme/ai", "packages/ai"),
      pkg("pkg:@acme/tui", "@acme/tui", "packages/tui"),
      pkg("pkg:@other/tui", "@other/tui", "vendor/tui"),
    ]);
    expect(labels.get("pkg:@acme/ai")).toBe("ai");
    expect(labels.get("pkg:@acme/tui")).toBe("@acme/tui");
    expect(labels.get("pkg:@other/tui")).toBe("@other/tui");
  });

  it("连原名都一样的包补上目录，不再显示成两个一模一样的节点", () => {
    const labels = displayLabels([
      pkg("pkg:pi-env#a", "pi-env", "packages/env"),
      pkg("pkg:pi-env#b", "pi-env", "examples/env"),
      pkg("pkg:core", "core", "packages/core"),
    ]);
    expect(labels.get("pkg:pi-env#a")).toBe("pi-env (packages/env)");
    expect(labels.get("pkg:pi-env#b")).toBe("pi-env (examples/env)");
    expect(labels.get("pkg:core")).toBe("core");
  });
});
