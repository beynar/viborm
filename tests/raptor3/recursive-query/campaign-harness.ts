/**
 * RQ-06 — the provider execution harness for the saved recursive corpus.
 *
 * `fixed-cases.ts` owns WHAT is executed (100 saved cases per profile) and
 * `graph-oracle.ts` owns WHAT each case must answer; both know plain nodes and
 * edges only. This file owns HOW one saved case becomes provider rows and one
 * public operation, on every provider alike:
 *
 *  - one admitted schema (`campaignSchema`): a singular chain over the NULLABLE
 *    owning self foreign key, a child-held collection hierarchy and a paired
 *    self junction, each keyed by `(seed, id)` so a hundred cases share one
 *    table set without sharing a row, and so the published node is exactly the
 *    oracle's `{ id, order, <relation> }` (the key member `seed` is never
 *    selected: the private identity stays a compound tuple);
 *  - provider-neutral tables in the RQ provider tests' one table language
 *    (`provider-sql-fixture.ts`), and the rows one case materialises into them;
 *  - the ONE public read per case: `findMany` over the case's roots, ordered by
 *    `id`, projecting the recursive slot with the case's own `recurse`, the
 *    oracle's filter (`included`) and its numeric sibling order;
 *  - the verdict: the published value deep-strict-equal to the oracle's rows,
 *    or the decoder's attributed foreign-key-cycle refusal where the oracle
 *    fails, in exactly one provider statement carrying the recursive CTE;
 *  - a delta minimizer for every failing case and a replayable receipt stamped
 *    with Raptor 3's executed-source identity.
 *
 * Simple numeric ordering only: `order` is an integer and ties break on `id`
 * ascending, which the order owner's complete-key tie-break spells as
 * `(seed, id)` ascending; the ids are lowercase ASCII (`n0`…`n6`), so no
 * provider collation can reorder them. Collation, null placement and codec
 * breadth are separate native pins, not oracle cases.
 *
 * The CM002 reconciliation: a required singular self slot is refused by schema
 * validation, so `requireExecutable` refuses any case that still states one — an
 * oracle-only case is never counted as executed proof.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { QueryEngineError } from "@errors";
import { s } from "@schema";
import { captureRaptor3Identity } from "../../../scripts/raptor3-manifest.mjs";
import {
  type RecursiveCorpusIdentity,
  RQ06_FIXED_CASES,
  recursiveCorpusIdentity,
  serializeRecursiveCase,
} from "./fixed-cases";
import {
  evaluateRecursiveCase,
  type RecursiveGraphCase,
  type RecursiveProfile,
} from "./graph-oracle";
import {
  type ColumnSpec,
  occurrenceCount,
  type TableSpec,
} from "./provider-sql-fixture";

// ---------------------------------------------------------------------------
// The admitted schema
// ---------------------------------------------------------------------------

export const SINGULAR_TABLE = "rq06_singular_nodes";
export const COLLECTION_TABLE = "rq06_collection_nodes";
export const GRAPH_NODE_TABLE = "rq06_graph_nodes";
export const GRAPH_EDGE_TABLE = "rq06_graph_edges";

/** The one schema every provider is given; schema validation admits it. */
export const campaignSchema = (() => {
  const singularNode = s
    .model({
      seed: s.int(),
      id: s.string(),
      order: s.int().map("sort_order"),
      parentSeed: s.int().nullable().map("parent_seed"),
      parentId: s.string().nullable().map("parent_id"),
      parent: s
        .toOne(() => singularNode)
        .fields("parentSeed", "parentId")
        .references("seed", "id")
        .name("rq06Singular"),
      children: s.toMany(() => singularNode).name("rq06Singular"),
    })
    .id(["seed", "id"])
    .map(SINGULAR_TABLE);
  const collectionNode = s
    .model({
      seed: s.int(),
      id: s.string(),
      order: s.int().map("sort_order"),
      included: s.boolean(),
      parentSeed: s.int().nullable().map("parent_seed"),
      parentId: s.string().nullable().map("parent_id"),
      parent: s
        .toOne(() => collectionNode)
        .fields("parentSeed", "parentId")
        .references("seed", "id")
        .name("rq06Collection"),
      children: s.toMany(() => collectionNode).name("rq06Collection"),
    })
    .id(["seed", "id"])
    .map(COLLECTION_TABLE);
  const graphNode = s
    .model({
      seed: s.int(),
      id: s.string(),
      order: s.int().map("sort_order"),
      included: s.boolean(),
      neighbors: s
        .toMany(() => graphNode)
        .name("rq06Graph")
        .through(GRAPH_EDGE_TABLE)
        .source("from")
        .target("to"),
      neighborsOf: s.toMany(() => graphNode).name("rq06Graph"),
    })
    .id(["seed", "id"])
    .map(GRAPH_NODE_TABLE);
  return { singularNode, collectionNode, graphNode };
})();

