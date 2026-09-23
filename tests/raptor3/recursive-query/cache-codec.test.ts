/**
 * RQ-05 — the live recursive cache codec, entered through the real route.
 *
 * The live cache path is `RoutedCandidateOperation.cacheResultCodec()`
 * (`raptor3/route/client-route.ts`): `cacheCodec` composes one value codec per
 * published shape through `shapeCodec`, from the official owners in
 * `result/cache-value-codecs.ts`. Every route cell below asks THAT codec for a
 * prepared read of an admitted recursive projection, and feeds it values the
 * real decoder published — an executed SQLite read, or synthetic provider rows
 * parsed by the same prepared read (`prepareSingle(…).parseResult`).
 *
 * What the cells pin (features-docs/recursive-query.md §3.4 and RQ-05):
 *  - a hit is deep-equal to the miss and shares no object with it, nor with
 *    another hit, at any level — a second recursive slot inside the repeated
 *    node and a junction diamond whose shared row is two objects included —
 *    and the stored snapshot is detached plain data (it survives JSON);
 *  - a caller mutating a hit's scalar, Date, bytes or JSON leaf, or the miss
 *    after it was stored, does not reach the next hit;
 *  - the numeric cutoff occurrence round-trips with the repeated key ABSENT, a
 *    natural end before it with the key PRESENT (`[]`, or `null` for a singular
 *    slot), and an exhaustive read with the key present on every occurrence;
 *  - a malformed value or snapshot is refused at its boundary: a wrong tuple
 *    width, a missing repeated key, a repeated key where it must be absent;
 *  - a cyclic value or snapshot is refused promptly by the codec's own rule
 *    (the owner cell shows the failure class: never a stack overflow);
 *  - one object reached at two places that do not nest is an alias, not a
 *    cycle: accepted and restored as separate objects (owner cell);
 *  - parsing, snapshot and materialization each hold a chain at the public
 *    depth ceiling (1,000) and an exhaustive chain far beyond it (12,000)
 *    without depending on the JavaScript call stack.
 *
 * Deep values are compared by iterative walks: `assert.deepStrictEqual` is
 * itself recursive and would measure the assertion, not the codec.
 */

