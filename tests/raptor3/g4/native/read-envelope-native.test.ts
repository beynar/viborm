/**
 * G4 native read envelope — PostgreSQL and MySQL.
 *
 * Registered as `g4-read-envelope-pg-contracts` / `g4-read-envelope-mysql-contracts`.
 * The task-owned containers answer as of the G4 environment table; every run
 * records the loopback port and container it used under
 * `g4/witness/receipts/followup/`. Nothing here is reported as passed on a run
 * that did not happen.
 *
 * The first native run failed on FIXTURE defects, not on either engine: the
 * live harness built its own `pg.Pool`/mysql2 pool and so bypassed the
 * driver's own pool configuration, and the MySQL seed wrote an ISO-`Z`
 * literal into `DATETIME(3)`. Both are repaired at their owners —
 * `tests/raptor3/transitions/live-world.ts` now borrows the pool the driver
 * builds, and `nativeDateTime` below spells the datetime the adapter's way.
 *
 * EXACTLY what the four cells assert, and nothing more:
 *
 * 1. `g4-native-scalar-codec-round-trip` — the codecs whose physical spelling
 *    is genuinely provider-specific, each seeded as a real native value and
 *    each PROJECTED: bigInt (`BIGINT`), decimal (`DECIMAL(12,3)`), dateTime
 *    (`TIMESTAMPTZ`/`DATETIME(3)`), date (`DATE`), time (`TIME`), enum, JSON
 *    (`JSONB`/`JSON`) and blob (`BYTEA`/`VARBINARY`).
 * 2. `g4-native-string-mode-and-nulls-ordering` — `mode` collation (Q-W04) and
 *    `{ sort, nulls }` (Q-O01).
 * 3. `g4-native-cursor-pagination-and-aggregate-shapes` — cursor windows
 *    forwards and backwards (Q-P01) and the `groupBy` `_count`/`_min`/`_max`
 *    shapes (Q-S02, Q-A01).
 * 4. `g4-native-recursive-read-fit` — a recursive read (RF-16) lowered to ONE
 *    native statement over a mapped compound identity path, entered through
 *    the candidate engine's ordinary `findMany` with `recurse` on the
 *    `children` node, exactly as `tests/raptor3/g4/read-recursive-fit.test.ts`
 *    reads it on SQLite. (It once entered the retired private
 *    `Queries.recursive` fit through `OperationContext`; that slice is gone,
 *    features-docs/recursive-query.md §3.6.)
 *
 * NOT covered here, and why: scalar LISTS (SL-01…SL-10) have no cross-provider
 * column type — PostgreSQL has arrays and MySQL has none, so a shared fixture
 * cannot carry one; GeoPoint's metre tier (SC-14, Q-O02) needs PostGIS and
 * vector (SC-13) needs pgvector, neither of which the recorded environment's
 * containers provide. Those rows keep their SQLite refusal-parity witnesses in
 * `read-codecs.test.ts` and their positive tiers stay unwitnessed; `note.md`
 * §12 says so in the same words.
 */
import assert from "node:assert/strict";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { Decimal } from "@src/index";
import { canonicalizeDecimal } from "@validation/primitives/decimal-codec";
import { describe, it } from "vitest";
import type { CandidateEngineFactory } from "../../harness/protocol";
import {
  liveProvider,
  runLiveWorld,
  type LiveFixture,
} from "../../transitions/live-world";

type World = Awaited<ReturnType<typeof runLiveWorld>>;

const textType = liveProvider === "pg" ? "TEXT" : "VARCHAR(191)";
const timestampType =
  liveProvider === "pg" ? "TIMESTAMPTZ" : "DATETIME(3)";
const jsonType = liveProvider === "pg" ? "JSONB" : "JSON";
const blobType = liveProvider === "pg" ? "BYTEA" : "VARBINARY(255)";
const bigIntType = "BIGINT";