/**
 * The singular model a REQUIRED singular case would need: the same chain with
 * a non-nullable owning reference. It exists only to witness that schema
 * validation refuses it (CM002) before any projection is prepared.
 */
export function requiredSingularSchema() {
  const singularNode = s
    .model({
      seed: s.int(),
      id: s.string(),
      order: s.int().map("sort_order"),
      parentSeed: s.int().map("parent_seed"),
      parentId: s.string().map("parent_id"),
      parent: s
        .toOne(() => singularNode)
        .fields("parentSeed", "parentId")
        .references("seed", "id")
        .name("rq06Singular"),
      children: s.toMany(() => singularNode).name("rq06Singular"),
    })
    .id(["seed", "id"])
    .map(SINGULAR_TABLE);
  return { singularNode };
}

export type CampaignModel = keyof typeof campaignSchema;

// ---------------------------------------------------------------------------
// Provider-neutral tables and the rows one case materialises
// ---------------------------------------------------------------------------

export type CampaignRow = Readonly<Record<string, unknown>>;

const nodeColumns = (included: boolean): ColumnSpec[] => [
  { name: "seed", type: "integer" },
  { name: "id", type: "text" },
  { name: "sort_order", type: "integer" },
  ...(included ? [{ name: "included", type: "boolean" } as const] : []),
];

const referenceColumns: readonly ColumnSpec[] = [
  { name: "parent_seed", type: "integer", nullable: true },
  { name: "parent_id", type: "text", nullable: true },
];

export interface ProfileWorld {
  readonly profile: RecursiveProfile;
  readonly model: CampaignModel;
  readonly relation: RecursiveGraphCase["relation"];
  /** Provider-neutral tables; a case materialises their rows under its seed. */
  readonly tables: readonly Omit<TableSpec, "rows">[];
}

export const PROFILE_WORLDS: Readonly<Record<RecursiveProfile, ProfileWorld>> =
  Object.freeze({
    "singular-fk": {
      profile: "singular-fk",
      model: "singularNode",
      relation: "parent",
      tables: [
        {
          name: SINGULAR_TABLE,
          columns: [...nodeColumns(false), ...referenceColumns],
          primaryKey: ["seed", "id"],
        },
      ],
    },
    "collection-fk": {
      profile: "collection-fk",
      model: "collectionNode",
      relation: "children",
      tables: [
        {
          name: COLLECTION_TABLE,
          columns: [...nodeColumns(true), ...referenceColumns],
          primaryKey: ["seed", "id"],
        },
      ],
    },
    junction: {
      profile: "junction",
      model: "graphNode",
      relation: "neighbors",
      tables: [
        {
          name: GRAPH_NODE_TABLE,
          columns: nodeColumns(true),
          primaryKey: ["seed", "id"],
        },
        {
          name: GRAPH_EDGE_TABLE,
          columns: [
            { name: "from_1", type: "integer" },
            { name: "from_2", type: "text" },
            { name: "to_1", type: "integer" },
            { name: "to_2", type: "text" },
          ],
          primaryKey: ["from_1", "from_2", "to_1", "to_2"],
        },
      ],
    },
  });

export const CAMPAIGN_PROFILES: readonly RecursiveProfile[] = Object.freeze([
  "singular-fk",
  "collection-fk",
  "junction",
]);

/** The saved cases of one profile, in seed order. */
export function profileCases(
  profile: RecursiveProfile
): readonly RecursiveGraphCase[] {
  return RQ06_FIXED_CASES.filter((testCase) => testCase.profile === profile);
}