import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { CacheConfigurationError } from "@errors";
import { createCandidateRoute } from "@query-engine/raptor3/route/client-route";
import { CacheSnapshotFailure } from "@query-engine/result/cache-snapshot-structure";
import {
  compileScalarCodec,
  recordCodec,
  recursiveRelationCodec,
  type ValueCodec,
} from "@query-engine/result/cache-value-codecs";
import { hydrateSchemaNames, s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { afterEach, describe, it } from "vitest";
import { seedCacheWorld } from "./cache-world";

const node = s
  .model({
    id: s.string().id(),
    label: s.string(),
    bornAt: s.dateTime(),
    meta: s.json(),
    bytes: s.blob(),
    parentId: s.string().nullable(),
    parent: s
      .toOne(() => node)
      .fields("parentId")
      .references("id")
      .name("rqCacheCodecTree"),
    children: s.toMany(() => node).name("rqCacheCodecTree"),
    links: s
      .toMany(() => node)
      .name("rqCacheCodecGraph")
      .source("fromId")
      .target("toId"),
    linkedBy: s.toMany(() => node).name("rqCacheCodecGraph"),
  })
  .map("rq_cache_codec_nodes");

const schema = { node };
hydrateSchemaNames(schema);

/** The public occurrence every read below publishes, as far as a cell asks. */
interface Occurrence {
  id: string;
  label: string;
  bornAt: Date;
  meta: { index: number; nested: { id: string } };
  bytes: Uint8Array;
  parent?: Occurrence | null;
  children?: Occurrence[];
  links?: Occurrence[];
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

const day = (value: number) => new Date(Date.UTC(2026, 0, value, 8, 30));

/**
 * r → a → a1 → a1x and r → b by foreign key; r → a, r → b, a → d, b → d and
 * d → r by junction — a diamond at d and a cycle back to the root.
 */
async function world() {
  const database = new Database(":memory:");
  const driver = new SQLite3Driver({ client: database });
  const client = createClient({ schema, driver });
  closers.push(async () => {
    await client.$disconnect();
    database.close();
  });
  const migration = await syncLiveSchema(client);
  if (!migration.applied)
    throw new Error("the recursive cache schema did not apply");
  await seedCacheWorld(client, (id, index) => ({
    bornAt: day(index + 1),
    meta: { index, nested: { id } },
    bytes: new Uint8Array([index, 255 - index]),
  }));
  const route = createCandidateRoute(schema, driver);
  return {
    /** The executed read, through the shipped client: the decoder's own value. */
    read: (
      args: Record<string, unknown>,
      operation: "findMany" | "findUnique" = "findMany"
    ): Promise<unknown> =>
      Reflect.apply(client.node[operation], client.node, [args]),
    /** The live cache codec the route composes for the same read. */
    codec: (
      args: Record<string, unknown>,
      operation: "findMany" | "findUnique" = "findMany"
    ) => route.operation(node as never, operation, args).cacheResultCodec(),
  };
}

const LEAVES = {
  id: true,
  label: true,
  bornAt: true,
  meta: true,
  bytes: true,
} as const;

/**
 * Every published form at once: scalar, Date, JSON and bytes leaves, an
 * ordinary relation and a SECOND recursive slot inside the repeated node, a
 * numeric cutoff, a natural end before it, and a default-policy junction walk
 * whose diamond publishes the shared row `d` as two objects.
 */
const RICH = {
  where: { id: "r" },
  select: {
    ...LEAVES,
    children: {
      recurse: { depth: 2 },
      orderBy: { id: "asc" },
      select: {
        ...LEAVES,
        parent: { select: { id: true } },
        links: {
          recurse: { depth: 2 },
          orderBy: { id: "asc" },
          select: { id: true },
        },
      },
    },
    links: {
      recurse: true,
      orderBy: { id: "asc" },
      select: { id: true, meta: true },
    },
  },
};

const BOUNDED = {
  where: { id: "r" },
  select: {
    id: true,
    children: {
      recurse: { depth: 2 },
      orderBy: { id: "asc" },
      select: { id: true },
    },
  },
};

const EXHAUSTIVE = {
  where: { id: "r" },
  select: {
    id: true,
    children: {
      recurse: { depth: false },
      orderBy: { id: "asc" },
      select: { id: true },
    },
  },
};

/** A property of an object-like value, or `undefined`. */
const get = (value: unknown, key: PropertyKey): unknown =>
  typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;

/** The first object `left` shares with `right` at the same place, if any. */
function sharedObject(left: unknown, right: unknown): unknown {
  const pending: (readonly [unknown, unknown])[] = [[left, right]];
  while (pending.length > 0) {
    const [a, b] = pending.pop() as readonly [unknown, unknown];
    if (typeof a !== "object" || a === null) continue;
    if (a === b) return a;
    if (a instanceof Date || a instanceof Uint8Array) continue;
    for (const key of Object.keys(a)) pending.push([get(a, key), get(b, key)]);
  }
  return;
}

/** A stored array, as a mutable one; any other layout is a fixture error. */
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error("the stored snapshot does not have the expected layout");
  }
  return value;
}

/** The value one key holds in a stored record snapshot (`[key, value][]`). */
const field = (record: unknown, key: string): unknown =>
  list(
    list(record).find(
      (entry: unknown) => Array.isArray(entry) && entry[0] === key
    )
  )[1];

/** The stored slot of the first root row's `key` (a findMany snapshot). */
const storedSlot = (stored: unknown, key: string): unknown[] =>
  list(field(list(stored)[0], key));

/** A tuple of one stored slot, by position. */
const tuple = (slot: unknown, index: number): unknown[] =>
  list(list(slot)[index]);

const SNAPSHOT_REFUSAL = "refused by snapshot of findMany";
const MATERIALIZE_REFUSAL = "refused by materialize of findMany";

/** Where one codec call ends: accepted, or refused by the named direction. */
function outcome(run: () => unknown): string {
  try {
    run();
    return "accepted";
  } catch (error) {
    return error instanceof CacheConfigurationError
      ? `refused by ${String(error.meta.method)} of ${String(error.meta.operation)}`
      : `failed with ${String(error)}`;
  }
}

