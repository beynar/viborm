import type { AnyDriver } from "@drivers";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import type { Model } from "@schema/model";
import { CreateOperation } from "@src/query-engine/write-engine/CreateOperation";
import {
  isOperationValueReference,
  type OperationFragment,
  type PlanningFragment,
} from "@src/query-engine/write-engine/OperationFragment";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { publishedOutputs } from "@tests/fixtures/planning-published";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

class PostgresPlanningDriver extends PlanningDriver {
  constructor() {
    super("postgresql");
  }
}

class SQLitePlanningDriver extends PlanningDriver {
  constructor() {
    super("sqlite");
  }
}

class MySQLPlanningDriver extends PlanningDriver {
  constructor() {
    super("mysql", { driverName: "mysql2" });
  }
}

const PGliteDriver = PostgresPlanningDriver;
const SQLite3Driver = SQLitePlanningDriver;
const MySQL2Driver = MySQLPlanningDriver;

/**
 * PARITY WITNESS — Package M (§6 M1, "Pure create DAG witness").
 *
 * THE BEFORE-PICTURE. Package M adds a PostgreSQL-only lowering that turns a
 * create tree's cross-statement value flow into CTE columns. Every other dialect
 * keeps the multi-statement series exactly as pinned here, and so does
 * PostgreSQL for every shape M declines. This file is what "unchanged" means.
 *
 * The four shapes, chosen because each isolates one thing M could get wrong:
 *
 *   A. **A generated parent identity spent by ONE child** whose own key the
 *      application supplies. THREE statements, and the one shape M moves: the
 *      only conjunct `buildTreeFold` failed on it was "nothing flows between the
 *      statements", and lowering the flow is what M does. Two dialects keep the
 *      three; PostgreSQL sends one, pinned below beside them. Read the two
 *      branches together — that pair IS Package M's before and after.
 *   B. **A chain** — generated parent, generated child, application-keyed
 *      grandchild spending the child's identity. Four statements. TWO arms take
 *      a database-assigned value, so `foldArmsAreOrderInsensitive` declines it
 *      on every dialect, before and after M. Pinned because §6 M1 asks for the
 *      grandchild link and because a widened ordering rule would show up here
 *      first.
 *   C. **Compound application-known identity members.** Both key members are
 *      spelled by the caller, so the child's foreign key is a pair of literals
 *      and each member carries its own destination cast. PostgreSQL already
 *      folds this shape (Phase 8.2, `mutation-projection-cte-fold`), which is
 *      why the PG legs below are the folded one-statement form: M must leave it
 *      byte-identical.
 *   D. **A relation-free create.** No sibling arm, so nothing to fold on any
 *      dialect. The control that says a changed number in A is not a change to
 *      how a plain create compiles.
 *
 * DIMENSIONS PINNED (plan §6 A2's nine): planning IDs/order/SQL/params/outputs
 * (every shape plans NOTHING — a fresh record has no row to locate); final step
 * IDs and order; final SQL and parameters, byte-level, in four dialect/substrate
 * spellings; destination casts, which are the point of the reference lowering;
 * outputs; expects; race pins (none arise — pinned `null`); `onUniqueConflict`
 * (none — pinned `null`). Statement counts are the step counts.
 *
 * Structural fragment proofs do not boot a database (AGENTS.md); the live
 * PostgreSQL statement-count measurement M4 needs lives in
 * `mutation-dependency-fold.test.ts` beside the lowerer it measures.
 */

const paritySchema = (() => {
  const hub = s
    .model({
      id: s.int().id().increment(),
      name: s.string(),
      /** Shape A's consumer: an APPLICATION-supplied key, so this arm leaves the
       *  database nothing to assign and the ordering conjunct passes. */
      spans: s.toMany(() => span),
      /** Shape B's middle link: a SECOND database-assigned key. */
      cells: s.toMany(() => cell),
    })
    .map("parity_m_hubs");
  const span = s
    .model({
      id: s.string().id(),
      hubId: s.int().nullable(),
      hub: s
        .toOne(() => hub)
        .fields("hubId")
        .references("id"),
    })
    .map("parity_m_spans");
  const cell = s
    .model({
      id: s.int().id().increment(),
      hubId: s.int().nullable(),
      hub: s
        .toOne(() => hub)
        .fields("hubId")
        .references("id"),
      leaves: s.toMany(() => leaf),
    })
    .map("parity_m_cells");
  const leaf = s
    .model({
      id: s.string().id(),
      cellId: s.int().nullable(),
      cell: s
        .toOne(() => cell)
        .fields("cellId")
        .references("id"),
    })
    .map("parity_m_leaves");
  /** Shape C: a COMPOUND identity whose members the caller spells. */
  const depot = s
    .model({
      region: s.string(),
      code: s.string(),
      crates: s.toMany(() => crate),
    })
    .id(["region", "code"])
    .map("parity_m_depots");
  const crate = s
    .model({
      id: s.string().id(),
      depotRegion: s.string().nullable(),
      depotCode: s.string().nullable(),
      depot: s
        .toOne(() => depot)
        .fields("depotRegion", "depotCode")
        .references("region", "code"),
    })
    .map("parity_m_crates");
  return { hub, span, cell, leaf, depot, crate };
})();