/**
 * The CM002 boundary of the corpus: a case the admitted schema cannot express
 * is refused here, before it could be counted as executed proof. The other
 * refusals name what one stored reference per row and the public read's root
 * order require of a saved case.
 */
export function requireExecutable(testCase: RecursiveGraphCase): void {
  const refuse = (reason: string): never => {
    throw new Error(`${testCase.caseId}: ${reason}`);
  };
  if (
    testCase.profile === "singular-fk" &&
    testCase.singularMayBeEmpty !== true
  )
    refuse(
      "a required singular self reference is oracle-only (CM002 refuses its schema)"
    );
  const ids = new Set(testCase.nodes.map((node) => node.id));
  const outgoing = new Map<string, number>();
  const incoming = new Map<string, number>();
  for (const edge of testCase.edges) {
    if (!(ids.has(edge.from) && ids.has(edge.to))) refuse("dangling edge");
    outgoing.set(edge.from, (outgoing.get(edge.from) ?? 0) + 1);
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  }
  // One stored reference per row: the owning row's own columns.
  const references = {
    "singular-fk": outgoing,
    "collection-fk": incoming,
    junction: new Map<string, number>(),
  }[testCase.profile];
  for (const [id, count] of references)
    if (count > 1) refuse(`'${id}' has ${count} parents`);
  // The public read orders its roots by `id`; the oracle keeps them as listed.
  if ([...testCase.roots].sort().join("\0") !== testCase.roots.join("\0"))
    refuse("roots out of id order");
  for (const root of testCase.roots)
    if (!ids.has(root)) refuse(`unknown root '${root}'`);
}

/** The rows of every table of the case's profile, under the key `seed`. */
export function materialize(
  testCase: RecursiveGraphCase,
  seed: number = testCase.seed
): Readonly<Record<string, readonly CampaignRow[]>> {
  requireExecutable(testCase);
  const world = PROFILE_WORLDS[testCase.profile];
  if (testCase.profile === "junction") {
    return {
      [GRAPH_NODE_TABLE]: testCase.nodes.map((node) => ({
        seed,
        id: node.id,
        sort_order: node.order,
        included: node.included,
      })),
      [GRAPH_EDGE_TABLE]: testCase.edges.map((edge) => ({
        from_1: seed,
        from_2: edge.from,
        to_1: seed,
        to_2: edge.to,
      })),
    };
  }
  // A singular edge `from → to` is `from`'s own reference to its parent; a
  // collection edge `from → to` is the child `to` referencing its parent.
  const parentOf = new Map<string, string>();
  for (const edge of testCase.edges)
    if (testCase.profile === "singular-fk") parentOf.set(edge.from, edge.to);
    else parentOf.set(edge.to, edge.from);
  const included = testCase.profile === "collection-fk";
  return {
    [world.tables[0]!.name]: testCase.nodes.map((node) => {
      const parent = parentOf.get(node.id);
      return {
        seed,
        id: node.id,
        sort_order: node.order,
        ...(included ? { included: node.included } : {}),
        parent_seed: parent === undefined ? null : seed,
        parent_id: parent ?? null,
      };
    }),
  };
}

/** Every case's rows, concatenated per table (one provider world per profile). */
export function materializeAll(
  cases: readonly RecursiveGraphCase[]
): Record<string, CampaignRow[]> {
  const rows: Record<string, CampaignRow[]> = {};
  for (const testCase of cases)
    for (const [table, tableRows] of Object.entries(materialize(testCase))) {
      rows[table] ??= [];
      rows[table].push(...tableRows);
    }
  return rows;
}

/** The ONE public read of a case. */
export function publicArgs(
  testCase: RecursiveGraphCase,
  seed: number = testCase.seed
): Record<string, unknown> {
  const node = { id: true, order: true };
  const slot =
    testCase.profile === "singular-fk"
      ? { recurse: testCase.recurse, select: node }
      : {
          recurse: testCase.recurse,
          where: { included: true },
          orderBy: { order: testCase.order },
          select: node,
        };
  return {
    where: { seed, id: { in: [...testCase.roots] } },
    orderBy: { id: "asc" },
    select: { ...node, [testCase.relation]: slot },
  };
}