/**
 * A synthetic provider row for `root → n1 → … → n<levels>`, carried the way
 * SQLite answers a recursive relation column: one JSON text document.
 */
function chainRow(levels: number, bounded: boolean): Record<string, unknown> {
  const nodes: unknown[] = [];
  const edges: unknown[] = [];
  let parent = "root";
  for (let level = 1; level <= levels; level += 1) {
    const child = `n${level}`;
    nodes.push({ __rq_key: [child], __rq_row: { id: child } });
    edges.push({
      __rq_parent: [parent],
      __rq_child: [child],
      ...(bounded ? { __rq_depth: level } : {}),
    });
    parent = child;
  }
  return {
    id: "root",
    children: JSON.stringify({
      __rq_root: ["root"],
      __rq_nodes: nodes,
      __rq_edges: edges,
    }),
  };
}

/**
 * `root → n1 → …` reduced iteratively: how many levels hold exactly the next
 * occurrence, and how the last one ends — its repeated key ABSENT (`cutoff`),
 * or PRESENT and empty (`empty`).
 */
function chainSummary(rows: unknown): {
  readonly levels: number;
  readonly end: string;
} {
  let occurrences = list(get(list(rows)[0], "children"));
  let levels = 0;
  while (
    occurrences.length === 1 &&
    get(occurrences[0], "id") === `n${levels + 1}`
  ) {
    levels += 1;
    const occurrence = occurrences[0] as object;
    if (!Object.hasOwn(occurrence, "children"))
      return { levels, end: "cutoff" };
    occurrences = list(get(occurrence, "children"));
  }
  return { levels, end: occurrences.length === 0 ? "empty" : "malformed" };
}

/**
 * Parse, snapshot and materialize one deep chain, each phase on its own, and
 * answer what each phase published and its wall time (read back through the
 * JSON reporter's `meta`). Parsing never reaches the database, so the route
 * needs no seeded world.
 */
function deepChain(levels: number, depth: number | false) {
  const database = new Database(":memory:");
  closers.push(async () => {
    database.close();
  });
  const route = createCandidateRoute(
    schema,
    new SQLite3Driver({ client: database })
  );
  const operation = route.operation(node as never, "findMany", {
    where: { id: "root" },
    select: {
      id: true,
      children: { recurse: { depth }, select: { id: true } },
    },
  });
  const codec = operation.cacheResultCodec();
  const prepared = operation.prepareSingle({
    model: "node",
    operation: "findMany",
  });
  if (!prepared) throw new Error("a recursive read prepares one statement");
  const row = chainRow(levels, depth !== false);
  // Parsing: the prepared read's own decoder over the provider rows.
  let started = performance.now();
  const parsed = prepared.parseResult([{ rows: [row], rowCount: 1 }]);
  const parse = performance.now() - started;
  // Snapshot, then materialization, each through the live route codec.
  started = performance.now();
  const stored = codec.snapshot(parsed);
  const snapshot = performance.now() - started;
  started = performance.now();
  const hit = codec.materialize(stored);
  const materialize = performance.now() - started;
  return {
    parsed: chainSummary(parsed),
    hit: chainSummary(hit),
    shared: sharedObject(parsed, hit),
    phaseMs: { parse, snapshot, materialize },
  };
}