/**
 * The physical datetime spelling the PRODUCT sends to this provider.
 *
 * The fixture owns its raw seed SQL, so it must spell a datetime the way the
 * adapter does or it is testing its own literal rather than the column. MySQL
 * `DATETIME(3)` rejects ISO-8601's `Z` ("Incorrect datetime value"), which is
 * why `src/adapters/databases/mysql/mysql-adapter.ts` (`toMySqlDateTime`)
 * stores naive UTC wall-clock `YYYY-MM-DD HH:MM:SS.mmm`; PostgreSQL
 * `TIMESTAMPTZ` takes the ISO string unchanged.
 *
 * `toMySqlDateTime` is not exported, so this is the rule DUPLICATED, not the
 * rule applied — and a duplicate the adapter could silently outgrow, leaving
 * the fixture seeding a literal the product never sends. That is why the two
 * arms are named and `g4-native-datetime-literal-matches-the-adapter` below
 * pins each of them against `adapter.literals.dateTime`, which is the one
 * authority. The pin needs no provider; it runs in both native modes.
 */
const pgDateTime = (iso: string): string => iso;
const mysqlDateTime = (iso: string): string =>
  new Date(iso).toISOString().slice(0, 23).replace("T", " ");
function nativeDateTime(iso: string): string {
  return liveProvider === "pg" ? pgDateTime(iso) : mysqlDateTime(iso);
}

const SPECIMEN_TABLE = "g4_native_specimens";
const NODE_TABLE = "g4_native_nodes";

function throwTerminalFailure(world: World): void {
  if (world.terminalFailure !== undefined) throw world.terminalFailure;
}

function specimenSchema() {
  const specimen = s
    .model({
      id: s.int().id(),
      label: s.string().map("label_value"),
      count: s.int().nullable().map("count_value"),
      big: s.bigInt().map("big_value"),
      amount: s.decimal({ precision: 12, scale: 3 }).map("amount_value"),
      moment: s.dateTime().map("moment_value"),
      day: s.date().map("day_value"),
      clock: s.time().map("clock_value"),
      status: s.enum(["ACTIVE", "PAUSED", "DONE"]).map("status_value"),
      document: s.json().nullable().map("document_value"),
      payload: s.blob().map("payload_value"),
    })
    .map(SPECIMEN_TABLE);
  return { specimen };
}

function specimenTable(names: { quote(identifier: string): string }): string {
  return [
    `${names.quote("id")} INTEGER NOT NULL`,
    `${names.quote("label_value")} ${textType} NOT NULL`,
    `${names.quote("count_value")} INTEGER`,
    `${names.quote("big_value")} ${bigIntType} NOT NULL`,
    `${names.quote("amount_value")} DECIMAL(12,3) NOT NULL`,
    `${names.quote("moment_value")} ${timestampType} NOT NULL`,
    `${names.quote("day_value")} DATE NOT NULL`,
    `${names.quote("clock_value")} TIME NOT NULL`,
    `${names.quote("status_value")} ${textType} NOT NULL`,
    `${names.quote("document_value")} ${jsonType}`,
    `${names.quote("payload_value")} ${blobType} NOT NULL`,
    `PRIMARY KEY(${names.quote("id")})`,
  ].join(",");
}

/**
 * `payload_value` is declared NOT NULL and `document_value` carries a real
 * document: the live harness inserts every key present on a row, so a `null`
 * here would be sent explicitly and rejected by PostgreSQL and by MySQL in
 * strict mode before a single read ran. Bytes go over as a Buffer (BYTEA and
 * VARBINARY both take one) and the document as a JSON text both providers
 * parse into their own column type.
 */
const ALPHA_BYTES = Uint8Array.from([0x00, 0x01, 0xfe, 0xff, 0x7f]);
const BETA_BYTES = Uint8Array.from([0xde, 0xad, 0xbe, 0xef]);
const GAMMA_BYTES = Uint8Array.from([0x00]);
const ALPHA_DOCUMENT = { tier: "gold", size: 3, tags: ["a", "b"] };

