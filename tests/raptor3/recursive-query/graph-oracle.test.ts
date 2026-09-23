import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  generateFixedCases,
  RQ06_CASES_PER_PROFILE,
  RQ06_FIXED_CASES,
  RQ06_FIXED_CORPUS_IDENTITY,
  recursiveCorpusIdentity,
  serializeRecursiveCase,
} from "./fixed-cases";
import {
  evaluateRecursiveCase,
  type RecursiveGraphCase,
  type RecursiveProfile,
} from "./graph-oracle";

function tinyCase(
  values: Omit<
    RecursiveGraphCase,
    "formatVersion" | "caseId" | "seed" | "order"
  >
): RecursiveGraphCase {
  return {
    formatVersion: 1,
    caseId: "rq06:hand:000",
    seed: 0,
    order: "asc",
    ...values,
  };
}

describe("RQ-06 independent recursive graph oracle", () => {
  it("omits the repeated key exactly at a numeric cutoff", () => {
    const testCase = tinyCase({
      profile: "collection-fk",
      relation: "children",
      roots: ["root"],
      nodes: [
        { id: "root", order: 0, included: true },
        { id: "child", order: 1, included: true },
        { id: "grandchild", order: 2, included: true },
      ],
      edges: [
        { from: "root", to: "child" },
        { from: "child", to: "grandchild" },
      ],
      recurse: { depth: 1 },
    });
    assert.deepEqual(evaluateRecursiveCase(testCase), {
      kind: "rows",
      rows: [
        {
          id: "root",
          order: 0,
          children: [{ id: "child", order: 1 }],
        },
      ],
    });
  });

  it("keeps natural empty collection and singular ends before the cutoff", () => {
    const collection = tinyCase({
      profile: "collection-fk",
      relation: "children",
      roots: ["root"],
      nodes: [{ id: "root", order: 0, included: true }],
      edges: [],
      recurse: { depth: 2 },
    });
    const singular = tinyCase({
      profile: "singular-fk",
      relation: "parent",
      roots: ["root"],
      nodes: [{ id: "root", order: 0, included: true }],
      edges: [],
      recurse: true,
      singularMayBeEmpty: true,
    });
    assert.deepEqual(evaluateRecursiveCase(collection), {
      kind: "rows",
      rows: [{ id: "root", order: 0, children: [] }],
    });
    assert.deepEqual(evaluateRecursiveCase(singular), {
      kind: "rows",
      rows: [{ id: "root", order: 0, parent: null }],
    });
  });

  it("filters a target with its branch and orders siblings numerically", () => {
    const tree = tinyCase({
      profile: "collection-fk",
      relation: "children",
      roots: ["root"],
      nodes: [
        { id: "root", order: 0, included: true },
        { id: "fast", order: 1, included: true },
        { id: "slow", order: 3, included: true },
        { id: "blocked", order: 5, included: false },
        { id: "under-blocked", order: 8, included: true },
      ],
      edges: [
        { from: "root", to: "fast" },
        { from: "root", to: "slow" },
        { from: "root", to: "blocked" },
        { from: "blocked", to: "under-blocked" },
      ],
      recurse: { depth: false },
    });
    assert.deepEqual(evaluateRecursiveCase(tree), {
      kind: "rows",
      rows: [
        {
          id: "root",
          order: 0,
          children: [
            { id: "fast", order: 1, children: [] },
            { id: "slow", order: 3, children: [] },
          ],
        },
      ],
    });
  });

  it("does not inspect an FK cycle beyond the cutoff and attributes one inside it", () => {
    const cycle = tinyCase({
      profile: "singular-fk",
      relation: "parent",
      roots: ["root"],
      nodes: [
        { id: "root", order: 0, included: true },
        { id: "parent", order: 1, included: true },
      ],
      edges: [
        { from: "root", to: "parent" },
        { from: "parent", to: "root" },
      ],
      recurse: { depth: 1 },
      singularMayBeEmpty: true,
    });
    assert.deepEqual(evaluateRecursiveCase(cycle), {
      kind: "rows",
      rows: [{ id: "root", order: 0, parent: { id: "parent", order: 1 } }],
    });
    assert.deepEqual(
      evaluateRecursiveCase({ ...cycle, recurse: { depth: false } }),
      {
        kind: "error",
        error: {
          kind: "fk-cycle",
          relation: "parent",
          path: ["root", "parent", "root"],
        },
      }
    );
  });

  it("ORACLE-ONLY (CM002): reports an absent required singular target without fabricating a row", () => {
    const required = tinyCase({
      profile: "singular-fk",
      relation: "parent",
      singularMayBeEmpty: false,
      roots: ["root"],
      nodes: [{ id: "root", order: 0, included: true }],
      edges: [],
      recurse: { depth: false },
    });
    assert.deepEqual(evaluateRecursiveCase(required), {
      kind: "error",
      error: {
        kind: "required-singular-missing",
        relation: "parent",
        source: "root",
      },
    });
  });

  it("prunes graph cycles per root path but preserves diamond occurrences", () => {
    const graph = tinyCase({
      profile: "junction",
      relation: "neighbors",
      roots: ["root"],
      nodes: [
        { id: "root", order: 0, included: true },
        { id: "left", order: 1, included: true },
        { id: "right", order: 2, included: true },
        { id: "shared", order: 3, included: true },
      ],
      edges: [
        { from: "root", to: "left" },
        { from: "root", to: "right" },
        { from: "left", to: "shared" },
        { from: "right", to: "shared" },
        { from: "shared", to: "root" },
      ],
      recurse: { depth: false, preventCycles: true },
    });
    assert.deepEqual(evaluateRecursiveCase(graph), {
      kind: "rows",
      rows: [
        {
          id: "root",
          order: 0,
          neighbors: [
            {
              id: "left",
              order: 1,
              neighbors: [{ id: "shared", order: 3, neighbors: [] }],
            },
            {
              id: "right",
              order: 2,
              neighbors: [{ id: "shared", order: 3, neighbors: [] }],
            },
          ],
        },
      ],
    });
  });

  it("allows bounded graph recurrence when cycle prevention is disabled", () => {
    const graph = tinyCase({
      profile: "junction",
      relation: "neighbors",
      roots: ["root"],
      nodes: [{ id: "root", order: 0, included: true }],
      edges: [{ from: "root", to: "root" }],
      recurse: { depth: 2, preventCycles: false },
    });
    assert.deepEqual(evaluateRecursiveCase(graph), {
      kind: "rows",
      rows: [
        {
          id: "root",
          order: 0,
          neighbors: [
            {
              id: "root",
              order: 0,
              neighbors: [{ id: "root", order: 0 }],
            },
          ],
        },
      ],
    });
  });

  it("seeds an independent active path for every outer root", () => {
    const graph = tinyCase({
      profile: "junction",
      relation: "neighbors",
      roots: ["left", "right"],
      nodes: [
        { id: "left", order: 0, included: true },
        { id: "right", order: 1, included: true },
      ],
      edges: [
        { from: "left", to: "right" },
        { from: "right", to: "left" },
      ],
      recurse: { depth: false, preventCycles: true },
    });
    assert.deepEqual(evaluateRecursiveCase(graph), {
      kind: "rows",
      rows: [
        {
          id: "left",
          order: 0,
          neighbors: [{ id: "right", order: 1, neighbors: [] }],
        },
        {
          id: "right",
          order: 1,
          neighbors: [{ id: "left", order: 0, neighbors: [] }],
        },
      ],
    });
  });

  it("freezes 100 reproducible serialized cases per profile", () => {
    const profiles: readonly RecursiveProfile[] = [
      "singular-fk",
      "collection-fk",
      "junction",
    ];
    assert.equal(RQ06_FIXED_CASES.length, 3 * RQ06_CASES_PER_PROFILE);
    assert.equal(
      new Set(RQ06_FIXED_CASES.map((entry) => entry.caseId)).size,
      300
    );

    for (const profile of profiles)
      assert.equal(generateFixedCases(profile).length, RQ06_CASES_PER_PROFILE);

    assert.deepEqual(
      recursiveCorpusIdentity(RQ06_FIXED_CASES),
      RQ06_FIXED_CORPUS_IDENTITY
    );
    assert.equal(
      new Set(RQ06_FIXED_CASES.map(serializeRecursiveCase)).size,
      RQ06_FIXED_CASES.length
    );

    // No saved case may need a required self foreign key: CM002 refuses that
    // schema, so the campaign could never execute it (RQ-06 reconciliation).
    for (const entry of RQ06_FIXED_CASES)
      if (entry.profile === "singular-fk")
        assert.equal(entry.singularMayBeEmpty, true, entry.caseId);
    // The ring the old required flag used to force is kept on the same seeds
    // (singular-fk, seed % 3 === 0): every node still has exactly one parent.
    for (const entry of RQ06_FIXED_CASES) {
      if (entry.profile !== "singular-fk" || entry.seed % 3 !== 0) continue;
      const nodeIds = new Set(entry.nodes.map((node) => node.id));
      const outgoing = new Map(entry.nodes.map((node) => [node.id, 0]));
      for (const edge of entry.edges) {
        assert.ok(nodeIds.has(edge.from));
        assert.ok(nodeIds.has(edge.to));
        outgoing.set(edge.from, outgoing.get(edge.from)! + 1);
      }
      for (const count of outgoing.values()) assert.equal(count, 1);
    }

    const exhaustiveFkFailures = RQ06_FIXED_CASES.filter(
      (entry) =>
        entry.profile !== "junction" &&
        entry.recurse !== true &&
        entry.recurse.depth === false &&
        evaluateRecursiveCase(entry).kind === "error"
    );
    assert.ok(exhaustiveFkFailures.length > 0);

    const graphInputs = generateFixedCases("junction").map(
      (entry) => entry.recurse
    );
    assert.ok(graphInputs.some((input) => input === true));
    assert.ok(
      graphInputs.some(
        (input) => input !== true && Object.keys(input).length === 0
      )
    );
    assert.ok(
      graphInputs.some(
        (input) =>
          input !== true &&
          input.depth === false &&
          "preventCycles" in input &&
          input.preventCycles === true
      )
    );
    assert.ok(
      graphInputs.some(
        (input) =>
          input !== true &&
          "preventCycles" in input &&
          input.preventCycles === false
      )
    );
  });
});
