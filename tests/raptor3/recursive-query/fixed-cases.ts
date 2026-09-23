/**
 * The fixed RQ-06 corpus: 100 reproducible cases for each recursive profile.
 * Provider suites consume this one value so SQLite, PostgreSQL and MySQL never
 * generate similar-but-different worlds.
 */
import { createHash } from "node:crypto";
import type {
  RecurseInput,
  RecursiveGraphCase,
  RecursiveGraphEdge,
  RecursiveGraphNode,
  RecursiveProfile,
} from "./graph-oracle";

export const RQ06_CASES_PER_PROFILE = 100;

const PROFILES: readonly RecursiveProfile[] = Object.freeze([
  "singular-fk",
  "collection-fk",
  "junction",
]);

function recurrenceFor(profile: RecursiveProfile, seed: number): RecurseInput {
  if (profile !== "junction") {
    switch (seed % 6) {
      case 0:
        return true;
      case 1:
        return Object.freeze({});
      case 2:
        return Object.freeze({ depth: 1 });
      case 3:
        return Object.freeze({ depth: 2 });
      case 4:
        return Object.freeze({ depth: 4 });
      default:
        return Object.freeze({ depth: false });
    }
  }
  switch (seed % 8) {
    case 0:
      return true;
    case 1:
      return Object.freeze({});
    case 2:
      return Object.freeze({ depth: 1 });
    case 3:
      return Object.freeze({ depth: 2, preventCycles: true });
    case 4:
      return Object.freeze({ depth: 3, preventCycles: false });
    case 5:
      return Object.freeze({ depth: false, preventCycles: true });
    case 6:
      return Object.freeze({ depth: 4, preventCycles: false });
    default:
      return Object.freeze({ depth: 2 });
  }
}

function edgeCollector(): {
  readonly edges: RecursiveGraphEdge[];
  readonly add: (from: number, to: number) => void;
} {
  const edges: RecursiveGraphEdge[] = [];
  const seen = new Set<string>();
  return {
    edges,
    add(from, to) {
      const key = `${from}:${to}`;
      if (seen.has(key)) return;
      seen.add(key);
      edges.push(Object.freeze({ from: `n${from}`, to: `n${to}` }));
    },
  };
}

function generateEdges(
  profile: RecursiveProfile,
  seed: number,
  nodeCount: number,
  closesCycle: boolean
): readonly RecursiveGraphEdge[] {
  const collector = edgeCollector();

  if (profile === "singular-fk") {
    for (let index = 0; index < nodeCount - 1; index++)
      collector.add(index, index + 1);
    if (closesCycle) collector.add(nodeCount - 1, 0);
    return Object.freeze(collector.edges);
  }

  if (profile === "collection-fk") {
    for (let index = 1; index < nodeCount; index++) {
      const parent = index <= 2 ? 0 : (seed + index * 3) % index;
      collector.add(parent, index);
    }
    if (closesCycle) collector.add(nodeCount - 1, 0);
    return Object.freeze(collector.edges);
  }

  collector.add(0, 1);
  collector.add(0, 2);
  collector.add(1, 3);
  collector.add(2, 3);
  for (let index = 4; index < nodeCount; index++)
    collector.add((seed + index) % index, index);
  if (closesCycle) {
    collector.add(1, 0);
    collector.add(nodeCount - 1, 0);
  }
  if (seed % 10 === 1) collector.add(2, 2);
  return Object.freeze(collector.edges);
}

function relationFor(
  profile: RecursiveProfile
): RecursiveGraphCase["relation"] {
  if (profile === "singular-fk") return "parent";
  if (profile === "collection-fk") return "children";
  return "neighbors";
}