/**
 * `client[model].findMany(args)` on the shipped client, whose static surface
 * the campaign does not need: the arguments vary per saved case.
 */
export function findManyOn(
  client: object,
  model: CampaignModel,
  args: Record<string, unknown>
): PromiseLike<unknown> {
  const delegate: unknown = Reflect.get(client, model);
  const findMany: unknown =
    (typeof delegate === "object" && delegate !== null) ||
    typeof delegate === "function"
      ? Reflect.get(delegate, "findMany")
      : undefined;
  if (typeof findMany !== "function")
    throw new TypeError(`The client has no '${model}.findMany'.`);
  return Reflect.apply(findMany, delegate, [args]);
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

export type CaseObservation =
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "failure"; readonly failure: unknown };

/** Run one public operation, keeping its value or its failure. */
export async function observeOperation(
  run: () => PromiseLike<unknown>
): Promise<CaseObservation> {
  try {
    return { kind: "value", value: await run() };
  } catch (failure) {
    return { kind: "failure", failure };
  }
}

export interface CaseVerdict {
  readonly caseId: string;
  readonly seed: number;
  readonly profile: RecursiveProfile;
  readonly expected: "rows" | "fk-cycle";
  /** `rows`, `fk-cycle`, or `failure:<class>` for anything else. */
  readonly outcome: string;
  /**
   * Public occurrences under the roots' recursive slots, counted iteratively —
   * on a value that matched the oracle; a mismatch carries none.
   */
  readonly occurrences?: number;
  /** SHA-256 of the published value's canonical JSON: equal across providers. */
  readonly digest?: string;
  readonly statements: number;
  readonly recursiveStatements: number;
  readonly match: boolean;
  readonly mismatch?: string;
  readonly owner?: string;
}

const RECURSIVE_CTE = /WITH RECURSIVE/;

const cycleSentence = (relation: string) =>
  `Recursive relation '${relation}' contains a cycle.`;

/** Code-unit order: the order every provider gives these ASCII ids. */
function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Canonical JSON (sorted keys) of a small finite published value. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, member: unknown) => {
    if (member === null || typeof member !== "object" || Array.isArray(member))
      return member;
    return Object.fromEntries(
      Object.entries(member as Record<string, unknown>).sort(
        ([left], [right]) => compareText(left, right)
      )
    );
  });
}

const digestOf = (value: unknown): string =>
  createHash("sha256").update(canonical(value)).digest("hex");

/** Occurrences below the roots: the fixture's iterative count, per root. */
function occurrencesOf(value: unknown, relation: string): number {
  const countOf = occurrenceCount(relation);
  let count = 0;
  for (const row of Array.isArray(value) ? value : [])
    count += countOf(row).occurrences;
  return count;
}

/**
 * The first path at which two finite values differ, found iteratively. It
 * walks enumerable string keys only, so it NAMES a difference for the
 * diagnostic; `isDeepStrictEqual` alone decides whether there is one.
 */
export function firstDifference(
  expected: unknown,
  actual: unknown
): string | undefined {
  const pending: [string, unknown, unknown][] = [["$", expected, actual]];
  while (pending.length > 0) {
    const [path, left, right] = pending.shift()!;
    if (isDeepStrictEqual(left, right)) continue;
    const bothObjects =
      left !== null &&
      right !== null &&
      typeof left === "object" &&
      typeof right === "object" &&
      Array.isArray(left) === Array.isArray(right);
    if (!bothObjects)
      return `${path}: expected ${canonical(left)}, published ${canonical(right)}`;
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const keys = new Set([
      ...Object.keys(leftRecord),
      ...Object.keys(rightRecord),
    ]);
    for (const key of keys) {
      if (!(Object.hasOwn(leftRecord, key) && Object.hasOwn(rightRecord, key)))
        return `${path}.${key}: ${
          Object.hasOwn(leftRecord, key) ? "missing" : "unexpected"
        } in the published value`;
      pending.push([`${path}.${key}`, leftRecord[key], rightRecord[key]]);
    }
    if (Object.getPrototypeOf(left) !== Object.getPrototypeOf(right))
      return `${path}: prototypes differ`;
  }
  return undefined;
}