hydrateSchemaNames(paritySchema);

function engineFor(driver: AnyDriver): QueryEngine {
  return new QueryEngine(
    driver,
    createModelRegistry(paritySchema, createSchemaRegistry(paritySchema))
  );
}

function normalized(value: unknown): unknown {
  if (isOperationValueReference(value)) {
    return { ref: `${value.step}.${value.output}` };
  }
  if (Array.isArray(value)) return value.map(normalized);
  if (!(value && typeof value === "object")) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, member]) => [key, normalized(member)])
  );
}

function reference(step: string, output: string): unknown {
  return { ref: `${step}.${output}` };
}

function fragmentContract(
  driver: AnyDriver,
  fragment: PlanningFragment | OperationFragment
): unknown {
  return {
    steps: fragment.steps.map((current) => {
      if (current.kind === "guard") throw new Error("Unexpected guard step.");
      const query = driver._prepare(current.statement);
      return {
        id: current.id,
        kind: current.kind,
        sql: query.sql,
        params: normalized(query.params),
        outputs: normalized(current.outputs),
        expects: current.expects ?? null,
        racePin: current.kind === "write" ? (current.racePin ?? null) : null,
        onUniqueConflict:
          current.kind === "write" ? (current.onUniqueConflict ?? null) : null,
      };
    }),
    outputs: normalized(publishedOutputs(fragment)),
  };
}

const EMPTY_PLANNING = { steps: [], outputs: {} };

const CREATE_TERMINAL_FAILURE = {
  kind: "exactlyOneRow",
  failure: {
    kind: "query",
    message: "query-engine-v2 create terminal read expected exactly one row.",
    raceable: false,
  },
};

interface Substrate {
  readonly name: string;
  readonly createDriver: () => AnyDriver;
  readonly quote: (name: string) => string;
  /** A persistent table, as opposed to a column/alias/CTE name: PostgreSQL
   *  renders it schema-qualified, SQLite and unbound MySQL2 render it bare. */
  readonly table: (name: string) => string;
  readonly placeholder: (index: number) => string;
  readonly intCast: string;
  readonly textCast: string;
  readonly capturesByReturning: boolean;
  readonly foldsCteWithMutations: boolean;
  readonly terminalExpects: unknown;
}

const SUBSTRATES: readonly Substrate[] = [
  {
    name: "PostgreSQL transaction plan (RETURNING, mutation CTEs)",
    createDriver: () => new PGliteDriver(),
    quote: (name) => `"${name}"`,
    table: (name) => `"public"."${name}"`,
    placeholder: (index) => `$${index}`,
    intCast: "INTEGER",
    textCast: "TEXT",
    capturesByReturning: true,
    foldsCteWithMutations: true,
    terminalExpects: CREATE_TERMINAL_FAILURE,
  },
  {
    name: "SQLite3 transaction (RETURNING, read-only CTEs)",
    createDriver: () => new SQLite3Driver(),
    quote: (name) => `"${name}"`,
    table: (name) => `"${name}"`,
    placeholder: () => "?",
    intCast: "INTEGER",
    textCast: "TEXT",
    capturesByReturning: true,
    foldsCteWithMutations: false,
    terminalExpects: CREATE_TERMINAL_FAILURE,
  },
  {
    name: "MySQL2 (insertId, no RETURNING)",
    createDriver: () => new MySQL2Driver(),
    quote: (name) => `\`${name}\``,
    table: (name) => `\`${name}\``,
    placeholder: () => "?",
    intCast: "SIGNED",
    textCast: "CHAR",
    capturesByReturning: false,
    foldsCteWithMutations: false,
    terminalExpects: CREATE_TERMINAL_FAILURE,
  },
];