const SPECIMEN_ROWS = [
  {
    id: 1,
    label_value: "Alpha",
    count_value: 10,
    big_value: "9007199254740993",
    amount_value: "123456.001",
    moment_value: nativeDateTime("2024-01-15T10:30:00.123Z"),
    day_value: "2024-01-15",
    clock_value: "10:30:00",
    status_value: "ACTIVE",
    document_value: JSON.stringify(ALPHA_DOCUMENT),
    payload_value: Buffer.from(ALPHA_BYTES),
  },
  {
    id: 2,
    label_value: "beta",
    count_value: null,
    big_value: "-9007199254740993",
    amount_value: "-0.001",
    moment_value: nativeDateTime("1970-01-01T00:00:00.000Z"),
    day_value: "1970-01-01",
    clock_value: "00:00:00",
    status_value: "PAUSED",
    document_value: null,
    payload_value: Buffer.from(BETA_BYTES),
  },
  {
    id: 3,
    label_value: "GAMMA",
    count_value: 30,
    big_value: "0",
    amount_value: "0.000",
    moment_value: nativeDateTime("2030-12-31T23:59:59.000Z"),
    day_value: "2030-12-31",
    clock_value: "23:59:59",
    status_value: "DONE",
    document_value: null,
    payload_value: Buffer.from(GAMMA_BYTES),
  },
] as const;

function assertBytes(
  actual: unknown,
  expected: Uint8Array,
  label: string
): void {
  assert.ok(actual instanceof Uint8Array, `${label} is not a Uint8Array`);
  assert.equal(
    actual.constructor,
    Uint8Array,
    `${label} is not exactly Uint8Array`
  );
  assert.deepEqual([...actual], [...expected], label);
}

function rows(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value), "the public result is not an array");
  const list: Record<string, unknown>[] = [];
  for (const row of value) {
    assert.ok(row !== null && typeof row === "object");
    list.push(row as Record<string, unknown>);
  }
  return list;
}

async function runCodecRoundTrip(factory: CandidateEngineFactory) {
  const schema = specimenSchema();
  const fixture: LiveFixture = {
    expectedExecutions: 1,
    initial: { specimens: [...SPECIMEN_ROWS] },
    tables: { specimens: { name: SPECIMEN_TABLE, order: ["id"] } },
    async invoke(driver, candidateFactory) {
      assert(candidateFactory);
      const candidate = candidateFactory({ schema, driver });
      return candidate.execute("specimen", "findMany", {
        orderBy: { id: "asc" },
        select: {
          id: true,
          big: true,
          amount: true,
          moment: true,
          day: true,
          clock: true,
          status: true,
          document: true,
          payload: true,
        },
      });
    },
    assert(observation) {
      assert.equal(observation.outcome.kind, "success");
      const published = rows(
        (observation.outcome as { value: unknown }).value
      );
      assert.equal(published.length, 3);
      const first = published[0];
      assert.ok(first);
      assert.equal(typeof first.big, "bigint");
      assert.equal(first.big, 9_007_199_254_740_993n);
      assert.ok(first.amount instanceof Decimal);
      assert.equal(canonicalizeDecimal(first.amount), "123456.001");
      assert.ok(first.moment instanceof Date);
      assert.equal(
        (first.moment as Date).toISOString(),
        "2024-01-15T10:30:00.123Z"
      );
      assert.ok(first.day instanceof Date);
      assert.equal(
        (first.day as Date).toISOString(),
        "2024-01-15T00:00:00.000Z"
      );
      assert.equal(first.clock, "10:30:00");
      assert.equal(first.status, "ACTIVE");
      assert.deepEqual(first.document, ALPHA_DOCUMENT);
      assertBytes(first.payload, ALPHA_BYTES, "SC-12 blob on the first row");
      const second = published[1];
      assert.ok(second);
      // A NULL JSON column publishes the JavaScript null, not a sentinel.
      assert.equal(second.document, null);
      assertBytes(second.payload, BETA_BYTES, "SC-12 blob on the second row");
      const third = published[2];
      assert.ok(third);
      assert.equal(third.big, 0n);
      assert.equal(canonicalizeDecimal(third.amount), "0");
      assertBytes(third.payload, GAMMA_BYTES, "SC-12 blob on the third row");
    },
  };
  const world = await runLiveWorld(
    fixture,
    (names) => ({ [SPECIMEN_TABLE]: specimenTable(names) }),
    factory
  );
  throwTerminalFailure(world);
  fixture.assert(world.observation);
  world.assertHealthy();
}