/** Siblings equal as multisets at every level: only their ORDER differs. */
function orderOnly(expected: unknown, actual: unknown): boolean {
  // A difference canonical JSON cannot see (an undefined-valued or symbol key,
  // a prototype, Map/Set contents) is not a sibling-order difference.
  if (canonical(expected) === canonical(actual)) return false;
  const sortedCopy = (value: unknown): unknown =>
    JSON.parse(canonical(value), (_key, member: unknown) =>
      Array.isArray(member)
        ? [...member].sort((left, right) =>
            compareText(canonical(left), canonical(right))
          )
        : member
    );
  return isDeepStrictEqual(sortedCopy(expected), sortedCopy(actual));
}

function describeFailure(failure: unknown): string {
  if (failure instanceof Error) return `${failure.name}: ${failure.message}`;
  return String(failure);
}

interface OutcomeVerdict {
  readonly expected: "rows" | "fk-cycle";
  readonly outcome: string;
  readonly published: Pick<CaseVerdict, "occurrences" | "digest">;
  readonly mismatch?: string;
  readonly owner?: string;
}

/** The value half of a verdict: what the public operation answered. */
export function judgeOutcome(
  testCase: RecursiveGraphCase,
  observed: CaseObservation
): OutcomeVerdict {
  const oracle = evaluateRecursiveCase(testCase);
  if (oracle.kind === "error" && oracle.error.kind !== "fk-cycle")
    throw new Error(
      `${testCase.caseId}: the oracle answered an oracle-only outcome`
    );
  const expected = oracle.kind === "rows" ? "rows" : "fk-cycle";
  if (observed.kind === "value") {
    // The occurrence count walks the value as public occurrences, so it is
    // taken only once the value IS the oracle's rows: a malformed published
    // value stays a mismatch verdict with its owner, never an exception out
    // of the judge (or out of minimization, which judges every candidate).
    const published = { digest: digestOf(observed.value) };
    if (oracle.kind !== "rows")
      return {
        expected,
        outcome: "rows",
        published,
        mismatch: `expected ${cycleSentence(testCase.relation)}, published rows`,
        owner:
          "foreign-key cycle admission: Queries.decodeRecursiveCarrier (raptor3/shared/query.ts)",
      };
    if (isDeepStrictEqual(oracle.rows, observed.value))
      return {
        expected,
        outcome: "rows",
        published: {
          occurrences: occurrencesOf(observed.value, testCase.relation),
          ...published,
        },
      };
    return {
      expected,
      outcome: "rows",
      published,
      mismatch:
        firstDifference(oracle.rows, observed.value) ??
        "$: differs outside enumerable string keys (symbol keys, Date/Map contents or prototypes)",
      owner: orderOnly(oracle.rows, observed.value)
        ? "sibling order: Queries.completeOrder / lowerOrder (raptor3/shared/query.ts)"
        : "recursive lowering or carrier decoding (raptor3/shared/query.ts)",
    };
  }
  const failure = observed.failure;
  const isCycle =
    failure instanceof QueryEngineError &&
    failure.message === cycleSentence(testCase.relation);
  const outcome = isCycle
    ? "fk-cycle"
    : `failure:${failure instanceof Error ? failure.name : typeof failure}`;
  if (isCycle && oracle.kind === "error")
    return { expected, outcome, published: {} };
  return {
    expected,
    outcome,
    published: {},
    mismatch: `expected ${
      oracle.kind === "rows" ? "rows" : "the foreign-key cycle refusal"
    }, failed with ${describeFailure(failure)}`,
    owner:
      failure instanceof QueryEngineError
        ? "recursive carrier decoding: Queries.decodeRecursiveCarrier (raptor3/shared/query.ts)"
        : "provider SQL spelling of the recursive projection (adapter) or the provider itself",
  };
}

/**
 * Judge one executed case against the independent oracle. `statements` are the
 * SQL texts the provider received for this case's public read.
 */