describe("RQ-05 live recursive cache codec", () => {
  it("answers a hit deep-equal to the miss with no shared object at any level", async () => {
    const { read, codec: codecFor } = await world();
    const codec = codecFor(RICH);
    const miss = (await read(RICH)) as Occurrence[];

    // The miss is the decoder's own value: the facts the codec must keep.
    const [root] = miss;
    assert(root?.children && root.links);
    const [a, b] = root.children;
    assert(a?.children && b);
    assert.deepEqual(b.children, []);
    assert.equal(Object.hasOwn(a.children[0] ?? {}, "children"), false);
    assert.deepEqual(a.links?.[0]?.links, [{ id: "r" }]);
    const viaA = root.links[0]?.links?.[0];
    const viaB = root.links[1]?.links?.[0];
    assert.equal(viaA?.id, "d");
    assert.equal(viaB?.id, "d");
    assert.notEqual(viaA, viaB);

    const stored = codec.snapshot(miss);
    const first = codec.materialize(stored);
    const second = codec.materialize(stored);
    assert.deepStrictEqual(first, miss);
    assert.deepStrictEqual(second, miss);
    assert.equal(sharedObject(miss, first), undefined);
    assert.equal(sharedObject(first, second), undefined);
    // A repeated row in distinct objects stays two objects on every hit.
    const hit = first as Occurrence[];
    assert.notEqual(
      hit[0]?.links?.[0]?.links?.[0],
      hit[0]?.links?.[1]?.links?.[0]
    );
    // The stored form is plain detached data: a JSON backend round-trips it.
    assert.deepStrictEqual(
      codec.materialize(JSON.parse(JSON.stringify(stored))),
      miss
    );
  });

  it("keeps a caller's mutation of a hit or of the miss out of the next hit", async () => {
    const { read, codec: codecFor } = await world();
    const codec = codecFor(RICH);
    const miss = (await read(RICH)) as Occurrence[];
    const pristine = structuredClone(miss);
    const stored = codec.snapshot(miss);

    const hit = codec.materialize(stored) as Occurrence[];
    const root = hit[0];
    const child = root?.children?.[0];
    const grandchild = child?.children?.[0];
    const shared = root?.links?.[0]?.links?.[0];
    assert(root && child && grandchild && shared);
    root.label = "caller";
    root.bornAt.setTime(0);
    root.bytes[0] = 42;
    root.meta.nested.id = "caller";
    child.bornAt.setUTCFullYear(1999);
    child.bytes.fill(7);
    child.meta.index = 99;
    child.children?.push(grandchild);
    grandchild.label = "caller";
    grandchild.meta.nested.id = "caller";
    shared.meta.nested.id = "caller";
    child.links?.splice(0);
    // The miss belongs to its caller too: storing it did not capture it.
    const missChild = miss[0]?.children?.[0];
    assert(missChild);
    missChild.meta.nested.id = "miss-caller";
    missChild.bornAt.setTime(0);

    const next = codec.materialize(stored);
    assert.deepStrictEqual(next, pristine);
  });

  it("round-trips the cutoff key's absence and the natural end's presence", async () => {
    const { read, codec: codecFor } = await world();

    const bounded = await read(BOUNDED);
    const boundedExpected = [
      {
        id: "r",
        children: [
          { id: "a", children: [{ id: "a1" }] },
          { id: "b", children: [] },
        ],
      },
    ];
    assert.deepStrictEqual(bounded, boundedExpected);
    const boundedCodec = codecFor(BOUNDED);
    const boundedHit = boundedCodec.materialize(
      boundedCodec.snapshot(bounded)
    ) as Occurrence[];
    assert.deepStrictEqual(boundedHit, boundedExpected);
    const [a, b] = boundedHit[0]?.children ?? [];
    assert(a?.children && b);
    // Level 2 is the cutoff: the repeated key is absent, not empty.
    assert.equal(Object.hasOwn(a.children[0] ?? {}, "children"), false);
    // Level 1 is before it: a node with no child states the empty end.
    assert.equal(Object.hasOwn(b, "children"), true);

    const exhaustive = await read(EXHAUSTIVE);
    const exhaustiveExpected = [
      {
        id: "r",
        children: [
          {
            id: "a",
            children: [{ id: "a1", children: [{ id: "a1x", children: [] }] }],
          },
          { id: "b", children: [] },
        ],
      },
    ];
    assert.deepStrictEqual(exhaustive, exhaustiveExpected);
    const exhaustiveCodec = codecFor(EXHAUSTIVE);
    assert.deepStrictEqual(
      exhaustiveCodec.materialize(exhaustiveCodec.snapshot(exhaustive)),
      exhaustiveExpected
    );
  });

  it("round-trips a singular slot's null at the outer slot and at a natural end", async () => {
    const { read, codec: codecFor } = await world();
    const upward = (id: string, recurse: unknown) => ({
      where: { id },
      select: { id: true, parent: { recurse, select: { id: true } } },
    });
    const fromLeaf = {
      id: "a1x",
      parent: {
        id: "a1",
        parent: { id: "a", parent: { id: "r", parent: null } },
      },
    };
    const cases: readonly [Record<string, unknown>, unknown][] = [
      [upward("a1x", true), [fromLeaf]],
      [upward("r", true), [{ id: "r", parent: null }]],
      [upward("a1x", { depth: 1 }), [{ id: "a1x", parent: { id: "a1" } }]],
    ];
    for (const [args, expected] of cases) {
      const value = await read(args);
      assert.deepStrictEqual(value, expected);
      const codec = codecFor(args);
      assert.deepStrictEqual(
        codec.materialize(codec.snapshot(value)),
        expected
      );
    }

    // The same slot under a single-row verb, whose own absence is `null` too.
    const unique = upward("a1x", true);
    const one = await read(unique, "findUnique");
    assert.deepStrictEqual(one, fromLeaf);
    const uniqueCodec = codecFor(unique, "findUnique");
    assert.deepStrictEqual(
      uniqueCodec.materialize(uniqueCodec.snapshot(one)),
      one
    );
    assert.equal(uniqueCodec.materialize(uniqueCodec.snapshot(null)), null);
  });

  it("refuses a malformed value or snapshot at its own boundary", async () => {
    const { read, codec: codecFor } = await world();
    const bounded = (await read(BOUNDED)) as Occurrence[];
    const boundedCodec = codecFor(BOUNDED);
    const stored = boundedCodec.snapshot(bounded);

    // Value → snapshot: the repeated key is exact at every level.
    const missingKey = structuredClone(bounded);
    Reflect.deleteProperty(missingKey[0]?.children?.[0] ?? {}, "children");
    assert.equal(
      outcome(() => boundedCodec.snapshot(missingKey)),
      SNAPSHOT_REFUSAL
    );
    const keyPastCutoff = structuredClone(bounded);
    const cutoffNode = keyPastCutoff[0]?.children?.[0]?.children?.[0];
    assert(cutoffNode);
    cutoffNode.children = [];
    assert.equal(
      outcome(() => boundedCodec.snapshot(keyPastCutoff)),
      SNAPSHOT_REFUSAL
    );
    const unknownKey = structuredClone(bounded);
    Reflect.set(unknownKey[0]?.children?.[1] ?? {}, "extra", "x");
    assert.equal(
      outcome(() => boundedCodec.snapshot(unknownKey)),
      SNAPSHOT_REFUSAL
    );

    const exhaustive = (await read(EXHAUSTIVE)) as Occurrence[];
    const exhaustiveCodec = codecFor(EXHAUSTIVE);
    const openEnd = structuredClone(exhaustive);
    Reflect.deleteProperty(openEnd[0]?.children?.[1] ?? {}, "children");
    assert.equal(
      outcome(() => exhaustiveCodec.snapshot(openEnd)),
      SNAPSHOT_REFUSAL
    );

    // Snapshot → value: the tuple width states the level's own fact.
    const narrowed = structuredClone(stored);
    tuple(storedSlot(narrowed, "children"), 0).splice(1);
    assert.equal(
      outcome(() => boundedCodec.materialize(narrowed)),
      MATERIALIZE_REFUSAL
    );
    const widened = structuredClone(stored);
    tuple(tuple(storedSlot(widened, "children"), 0)[1], 0).push([]);
    assert.equal(
      outcome(() => boundedCodec.materialize(widened)),
      MATERIALIZE_REFUSAL
    );
    const emptied = structuredClone(stored);
    storedSlot(emptied, "children")[1] = [];
    assert.equal(
      outcome(() => boundedCodec.materialize(emptied)),
      MATERIALIZE_REFUSAL
    );
    // The repeated key cannot hide in the node's own record either.
    const smuggled = structuredClone(stored);
    const cutoffRow = tuple(
      tuple(storedSlot(smuggled, "children"), 0)[1],
      0
    )[0];
    assert(Array.isArray(cutoffRow));
    cutoffRow.push(["children", []]);
    assert.equal(
      outcome(() => boundedCodec.materialize(smuggled)),
      MATERIALIZE_REFUSAL
    );
    const notASlot = structuredClone(stored);
    tuple(storedSlot(notASlot, "children"), 1)[1] = "[]";
    assert.equal(
      outcome(() => boundedCodec.materialize(notASlot)),
      MATERIALIZE_REFUSAL
    );

    // A singular slot is one node or its permitted null, never a list.
    const upward = {
      where: { id: "a1" },
      select: { id: true, parent: { recurse: true, select: { id: true } } },
    };
    const singular = (await read(upward)) as Occurrence[];
    const singularCodec = codecFor(upward);
    const listed = structuredClone(singular);
    Reflect.set(listed[0] ?? {}, "parent", [singular[0]?.parent]);
    assert.equal(
      outcome(() => singularCodec.snapshot(listed)),
      SNAPSHOT_REFUSAL
    );
    const singularStored = singularCodec.snapshot(singular);
    const emptyNode = structuredClone(singularStored);
    assert(Array.isArray(emptyNode));
    const rootRow = emptyNode[0];
    assert(Array.isArray(rootRow));
    const parentEntry = rootRow.find(
      (entry: unknown) => Array.isArray(entry) && entry[0] === "parent"
    );
    assert(Array.isArray(parentEntry));
    parentEntry[1] = [];
    assert.equal(
      outcome(() => singularCodec.materialize(emptyNode)),
      MATERIALIZE_REFUSAL
    );
  });

  it("refuses a cyclic value or a cyclic snapshot promptly", async () => {
    const { read, codec: codecFor } = await world();
    const codec = codecFor(EXHAUSTIVE);

    // A published occurrence that contains its own ancestor.
    const cyclic = (await read(EXHAUSTIVE)) as Occurrence[];
    const ancestor = cyclic[0]?.children?.[0];
    const leaf = ancestor?.children?.[0]?.children?.[0];
    assert(ancestor && leaf);
    leaf.children = [ancestor];
    assert.equal(
      outcome(() => codec.snapshot(cyclic)),
      SNAPSHOT_REFUSAL
    );

    // A JSON leaf that holds the occurrence carrying it.
    const richCodec = codecFor(RICH);
    const rich = (await read(RICH)) as Occurrence[];
    const holder = rich[0]?.children?.[0];
    assert(holder);
    Reflect.set(holder.meta, "self", holder);
    assert.equal(
      outcome(() => richCodec.snapshot(rich)),
      SNAPSHOT_REFUSAL
    );

    // A stored tuple whose slot re-enters its own ancestor tuple.
    const stored = codec.snapshot(await read(EXHAUSTIVE));
    const loop = structuredClone(stored);
    const top = tuple(storedSlot(loop, "children"), 0);
    const bottom = tuple(tuple(top[1], 0)[1], 0);
    bottom[1] = [top];
    assert.equal(
      outcome(() => codec.materialize(loop)),
      MATERIALIZE_REFUSAL
    );
  });

  it("refuses with its own failure class, never a stack overflow (owner)", () => {
    // The route boundary redacts a refusal's cause, so the class is read at
    // the structural owner, composed exactly as `shapeCodec` composes it.
    const text = compileScalarCodec(s.string(), false);
    const row = recordCodec(new Map<string, ValueCodec>([["id", text]]));
    const many = recursiveRelationCodec(
      { relation: "children", many: true, optional: false, depth: false },
      row
    );
    const cyclic: { id: string; children: unknown[] }[] = [
      { id: "n1", children: [] },
    ];
    const first = cyclic[0];
    assert(first);
    first.children.push({ id: "n2", children: [first] });
    assert.throws(
      () => many.snapshot(cyclic, new WeakSet<object>()),
      CacheSnapshotFailure
    );
    const storedTop: unknown[] = [[["id", "n1"]]];
    storedTop.push([[[["id", "n2"]], [storedTop]]]);
    assert.throws(
      () => many.materialize([storedTop], new WeakSet<object>()),
      CacheSnapshotFailure
    );

    // A required singular slot has no null end: unreachable through an
    // admitted schema today (CM002 refuses a non-nullable self foreign key),
    // so the prepared `optional` fact is pinned here, at its consumer.
    const required = recursiveRelationCodec(
      { relation: "next", many: false, optional: false, depth: false },
      row
    );
    assert.throws(
      () => required.snapshot(null, new WeakSet<object>()),
      CacheSnapshotFailure
    );
    assert.throws(
      () => required.materialize(null, new WeakSet<object>()),
      CacheSnapshotFailure
    );
    const optional = recursiveRelationCodec(
      { relation: "next", many: false, optional: true, depth: false },
      row
    );
    assert.equal(optional.snapshot(null, new WeakSet<object>()), null);
    assert.equal(optional.materialize(null, new WeakSet<object>()), null);

    // A primitive where a slot or an occurrence belongs is the owner's own
    // refusal too — never the active set's TypeError.
    for (const input of ["x", ["x"], [null]]) {
      assert.throws(
        () => many.snapshot(input, new WeakSet<object>()),
        CacheSnapshotFailure
      );
      assert.throws(
        () => many.materialize(input, new WeakSet<object>()),
        CacheSnapshotFailure
      );
    }
    assert.throws(
      () => optional.snapshot("x", new WeakSet<object>()),
      CacheSnapshotFailure
    );
  });

  it("restores one object reached at two places as two occurrences (owner)", () => {
    // The walker leaves an occurrence once it is written — at the cutoff, or
    // when its own slot completes — as `withSnapshotObject` leaves an object:
    // one object at two places that do not nest is an alias, not a cycle.
    const text = compileScalarCodec(s.string(), false);
    const tree = recursiveRelationCodec(
      { relation: "children", many: true, optional: false, depth: 2 },
      recordCodec(new Map<string, ValueCodec>([["id", text]]))
    );
    const restore = (value: unknown): unknown =>
      tree.materialize(
        tree.snapshot(value, new WeakSet<object>()),
        new WeakSet<object>()
      );
    const x = { id: "x" };
    const y = { id: "y", children: [] };
    const t = [[["id", "x"]]];
    const aliases = [
      // One cutoff occurrence at both places of its slot.
      () => restore([{ id: "a", children: [x, x] }]),
      // One continued occurrence, twice: its slot completed in between.
      () => restore([y, y]),
      // One stored cutoff tuple at both places of its slot.
      () => tree.materialize([[[["id", "a"]], [t, t]]], new WeakSet<object>()),
    ];
    // Every alias is accepted: one outcome per alias, recorded together.
    assert.deepEqual(
      aliases.map((run) => outcome(run)),
      ["accepted", "accepted", "accepted"]
    );
    const [cutoff, continued, stored] = aliases.map((run) => run()) as {
      id: string;
      children?: object[];
    }[][];
    const twoX = [{ id: "a", children: [{ id: "x" }, { id: "x" }] }];
    assert.deepStrictEqual(cutoff, twoX);
    assert.notEqual(cutoff?.[0]?.children?.[0], cutoff?.[0]?.children?.[1]);
    assert.deepStrictEqual(continued, [
      { id: "y", children: [] },
      { id: "y", children: [] },
    ]);
    assert.notEqual(continued?.[0], continued?.[1]);
    assert.notEqual(continued?.[0]?.children, continued?.[1]?.children);
    assert.deepStrictEqual(stored, twoX);
    assert.notEqual(stored?.[0]?.children?.[0], stored?.[0]?.children?.[1]);
  });

  it("parses, stores and restores a chain at the 1,000-level depth ceiling", ({
    task,
  }) => {
    const chain = deepChain(1000, 1000);
    Object.assign(task.meta, { phaseMs: chain.phaseMs });
    // Level 1,000 is the cutoff: its repeated key is absent after each phase.
    assert.deepEqual(chain.parsed, { levels: 1000, end: "cutoff" });
    assert.deepEqual(chain.hit, { levels: 1000, end: "cutoff" });
    assert.equal(chain.shared, undefined);
  });

  it("parses, stores and restores an exhaustive chain of 12,000 levels", ({
    task,
  }) => {
    const chain = deepChain(12_000, false);
    Object.assign(task.meta, { phaseMs: chain.phaseMs });
    // Exhaustive: the key is present to the natural end, which is empty.
    assert.deepEqual(chain.parsed, { levels: 12_000, end: "empty" });
    assert.deepEqual(chain.hit, { levels: 12_000, end: "empty" });
    assert.equal(chain.shared, undefined);
  });
});