export function generateRecursiveCase(
  profile: RecursiveProfile,
  seed: number
): RecursiveGraphCase {
  const nodeCount = 4 + (seed % 4);
  // CM002 reconciliation (RQ-06): schema validation refuses a required ordinary
  // self foreign key ("Circular required relations") before any projection is
  // prepared, so no provider can be given a required singular self slot. Every
  // singular case therefore states the admitted NULLABLE owning relation. The
  // seeds divisible by 3 were the required cases; they keep the ring their
  // required flag used to force, so every generated graph and every expected
  // outcome is unchanged — the ring gives each node its one reference, and none
  // of them ever reached `required-singular-missing`.
  const singularMayBeEmpty = profile === "singular-fk" ? true : undefined;
  const closesCycle =
    seed % 10 === 0 ||
    seed % 10 === 5 ||
    (profile === "singular-fk" && seed % 3 === 0);
  const nodes: RecursiveGraphNode[] = [];
  for (let index = 0; index < nodeCount; index++) {
    nodes.push(
      Object.freeze({
        id: `n${index}`,
        order: ((seed + 1) * (index + 3) * 7) % 13,
        included:
          profile === "singular-fk" ||
          closesCycle ||
          index === 0 ||
          (seed + index * 3) % 5 !== 0,
      })
    );
  }
  return Object.freeze({
    formatVersion: 1,
    caseId: `rq06:${profile}:${String(seed).padStart(3, "0")}`,
    seed,
    profile,
    relation: relationFor(profile),
    ...(singularMayBeEmpty === undefined ? {} : { singularMayBeEmpty }),
    roots: Object.freeze(seed % 4 === 0 ? ["n0", "n2"] : ["n0"]),
    nodes: Object.freeze(nodes),
    edges: generateEdges(profile, seed, nodeCount, closesCycle),
    recurse: recurrenceFor(profile, seed),
    order: seed % 2 === 0 ? "asc" : "desc",
  });
}

export function generateFixedCases(
  profile: RecursiveProfile
): readonly RecursiveGraphCase[] {
  return Object.freeze(
    Array.from({ length: RQ06_CASES_PER_PROFILE }, (_, seed) =>
      generateRecursiveCase(profile, seed)
    )
  );
}

/** Stable JSON for replay records and cross-provider corpus comparison. */
export function serializeRecursiveCase(testCase: RecursiveGraphCase): string {
  const preventCycles =
    testCase.recurse !== true && "preventCycles" in testCase.recurse
      ? testCase.recurse.preventCycles
      : undefined;
  const recurse =
    testCase.recurse === true
      ? true
      : {
          ...(testCase.recurse.depth === undefined
            ? {}
            : { depth: testCase.recurse.depth }),
          ...(preventCycles === undefined
            ? {}
            : { preventCycles }),
        };
  return JSON.stringify({
    formatVersion: testCase.formatVersion,
    caseId: testCase.caseId,
    seed: testCase.seed,
    profile: testCase.profile,
    relation: testCase.relation,
    ...(testCase.singularMayBeEmpty === undefined
      ? {}
      : { singularMayBeEmpty: testCase.singularMayBeEmpty }),
    roots: testCase.roots,
    nodes: testCase.nodes.map((node) => ({
      id: node.id,
      order: node.order,
      included: node.included,
    })),
    edges: testCase.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
    })),
    recurse,
    order: testCase.order,
  });
}

export const RQ06_FIXED_CASES: readonly RecursiveGraphCase[] = Object.freeze(
  PROFILES.flatMap((profile) => generateFixedCases(profile))
);

export interface RecursiveCorpusIdentity {
  readonly formatVersion: 1;
  readonly cases: number;
  readonly sha256: string;
}

export function recursiveCorpusIdentity(
  cases: readonly RecursiveGraphCase[]
): RecursiveCorpusIdentity {
  const serialized = cases.map(serializeRecursiveCase).join("\n");
  return Object.freeze({
    formatVersion: 1,
    cases: cases.length,
    sha256: createHash("sha256").update(serialized).digest("hex"),
  });
}

/**
 * Updated only when an independently reviewed corpus change is intentional.
 * Repair #1's rejected `489a149403b28cbf1d834e7ba8883c01ab06782bf6f48f0fed05f48ae48c097b`
 * left required singular seed 12 without a physical outgoing reference.
 * Repair #2's `fab0ccd55c6391e4693edc75ed714de624630a90eb858eb8a579b95efea76cdd`
 * still declared 34 singular cases (seed % 3 === 0) required, a schema CM002
 * refuses; the CM002 reconciliation states them nullable with the same graphs
 * and the same expected outcomes (`generateRecursiveCase`).
 */
export const RQ06_FIXED_CORPUS_IDENTITY: RecursiveCorpusIdentity = Object.freeze({
  formatVersion: 1,
  cases: 300,
  sha256: "ff708cf3e848bb47693109b3dba5486f8770ce7a9d8af9c8aed5333eaffbdfd7",
});
