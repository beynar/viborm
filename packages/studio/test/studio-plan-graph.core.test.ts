import { expect, test } from "vitest";
import type { PlanNode } from "../src/plan";
import { planGraph } from "../ui/src/lib/plan-graph";

const node = (
  id: string,
  kind: PlanNode["kind"],
  children: PlanNode[] = []
): PlanNode => ({
  id,
  kind,
  operation: kind,
  fullScan: kind === "scan",
  children,
  conditions: [],
  facts: [],
});

test("a limit may stop a streaming scan early", () => {
  const graph = planGraph(
    node("limit", "limit", [node("scan", "scan")]),
    undefined
  );
  expect(
    graph.nodes.find((entry) => entry.id === "scan")?.data.underLimit
  ).toBe(true);
});

test.each([
  "sort",
  "aggregate",
  "materialize",
] satisfies PlanNode["kind"][])("a limit does not suppress input estimate mismatches below %s", (kind) => {
  const graph = planGraph(
    node("limit", "limit", [node("blocker", kind, [node("scan", "scan")])]),
    undefined
  );
  expect(
    graph.nodes.find((entry) => entry.id === "blocker")?.data.underLimit
  ).toBe(true);
  expect(
    graph.nodes.find((entry) => entry.id === "scan")?.data.underLimit
  ).toBe(false);
});

test("a nested limit still stops its own input below a blocking operation", () => {
  const graph = planGraph(
    node("outer", "limit", [
      node("sort", "sort", [node("inner", "limit", [node("scan", "scan")])]),
    ]),
    undefined
  );
  expect(
    graph.nodes.find((entry) => entry.id === "inner")?.data.underLimit
  ).toBe(false);
  expect(
    graph.nodes.find((entry) => entry.id === "scan")?.data.underLimit
  ).toBe(true);
});