for (const substrate of SUBSTRATES) {
  const q = substrate.quote;
  const tbl = substrate.table;
  const p = substrate.placeholder;
  const identityOutput = substrate.capturesByReturning
    ? { kind: "firstRowField", field: "id" }
    : { kind: "insertId" };
  const idReturning = substrate.capturesByReturning
    ? ` RETURNING ${q("id")} AS ${q("id")}`
    : "";

  describe(`parity M — the portable create DAG (${substrate.name})`, () => {
    test("A. a generated parent identity spent by one child costs three statements", () => {
      const driver = substrate.createDriver();
      const operation = new CreateOperation(
        engineFor(driver),
        paritySchema.hub as Model<any>,
        {
          data: { name: "H", spans: { create: { id: "s1" } } },
          select: { id: true },
        }
      );
      expect(fragmentContract(driver, operation.planning())).toEqual(
        EMPTY_PLANNING
      );
      if (substrate.foldsCteWithMutations) {
        // PACKAGE M. MEASURED at the pre-M commit, this substrate compiled the
        // SAME three steps the other two still compile below — `hub.create`,
        // `span.create` spending `hub.create.id`, `hub.select`. The reference is
        // now lowered to a CTE column and the arms are one command. Byte-for-byte
        // beside the series it replaced: the same INSERT text, the same column
        // order, the same destination `CAST`, with `(SELECT "id" FROM
        // "__viborm_mutation")` where the bound parameter used to sit.
        expect(fragmentContract(driver, operation.compile({}))).toEqual({
          steps: [
            {
              id: "hub.create",
              kind: "write",
              sql: `WITH ${q("__viborm_mutation")} AS (INSERT INTO ${tbl("parity_m_hubs")} (${q("name")}) VALUES (${p(1)}) RETURNING ${q("id")}, ${q("name")}), ${q("__viborm_write_0")} AS (INSERT INTO ${tbl("parity_m_spans")} (${q("id")}, ${q("hubId")}) VALUES (${p(2)}, CAST((SELECT ${q("id")} FROM ${q("__viborm_mutation")}) AS ${substrate.intCast}))) SELECT ${q("t0")}.${q("id")} AS ${q("id")} FROM ${q("__viborm_mutation")} AS ${q("t0")}`,
              params: ["H", "s1"],
              outputs: { result: { kind: "rows" } },
              expects: substrate.terminalExpects,
              racePin: null,
              onUniqueConflict: null,
            },
          ],
          outputs: { result: reference("hub.create", "result") },
        });
        return;
      }
      expect(fragmentContract(driver, operation.compile({}))).toEqual({
        steps: [
          {
            id: "hub.create",
            kind: "write",
            sql: `INSERT INTO ${tbl("parity_m_hubs")} (${q("name")}) VALUES (${p(1)})${idReturning}`,
            params: ["H"],
            outputs: { id: identityOutput },
            expects: null,
            racePin: null,
            onUniqueConflict: null,
          },
          {
            // THE reference M lowers. It rides inside `Sql.values` wrapped in the
            // destination column's cast, so a lowering that swaps only the VALUE
            // keeps this cast exactly where it is.
            id: "span.create",
            kind: "write",
            sql: `INSERT INTO ${tbl("parity_m_spans")} (${q("id")}, ${q("hubId")}) VALUES (${p(1)}, CAST(${p(2)} AS ${substrate.intCast}))`,
            params: ["s1", reference("hub.create", "id")],
            outputs: {},
            expects: null,
            racePin: null,
            onUniqueConflict: null,
          },
          {
            id: "hub.select",
            kind: "read",
            sql: `SELECT ${q("t0")}.${q("id")} AS ${q("id")} FROM ${tbl("parity_m_hubs")} AS ${q("t0")} WHERE ${q("t0")}.${q("id")} = CAST(${p(1)} AS ${substrate.intCast}) LIMIT 1`,
            params: [reference("hub.create", "id")],
            outputs: { result: { kind: "rows" } },
            expects: substrate.terminalExpects,
            racePin: null,
            onUniqueConflict: null,
          },
        ],
        outputs: { result: reference("hub.select", "result") },
      });
    });

    test("B. a chain of two generated identities costs four, and stays four", () => {
      const driver = substrate.createDriver();
      const operation = new CreateOperation(
        engineFor(driver),
        paritySchema.hub as Model<any>,
        {
          data: {
            name: "H",
            cells: { create: { leaves: { create: { id: "l1" } } } },
          },
          select: { id: true },
        }
      );
      expect(fragmentContract(driver, operation.planning())).toEqual(
        EMPTY_PLANNING
      );
      expect(fragmentContract(driver, operation.compile({}))).toEqual({
        steps: [
          {
            id: "hub.create",
            kind: "write",
            sql: `INSERT INTO ${tbl("parity_m_hubs")} (${q("name")}) VALUES (${p(1)})${idReturning}`,
            params: ["H"],
            outputs: { id: identityOutput },
            expects: null,
            racePin: null,
            onUniqueConflict: null,
          },
          {
            id: "cell.create",
            kind: "write",
            sql: `INSERT INTO ${tbl("parity_m_cells")} (${q("hubId")}) VALUES (CAST(${p(1)} AS ${substrate.intCast}))${idReturning}`,
            params: [reference("hub.create", "id")],
            outputs: { id: identityOutput },
            expects: null,
            racePin: null,
            onUniqueConflict: null,
          },
          {
            id: "leaf.create",
            kind: "write",
            sql: `INSERT INTO ${tbl("parity_m_leaves")} (${q("id")}, ${q("cellId")}) VALUES (${p(1)}, CAST(${p(2)} AS ${substrate.intCast}))`,
            params: ["l1", reference("cell.create", "id")],
            outputs: {},
            expects: null,
            racePin: null,
            onUniqueConflict: null,
          },
          {
            id: "hub.select",
            kind: "read",
            sql: `SELECT ${q("t0")}.${q("id")} AS ${q("id")} FROM ${tbl("parity_m_hubs")} AS ${q("t0")} WHERE ${q("t0")}.${q("id")} = CAST(${p(1)} AS ${substrate.intCast}) LIMIT 1`,
            params: [reference("hub.create", "id")],
            outputs: { result: { kind: "rows" } },
            expects: substrate.terminalExpects,
            racePin: null,
            onUniqueConflict: null,
          },
        ],
        outputs: { result: reference("hub.select", "result") },
      });
    });

    test("C. compound application-known identity members are literals, each cast at its own column", () => {
      const driver = substrate.createDriver();
      const operation = new CreateOperation(
        engineFor(driver),
        paritySchema.depot as Model<any>,
        {
          data: {
            region: "eu",
            code: "c1",
            crates: { create: { id: "k1" } },
          },
          select: { region: true },
        }
      );
      expect(fragmentContract(driver, operation.planning())).toEqual(
        EMPTY_PLANNING
      );
      const compiled = fragmentContract(driver, operation.compile({})) as {
        steps: { sql: string; params: unknown[] }[];
      };
      if (substrate.foldsCteWithMutations) {
        // Nothing flows between these arms — both key members are spelled — so
        // Phase 8.2's tree fold already merges them. M must leave this alone.
        expect(compiled.steps).toHaveLength(1);
        expect(compiled.steps[0]?.sql).toContain(
          `WITH ${q("__viborm_mutation")} AS (INSERT INTO ${tbl("parity_m_depots")}`
        );
        expect(compiled.steps[0]?.params).toEqual([
          "eu",
          "c1",
          "k1",
          "eu",
          "c1",
        ]);
        return;
      }
      expect(compiled.steps).toHaveLength(3);
      expect(compiled.steps[1]).toMatchObject({
        sql: `INSERT INTO ${tbl("parity_m_crates")} (${q("id")}, ${q("depotRegion")}, ${q("depotCode")}) VALUES (${p(1)}, CAST(${p(2)} AS ${substrate.textCast}), CAST(${p(3)} AS ${substrate.textCast}))`,
        params: ["k1", "eu", "c1"],
      });
    });

    test("D. a relation-free create has no sibling arm to fold", () => {
      const driver = substrate.createDriver();
      const operation = new CreateOperation(
        engineFor(driver),
        paritySchema.hub as Model<any>,
        { data: { name: "H" }, select: { id: true } }
      );
      expect(fragmentContract(driver, operation.planning())).toEqual(
        EMPTY_PLANNING
      );
      const compiled = fragmentContract(driver, operation.compile({})) as {
        steps: unknown[];
      };
      // One statement wherever the INSERT can report the row it made; two where
      // the terminal read has to go and fetch it. Neither number is M's to move.
      expect(compiled.steps).toHaveLength(
        substrate.capturesByReturning ? 1 : 2
      );
    });
  });
}
