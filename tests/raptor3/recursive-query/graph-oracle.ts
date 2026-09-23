/**
 * Independent expected-value traversal for the public recursive-query contract.
 *
 * This module knows plain nodes, directed edges and normalized public options.
 * It deliberately imports no schema, membership, query, SQL or decoder owner.
 */

export type RecursiveProfile = "singular-fk" | "collection-fk" | "junction";

export type ForeignKeyRecurseInput =
  | true
  | {
      readonly depth?: number | false;
    };

export type GraphRecurseInput =
  | true
  | {
      readonly depth?: number;
      readonly preventCycles?: boolean;
    }
  | {
      readonly depth: false;
      readonly preventCycles?: true;
    };

export type RecurseInput = ForeignKeyRecurseInput | GraphRecurseInput;

export interface RecursiveGraphNode {
  readonly id: string;
  readonly order: number;
  /** A false target is filtered out together with its branch. */
  readonly included: boolean;
}

export interface RecursiveGraphEdge {
  readonly from: string;
  readonly to: string;
}

export interface RecursiveGraphCase {
  readonly formatVersion: 1;
  readonly caseId: string;
  readonly seed: number;
  readonly profile: RecursiveProfile;
  readonly relation: "parent" | "children" | "neighbors";
  /**
   * Present only for the singular profile; false means null is an error.
   * ORACLE-ONLY when false: schema validation refuses a required ordinary self
   * foreign key (CM002, "Circular required relations"), so no admitted provider
   * schema can execute such a case. Every fixed case states `true`.
   */
  readonly singularMayBeEmpty?: boolean;
  readonly roots: readonly string[];
  readonly nodes: readonly RecursiveGraphNode[];
  readonly edges: readonly RecursiveGraphEdge[];
  readonly recurse: RecurseInput;
  readonly order: "asc" | "desc";
}

export interface RecursivePublicNode {
  readonly id: string;
  readonly order: number;
  readonly parent?: RecursivePublicNode | null;
  readonly children?: readonly RecursivePublicNode[];
  readonly neighbors?: readonly RecursivePublicNode[];
}

export type RecursiveOracleOutcome =
  | { readonly kind: "rows"; readonly rows: readonly RecursivePublicNode[] }
  | {
      readonly kind: "error";
      readonly error:
        | {
            readonly kind: "fk-cycle";
            readonly relation: "parent" | "children";
            readonly path: readonly string[];
          }
        | {
            /** Oracle-only: unreachable through an admitted schema (CM002). */
            readonly kind: "required-singular-missing";
            readonly relation: "parent";
            readonly source: string;
          };
    };

interface NormalizedRecurrence {
  readonly depth: number | false;
  readonly preventCycles: boolean;
}

class ForeignKeyCycle extends Error {
  constructor(
    readonly relation: "parent" | "children",
    readonly path: readonly string[]
  ) {
    super(`Foreign-key cycle through '${relation}'`);
  }
}

class RequiredSingularMissing extends Error {
  constructor(readonly source: string) {
    super(`Required singular target missing from '${source}'`);
  }
}

function normalizeRecurrence(testCase: RecursiveGraphCase): NormalizedRecurrence {
  if (testCase.recurse === true)
    return { depth: 100, preventCycles: testCase.profile === "junction" };
  return {
    depth: testCase.recurse.depth ?? 100,
    preventCycles:
      testCase.profile === "junction"
        ? ("preventCycles" in testCase.recurse
            ? (testCase.recurse.preventCycles ?? true)
            : true)
        : false,
  };
}

function compareNodes(
  direction: "asc" | "desc",
  left: RecursiveGraphNode,
  right: RecursiveGraphNode
): number {
  const ordered = left.order - right.order;
  if (ordered !== 0) return direction === "asc" ? ordered : -ordered;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

/** Pure expected result for one provider-neutral fixed case. */
export function evaluateRecursiveCase(
  testCase: RecursiveGraphCase
): RecursiveOracleOutcome {
  const recurrence = normalizeRecurrence(testCase);
  const nodes = new Map<string, RecursiveGraphNode>();
  const outgoing = new Map<string, RecursiveGraphNode[]>();

  if (
    testCase.profile === "singular-fk" &&
    typeof testCase.singularMayBeEmpty !== "boolean"
  ) {
    throw new Error("A singular oracle case must state whether it may be empty");
  }

  for (const node of testCase.nodes) {
    if (nodes.has(node.id)) throw new Error(`Duplicate oracle node '${node.id}'`);
    nodes.set(node.id, node);
    outgoing.set(node.id, []);
  }
  for (const edge of testCase.edges) {
    const target = nodes.get(edge.to);
    const successors = outgoing.get(edge.from);
    if (!target || !successors)
      throw new Error(`Dangling oracle edge '${edge.from}' -> '${edge.to}'`);
    successors.push(target);
  }
  if (testCase.profile === "singular-fk") {
    for (const [source, successors] of outgoing) {
      if (successors.length > 1)
        throw new Error(`Singular oracle node '${source}' has multiple targets`);
    }
  }
  for (const successors of outgoing.values())
    successors.sort((left, right) => compareNodes(testCase.order, left, right));

  const occurrence = (
    node: RecursiveGraphNode,
    level: number,
    activePath: readonly string[]
  ): RecursivePublicNode => {
    const base = { id: node.id, order: node.order };
    if (recurrence.depth !== false && level >= recurrence.depth) return base;

    const successors = outgoing.get(node.id) ?? [];
    const admitted =
      testCase.profile === "singular-fk"
        ? successors
        : successors.filter((target) => target.included);
    const descend = (target: RecursiveGraphNode): RecursivePublicNode | undefined => {
      if (activePath.includes(target.id)) {
        if (testCase.profile !== "junction") {
          const relation =
            testCase.profile === "singular-fk" ? "parent" : "children";
          throw new ForeignKeyCycle(relation, [...activePath, target.id]);
        }
        if (recurrence.preventCycles) return undefined;
      }
      return occurrence(target, level + 1, [...activePath, target.id]);
    };

    if (testCase.profile === "singular-fk") {
      const target = admitted[0];
      if (!target) {
        if (testCase.singularMayBeEmpty) return { ...base, parent: null };
        throw new RequiredSingularMissing(node.id);
      }
      return { ...base, parent: descend(target) ?? null };
    }

    const related: RecursivePublicNode[] = [];
    for (const target of admitted) {
      const child = descend(target);
      if (child) related.push(child);
    }
    return testCase.profile === "collection-fk"
      ? { ...base, children: related }
      : { ...base, neighbors: related };
  };

  try {
    const rows = testCase.roots.map((root) => {
      const node = nodes.get(root);
      if (!node) throw new Error(`Unknown oracle root '${root}'`);
      return occurrence(node, 0, [root]);
    });
    return { kind: "rows", rows };
  } catch (failure) {
    if (failure instanceof ForeignKeyCycle)
      return {
        kind: "error",
        error: {
          kind: "fk-cycle",
          relation: failure.relation,
          path: failure.path,
        },
      };
    if (failure instanceof RequiredSingularMissing)
      return {
        kind: "error",
        error: {
          kind: "required-singular-missing",
          relation: "parent",
          source: failure.source,
        },
      };
    throw failure;
  }
}