async function runCollationAndNulls(factory: CandidateEngineFactory) {
  const schema = specimenSchema();
  const fixture: LiveFixture = {
    expectedExecutions: 3,
    initial: { specimens: [...SPECIMEN_ROWS] },
    tables: { specimens: { name: SPECIMEN_TABLE, order: ["id"] } },
    async invoke(driver, candidateFactory) {
      assert(candidateFactory);
      const candidate = candidateFactory({ schema, driver });
      const insensitive = await candidate.execute("specimen", "findMany", {
        where: { label: { contains: "a", mode: "insensitive" } },
        orderBy: { id: "asc" },
        select: { id: true },
      });
      const sensitive = await candidate.execute("specimen", "findMany", {
        where: { label: { contains: "A", mode: "default" } },
        orderBy: { id: "asc" },
        select: { id: true },
      });
      const nullsFirst = await candidate.execute("specimen", "findMany", {
        orderBy: { count: { sort: "asc", nulls: "first" } },
        select: { id: true },
      });
      return { insensitive, sensitive, nullsFirst };
    },
    assert(observation) {
      assert.equal(observation.outcome.kind, "success");
      const value = (observation.outcome as { value: Record<string, unknown> })
        .value;
      assert.deepEqual(
        rows(value.insensitive).map((row) => row.id),
        [1, 2, 3],
        "insensitive contains must fold case on every provider"
      );
      assert.deepEqual(
        rows(value.sensitive).map((row) => row.id),
        [1, 3],
        "default mode must stay case-sensitive"
      );
      assert.deepEqual(
        rows(value.nullsFirst).map((row) => row.id),
        [2, 1, 3],
        "nulls: first must place the SQL NULL first on every provider"
      );
    },
  };
  const world = await runLiveWorld(
    fixture,
    (names) => ({ [SPECIMEN_TABLE]: specimenTable(names) }),
    factory
  );
  throwTerminalFailure(world);
  fixture.assert(world.observation);
  world.assertHealthy();
}

async function runCursorAndAggregates(factory: CandidateEngineFactory) {
  const schema = specimenSchema();
  const fixture: LiveFixture = {
    expectedExecutions: 3,
    initial: { specimens: [...SPECIMEN_ROWS] },
    tables: { specimens: { name: SPECIMEN_TABLE, order: ["id"] } },
    async invoke(driver, candidateFactory) {
      assert(candidateFactory);
      const candidate = candidateFactory({ schema, driver });
      const page = await candidate.execute("specimen", "findMany", {
        orderBy: { id: "asc" },
        cursor: { id: 2 },
        take: 2,
        select: { id: true },
      });
      const backwards = await candidate.execute("specimen", "findMany", {
        orderBy: { id: "asc" },
        cursor: { id: 3 },
        take: -2,
        select: { id: true },
      });
      const grouped = await candidate.execute("specimen", "groupBy", {
        by: ["status"],
        _count: { _all: true },
        _min: { count: true },
        _max: { count: true },
        orderBy: { status: "asc" },
      });
      return { page, backwards, grouped };
    },
    assert(observation) {
      assert.equal(observation.outcome.kind, "success");
      const value = (observation.outcome as { value: Record<string, unknown> })
        .value;
      assert.deepEqual(
        rows(value.page).map((row) => row.id),
        [2, 3]
      );
      assert.deepEqual(
        rows(value.backwards).map((row) => row.id),
        [2, 3]
      );
      assert.deepEqual(rows(value.grouped), [
        { status: "ACTIVE", _count: { _all: 1 }, _min: { count: 10 }, _max: { count: 10 } },
        { status: "DONE", _count: { _all: 1 }, _min: { count: 30 }, _max: { count: 30 } },
        { status: "PAUSED", _count: { _all: 1 }, _min: { count: null }, _max: { count: null } },
      ]);
    },
  };
  const world = await runLiveWorld(
    fixture,
    (names) => ({ [SPECIMEN_TABLE]: specimenTable(names) }),
    factory
  );
  throwTerminalFailure(world);
  fixture.assert(world.observation);
  world.assertHealthy();
}