export function judgeCase(
  testCase: RecursiveGraphCase,
  observed: CaseObservation,
  statements: readonly string[]
): CaseVerdict {
  const judged = judgeOutcome(testCase, observed);
  const recursiveStatements = statements.filter((sql) =>
    RECURSIVE_CTE.test(sql)
  ).length;
  let { mismatch, owner } = judged;
  if (
    mismatch === undefined &&
    (statements.length !== 1 || recursiveStatements !== 1)
  ) {
    mismatch = `expected ONE provider statement carrying the recursive CTE, observed ${statements.length} (${recursiveStatements} recursive)`;
    owner =
      "one projected read per operation: Queries.lowerRecursiveRelationProjection (raptor3/shared/query.ts)";
  }
  return {
    caseId: testCase.caseId,
    seed: testCase.seed,
    profile: testCase.profile,
    expected: judged.expected,
    outcome: judged.outcome,
    ...judged.published,
    statements: statements.length,
    recursiveStatements,
    match: mismatch === undefined,
    ...(mismatch === undefined ? {} : { mismatch, owner }),
  };
}

// ---------------------------------------------------------------------------
// Minimization
// ---------------------------------------------------------------------------

function withoutNode(
  testCase: RecursiveGraphCase,
  id: string
): RecursiveGraphCase {
  return {
    ...testCase,
    roots: testCase.roots.filter((root) => root !== id),
    nodes: testCase.nodes.filter((node) => node.id !== id),
    edges: testCase.edges.filter((edge) => edge.from !== id && edge.to !== id),
  };
}

/**
 * The smallest failing graph reachable by deleting one node (with its edges),
 * one extra root or one edge at a time, until no single deletion still fails.
 * `stillFails` executes a candidate on the provider that failed.
 */
export async function minimizeFailingCase(
  testCase: RecursiveGraphCase,
  stillFails: (candidate: RecursiveGraphCase) => Promise<boolean>
): Promise<RecursiveGraphCase> {
  let current = testCase;
  for (;;) {
    const candidates: RecursiveGraphCase[] = [];
    for (const node of current.nodes)
      if (!current.roots.includes(node.id) || current.roots.length > 1)
        candidates.push(withoutNode(current, node.id));
    if (current.roots.length > 1)
      for (const root of current.roots)
        candidates.push({
          ...current,
          roots: current.roots.filter((entry) => entry !== root),
        });
    for (const edge of current.edges)
      candidates.push({
        ...current,
        edges: current.edges.filter((entry) => entry !== edge),
      });
    let reduced: RecursiveGraphCase | undefined;
    for (const candidate of candidates)
      if (await stillFails(candidate)) {
        reduced = candidate;
        break;
      }
    if (!reduced) return current;
    current = reduced;
  }
}

export interface MinimizedFailure {
  readonly caseId: string;
  /** The smallest still-failing graph, serialized like the corpus. */
  readonly minimized: string;
  readonly verdict: CaseVerdict;
}

function minimizedFailure(
  original: RecursiveGraphCase,
  minimized: RecursiveGraphCase,
  verdict: CaseVerdict
): MinimizedFailure {
  return {
    caseId: original.caseId,
    minimized: serializeRecursiveCase(minimized),
    verdict,
  };
}

/** The world a runner minimizes in: its insert, statements and public read. */
export interface MinimizationWorld {
  /** Raw rows of one candidate, under a fresh seed key. */
  insert(candidate: RecursiveGraphCase, seed: number): unknown;
  /** Every statement the provider has received so far, in order. */
  statements(): readonly string[];
  readonly client: object;
  readonly model: CampaignModel;
}

/**
 * Minimize every failing seed of one profile inside the world it ran in. Each
 * candidate is inserted under a fresh seed key from 100,000 up — beyond every
 * corpus seed, so it shares no row with a saved case — and still fails when
 * the one public read's verdict does not match.
 */
export async function minimizeFailures(
  cases: readonly RecursiveGraphCase[],
  verdicts: readonly CaseVerdict[],
  world: MinimizationWorld
): Promise<MinimizedFailure[]> {
  const minimized: MinimizedFailure[] = [];
  let key = 100_000;
  for (const [index, verdict] of verdicts.entries()) {
    if (verdict.match) continue;
    const testCase = cases[index]!;
    const small = await minimizeFailingCase(testCase, async (candidate) => {
      key += 1;
      await world.insert(candidate, key);
      const start = world.statements().length;
      const observed = await observeOperation(() =>
        findManyOn(world.client, world.model, publicArgs(candidate, key))
      );
      return !judgeCase(candidate, observed, world.statements().slice(start))
        .match;
    });
    minimized.push(minimizedFailure(testCase, small, verdict));
  }
  return minimized;
}