/**
 * The recursive read is the ordinary `findMany` with `recurse` on its
 * `children` node and must lower to exactly one provider statement. The model
 * object is built once here and shared with the schema.
 */
const nativeNode = (() => {
  const node = s
    .model({
      tenant: s.string().map("tenant_key"),
      code: s.string().map("node_code"),
      label: s.string().map("display_label"),
      amount: s.decimal({ precision: 10, scale: 2 }).map("node_amount"),
      moment: s.dateTime().map("node_moment"),
      parentTenant: s.string().nullable().map("parent_tenant_key"),
      parentCode: s.string().nullable().map("parent_node_code"),
      parent: s
        .toOne(() => node)
        .fields("parentTenant", "parentCode")
        .references("tenant", "code")
        .name("tree"),
      children: s.toMany(() => node).name("tree"),
    })
    .id(["tenant", "code"])
    .map(NODE_TABLE);
  return node;
})();

function nodeSchema() {
  return { node: nativeNode };
}

function nodeTable(names: { quote(identifier: string): string }): string {
  return [
    `${names.quote("tenant_key")} ${textType} NOT NULL`,
    `${names.quote("node_code")} ${textType} NOT NULL`,
    `${names.quote("display_label")} ${textType} NOT NULL`,
    `${names.quote("node_amount")} DECIMAL(10,2) NOT NULL`,
    `${names.quote("node_moment")} ${timestampType} NOT NULL`,
    `${names.quote("parent_tenant_key")} ${textType}`,
    `${names.quote("parent_node_code")} ${textType}`,
    `PRIMARY KEY(${names.quote("tenant_key")},${names.quote("node_code")})`,
  ].join(",");
}

async function runRecursiveFit(factory: CandidateEngineFactory) {
  const schema = nodeSchema();
  const initial = {
    nodes: [
      {
        tenant_key: "tree",
        node_code: "root",
        display_label: "Root",
        node_amount: "1.00",
        node_moment: nativeDateTime("2024-01-01T00:00:00.000Z"),
        parent_tenant_key: null,
        parent_node_code: null,
      },
      {
        tenant_key: "tree",
        node_code: "child",
        display_label: "Child",
        node_amount: "2.50",
        node_moment: nativeDateTime("2024-02-01T00:00:00.000Z"),
        parent_tenant_key: "tree",
        parent_node_code: "root",
      },
      {
        tenant_key: "tree",
        node_code: "grandchild",
        display_label: "Grandchild",
        node_amount: "-0.25",
        node_moment: nativeDateTime("2024-03-01T00:00:00.000Z"),
        parent_tenant_key: "tree",
        parent_node_code: "child",
      },
      // A second tenant the traversal's seed must not reach.
      {
        tenant_key: "other",
        node_code: "root",
        display_label: "Other root",
        node_amount: "9.99",
        node_moment: nativeDateTime("2024-04-01T00:00:00.000Z"),
        parent_tenant_key: null,
        parent_node_code: null,
      },
    ],
  };
  const fixture: LiveFixture = {
    // One ordinary engine read: the recursion is a projected relation value.
    expectedExecutions: 1,
    initial,
    tables: { nodes: { name: NODE_TABLE, order: ["tenant_key", "node_code"] } },
    async invoke(driver, candidateFactory) {
      assert(candidateFactory);
      const candidate = candidateFactory({ schema, driver });
      const select = {
        code: true,
        amount: true,
        moment: true,
      };
      // Contract change: the operation owns the root (the retired seed list
      // was this `where`); `recurse` modifies the ordinary `children` node.
      return candidate.execute("node", "findMany", {
        where: { tenant: "tree", code: "root" },
        select: {
          ...select,
          children: {
            recurse: { depth: 2 },
            orderBy: [{ code: "asc" }],
            select,
          },
        },
      });
    },
    assert(observation) {
      assert.equal(observation.outcome.kind, "success");
      const value = (observation.outcome as { value: unknown }).value;
      const flat: Record<string, unknown>[] = [];
      const walk = (member: unknown) => {
        if (Array.isArray(member)) {
          for (const nested of member) walk(nested);
          return;
        }
        if (member === null || typeof member !== "object") return;
        const row = member as Record<string, unknown>;
        if (typeof row.code === "string") flat.push(row);
        for (const nested of Object.values(row)) walk(nested);
      };
      walk(value);
      const byCode = new Map(flat.map((row) => [String(row.code), row]));
      assert.deepEqual(
        [...byCode.keys()].sort(),
        ["child", "grandchild", "root"],
        "the traversal reached every node of the seeded tenant within the depth bound"
      );
      assert.equal(canonicalizeDecimal(byCode.get("root")?.amount), "1");
      assert.equal(canonicalizeDecimal(byCode.get("child")?.amount), "2.5");
      assert.equal(
        canonicalizeDecimal(byCode.get("grandchild")?.amount),
        "-0.25"
      );
      const moment = byCode.get("grandchild")?.moment;
      assert.ok(moment instanceof Date);
      assert.equal(moment.toISOString(), "2024-03-01T00:00:00.000Z");
    },
  };
  const world = await runLiveWorld(
    fixture,
    (names) => ({ [NODE_TABLE]: nodeTable(names) }),
    factory
  );
  throwTerminalFailure(world);
  fixture.assert(world.observation);
  // The harness records every statement the driver executed; the read's claim
  // is that the whole traversal is exactly one of them.
  assert.equal(
    world.statements.length,
    1,
    "the native recursive read must lower to exactly one statement"
  );
  world.assertHealthy();
}

describe(`G4 native ${liveProvider} read envelope`, () => {
  it("g4-native-scalar-codec-round-trip", () => runCodecRoundTrip(createCommandEngine), 30_000);
  it(
    "g4-native-string-mode-and-nulls-ordering",
    () => runCollationAndNulls(createCommandEngine),
    30_000
  );
  it(
    "g4-native-cursor-pagination-and-aggregate-shapes",
    () => runCursorAndAggregates(createCommandEngine),
    30_000
  );
  it(
    "g4-native-recursive-read-fit",
    () => runRecursiveFit(createCommandEngine),
    30_000
  );
  it("g4-native-datetime-literal-matches-the-adapter", () => {
    const adapters = {
      pg: { adapter: new PostgresAdapter(), spell: pgDateTime },
      mysql: { adapter: new MySQLAdapter(), spell: mysqlDateTime },
    };
    for (const { adapter, spell } of Object.values(adapters))
      for (const iso of [
        "2024-01-15T10:30:00.123Z",
        "1970-01-01T00:00:00.000Z",
        "2030-12-31T23:59:59.000Z",
        "2024-06-30T22:00:00.500Z",
      ])
        assert.deepEqual(
          [spell(iso)],
          adapter.literals.dateTime(iso).values,
          `the fixture and the adapter disagree on how ${iso} is stored`
        );
  });
});