// ---------------------------------------------------------------------------
// Replayable receipts
// ---------------------------------------------------------------------------

export interface CampaignReceipt {
  readonly formatVersion: 2;
  readonly unit: "rq6";
  readonly provider: string;
  readonly corpus: RecursiveCorpusIdentity;
  /** Raptor 3's executed-source identity (`captureRaptor3Identity`). */
  readonly identity: Readonly<Record<string, unknown>>;
  /** The lane's own provider facts: its driver and server versions. */
  readonly providerFacts: Readonly<Record<string, string>>;
  /** How the executions were grouped into cells and invocations. */
  readonly chunking: string;
  readonly totals: {
    readonly executed: number;
    readonly matched: number;
    readonly failed: number;
    readonly statements: number;
  };
  readonly cases: readonly CaseVerdict[];
  readonly minimized: readonly MinimizedFailure[];
}

/**
 * How one invocation grouped its executions, read from the verdicts it holds:
 * a `-t`-filtered chunk names exactly the profiles it executed and their case
 * counts, so its receipt never describes a run it was not.
 */
function chunkingOf(
  invocation: string,
  verdicts: readonly CaseVerdict[]
): string {
  const executed = CAMPAIGN_PROFILES.flatMap((profile) => {
    const count = verdicts.filter(
      (verdict) => verdict.profile === profile
    ).length;
    return count === 0 ? [] : [`${profile} (${count} cases)`];
  });
  return `${invocation}; executed ${executed.join(", ")}`;
}

function campaignReceipt(
  provider: string,
  values: Pick<
    CampaignReceipt,
    "identity" | "providerFacts" | "chunking" | "minimized"
  >,
  cases: readonly CaseVerdict[]
): CampaignReceipt {
  const ordered = [...cases].sort((left, right) =>
    compareText(left.caseId, right.caseId)
  );
  return {
    formatVersion: 2,
    unit: "rq6",
    provider,
    corpus: recursiveCorpusIdentity(RQ06_FIXED_CASES),
    ...values,
    totals: {
      executed: ordered.length,
      matched: ordered.filter((verdict) => verdict.match).length,
      failed: ordered.filter((verdict) => !verdict.match).length,
      statements: ordered.reduce((sum, verdict) => sum + verdict.statements, 0),
    },
    cases: ordered,
  };
}

/**
 * One runner's receipt, written where `VIBORM_RAPTOR3_EVIDENCE_DIRECTORY`
 * points as `rq6-campaign-<provider>.json`: the verdicts and minimized
 * failures it holds, stamped with Raptor 3's executed-source identity and the
 * lane's provider facts. A run that names no directory, or executed no case,
 * writes nothing.
 */
export function recordCampaignReceipt(
  provider: string,
  providerFacts: Readonly<Record<string, string>>,
  invocation: string,
  verdicts: readonly CaseVerdict[],
  minimized: readonly MinimizedFailure[]
): string | undefined {
  const directory = process.env.VIBORM_RAPTOR3_EVIDENCE_DIRECTORY;
  if (!directory || verdicts.length === 0) return undefined;
  const receipt = campaignReceipt(
    provider,
    {
      identity: captureRaptor3Identity(),
      providerFacts,
      chunking: chunkingOf(invocation, verdicts),
      minimized,
    },
    verdicts
  );
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `rq6-campaign-${receipt.provider}.json`);
  writeFileSync(path, `${JSON.stringify(receipt, undefined, 1)}\n`);
  return path;
}

/** The failure report a cell raises: every failing seed, minimized, with its owner. */
export function failureReport(
  verdicts: readonly CaseVerdict[],
  minimized: readonly MinimizedFailure[]
): string {
  const lines = verdicts
    .filter((verdict) => !verdict.match)
    .map((verdict) => {
      const small = minimized.find((entry) => entry.caseId === verdict.caseId);
      return `${verdict.caseId}: ${verdict.mismatch} — owner: ${verdict.owner}${
        small ? `\n  minimized: ${small.minimized}` : ""
      }`;
    });
  return lines.join("\n");
}
