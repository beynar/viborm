/**
 * G — the write's terminal projection (pattern-engine-ideal-state.md §8).
 *
 * A write answers with a read of the asserted rows, and today's engine spells
 * that read in three per-dialect forms. `matchWriteResult` builds all three
 * from the terminal K1 pattern; this pins each against the FROZEN ORACLE
 * (`tests/pattern/corpus/goldens`), byte for byte, on postgresql, sqlite and
 * mysql:
 *
 * | golden | postgresql | sqlite | mysql |
 * |---|---|---|---|
 * | `create:org:scalar` | returning | returning | reselect |
 * | `create:org:teams.create` | fold | reselect | reselect |
 * | `update:org:scalar` | returning | returning | reselect |
 * | `upsert:org:scalar` | returning | returning | reselect |
 * | `createMany:org:scalar.select` | returning | returning | reselect |
 * | `updateMany:org:scalar.select` | returning | returning | reselect (set) |
 *
 * The `returning` cells whose mutation half this test can rebuild with today's
 * own builder (`create`, `update`) are compared as WHOLE statements; the rest
 * compare the projection this function attaches — the tail after the mutation —
 * because the mutation half belongs to the packer, not here.
 *
 * The second half pins the projection ROUND TRIP: over a seeded corpus of
 * generated reads, the `select` / `include` reconstructed from a K1 projection
 * compiles to the same projection SQL as the request it was built from.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import type { Dialect } from "@drivers";
import { buildSelect } from "@query-engine/builders/select-builder";
import { createQueryScope } from "@query-engine/context";
import { buildInsertStatement } from "@query-engine/operations/create";
import { buildUpdateStatement } from "@query-engine/operations/update";
import {
  constructRead,
  type ReadOperation,
} from "@query-engine/pattern/construct-read";
import { matchWriteResult } from "@query-engine/pattern/match";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import type { Operation, QueryScope } from "@query-engine/types";
import { validate } from "@query-engine/validator";
import { referenceSql } from "@query-engine/write-engine/fragment-builders";
import type { Model } from "@schema/model";
import { type Sql, sql } from "@sql";
import { SqlOnlyDriver } from "@tests/fixtures/drivers/sql-only";
import { fk, type SchemaName, schemas } from "@tests/pattern/corpus/schemas";
import {
  generateCorpus,
  type RootOperation,
} from "@tests/pattern/generator/generate";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

// =============================================================================
// HARNESS
// =============================================================================

interface DialectPin {
  readonly dialect: Dialect;
  readonly placeholder: "$n" | "?";
  readonly createAdapter: () => DatabaseAdapter;
}

const POSTGRES: DialectPin = {
  dialect: "postgresql",
  placeholder: "$n",
  createAdapter: () => new PostgresAdapter(),
};
const SQLITE: DialectPin = {
  dialect: "sqlite",
  placeholder: "?",
  createAdapter: () => new SQLiteAdapter(),
};
const MYSQL: DialectPin = {
  dialect: "mysql",
  placeholder: "?",
  createAdapter: () => new MySQLAdapter(),
};
const DIALECTS: readonly DialectPin[] = [POSTGRES, SQLITE, MYSQL];

const GOLDENS = join(import.meta.dirname, "..", "corpus", "goldens");
const NEEDS_A_SELECTOR = /needs a selector/;

interface GoldenStep {
  readonly id: string;
  readonly sql?: string;
  readonly params?: unknown[];
}

/** One step of a frozen oracle dump, by its step id. */
function golden(stem: string, pin: DialectPin, stepId: string): GoldenStep {
  const file = `${stem}.${pin.dialect}.transaction.found.json`;
  const dump = JSON.parse(readFileSync(join(GOLDENS, file), "utf8")) as {
    final: GoldenStep[];
  };
  const step = dump.final.find((candidate) => candidate.id === stepId);
  if (!step) {
    throw new Error(`${file} has no step '${stepId}'`);
  }
  return step;
}

const statement = (built: Sql, pin: DialectPin) => ({
  sql: built.toStatement(pin.placeholder),
  params: built.values,
});

const engines = new Map<string, QueryEngine>();
function engineFor(schema: Record<string, Model<any>>, pin: DialectPin) {
  const key = `${Object.keys(schema).join(",")}:${pin.dialect}`;
  let engine = engines.get(key);
  if (!engine) {
    engine = new QueryEngine(
      new SqlOnlyDriver(pin.createAdapter(), pin.dialect),
      createModelRegistry(schema, createSchemaRegistry(schema))
    );
    engines.set(key, engine);
  }
  return engine;
}

/** The terminal match pattern of a write: a read of the asserted row. */
function terminalPattern(
  engine: QueryEngine,
  model: Model<any>,
  operation: ReadOperation,
  args: Record<string, unknown>
) {
  return constructRead(model, operation, args, engine.relations);
}

// =============================================================================
// THE THREE FORMS, AGAINST THE FROZEN ORACLE
// =============================================================================

const ORG_CREATE = { id: "o1", slug: "one", name: "One" };

function orgScope(pin: DialectPin): {
  engine: QueryEngine;
  ctx: QueryScope;
  org: Model<any>;
} {
  const engine = engineFor(fk as Record<string, Model<any>>, pin);
  const org = fk.org as Model<any>;
  return { engine, ctx: createQueryScope(engine, org), org };
}

describe("matchWriteResult reproduces today's write result forms", () => {
  // --- returning: the mutation's own rows are the result --------------------

  test.each([
    POSTGRES,
    SQLITE,
  ])("create:org:scalar — returning on $dialect", (pin) => {
    const { engine, ctx, org } = orgScope(pin);
    const built = matchWriteResult(ctx, {
      pattern: terminalPattern(engine, org, "findMany", {
        select: { id: true },
      }),
      form: "returning",
      mutation: buildInsertStatement(ctx, ORG_CREATE),
    });
    const expected = golden("create_org_scalar", pin, "org.create");
    expect(statement(built, pin)).toEqual({
      sql: expected.sql,
      params: expected.params,
    });
  });

  test.each([
    POSTGRES,
    SQLITE,
  ])("update:org:scalar — returning on $dialect", (pin) => {
    const { engine, ctx, org } = orgScope(pin);
    const built = matchWriteResult(ctx, {
      pattern: terminalPattern(engine, org, "findMany", {
        select: { id: true },
      }),
      form: "returning",
      mutation: buildUpdateStatement(ctx, {
        where: { id: "o1" },
        // Compiled data: the record compilers lower a public value into its
        // assignment before this leaf, which is what `buildUpdateStatement` takes.
        data: { name: { set: "Renamed" } },
      }),
    });
    const expected = golden("update_org_scalar", pin, "org.update");
    expect(statement(built, pin)).toEqual({
      sql: expected.sql,
      params: expected.params,
    });
  });

  /**
   * The mutation half of an upsert and of the bulk returning arms is not
   * separable from today's builders (they attach their own RETURNING), so what
   * is compared is the projection this function attaches: the statement tail
   * after a marker mutation.
   */
  const MARKER = "__viborm_mutation_half";

  function returningTail(pin: DialectPin, select: Record<string, unknown>) {
    const { engine, ctx, org } = orgScope(pin);
    const built = matchWriteResult(ctx, {
      pattern: terminalPattern(engine, org, "findMany", { select }),
      form: "returning",
      mutation: sql.raw([MARKER]),
    });
    const text = built.toStatement(pin.placeholder);
    return { tail: text.slice(`${MARKER} `.length), params: built.values };
  }

  test.each([
    [POSTGRES, "upsert_org_scalar", "org.upsert", { id: true }],
    [SQLITE, "upsert_org_scalar", "org.upsert", { id: true }],
    [
      POSTGRES,
      "createMany_org_scalar.select",
      "org.createManyReturn",
      { id: true, name: true },
    ],
    [
      SQLITE,
      "createMany_org_scalar.select",
      "org.createManyReturn",
      { id: true, name: true },
    ],
    [
      POSTGRES,
      "updateMany_org_scalar.select",
      "org.updateManyReturn",
      { id: true, name: true },
    ],
    [
      SQLITE,
      "updateMany_org_scalar.select",
      "org.updateManyReturn",
      { id: true, name: true },
    ],
  ] as const)("$0.dialect $1 — the returning projection", (pin, stem, stepId, select) => {
    const { tail, params } = returningTail(
      pin,
      select as Record<string, unknown>
    );
    const expected = golden(stem, pin, stepId);
    expect(expected.sql?.endsWith(tail)).toBe(true);
    expect(params).toEqual(
      (expected.params ?? []).slice(
        (expected.params ?? []).length - params.length
      )
    );
  });

  // --- fold: the mutation and its projection in one statement ---------------

  test("create:org:teams.create — the CTE fold on postgresql", () => {
    const pin = POSTGRES;
    const { engine, ctx, org } = orgScope(pin);
    const teamCtx = createQueryScope(engine, fk.team as Model<any>);
    const built = matchWriteResult(ctx, {
      pattern: terminalPattern(engine, org, "findMany", {
        select: { id: true },
      }),
      form: "fold",
      mutation: buildInsertStatement(ctx, ORG_CREATE),
      siblings: [
        buildInsertStatement(teamCtx, {
          id: "t1",
          label: "A",
          orgId: referenceSql(engine, fk.team as Model<any>, "orgId", "o1"),
        }),
      ],
    });
    const expected = golden("create_org_teams.create", pin, "org.create");
    expect(statement(built, pin)).toEqual({
      sql: expected.sql,
      params: expected.params,
    });
  });

  // --- reselect: the read a non-returning driver runs after its mutation ----

  test.each([
    [MYSQL, "create_org_scalar", "org.select", { id: true }, "o1"],
    [MYSQL, "update_org_scalar", "org.select", { id: true }, "o1"],
    [MYSQL, "upsert_org_scalar", "org.select", { id: true }, "o1"],
    [SQLITE, "create_org_teams.create", "org.select", { id: true }, "o1"],
    [MYSQL, "create_org_teams.create", "org.select", { id: true }, "o1"],
    [
      MYSQL,
      "createMany_org_scalar.select",
      "org.createReturn.read",
      { id: true, name: true },
      "o1",
    ],
  ] as const)("$0.dialect $1 — the keyed reselect", (pin, stem, stepId, select, key) => {
    const { engine, ctx, org } = orgScope(pin);
    const built = matchWriteResult(ctx, {
      // The asserted row, addressed by its key: cardinality `one` is what
      // puts the literal `LIMIT 1` on the read.
      pattern: terminalPattern(engine, org, "findUnique", {
        where: { id: key },
        select: select as Record<string, unknown>,
      }),
      form: "reselect",
    });
    const expected = golden(stem, pin, stepId);
    expect(statement(built, pin)).toEqual({
      sql: expected.sql,
      params: expected.params,
    });
  });

  test("updateMany:org:scalar.select — the set reselect on mysql", () => {
    const pin = MYSQL;
    const { engine, ctx, org } = orgScope(pin);
    const captured = "org.updateManyReturn.capture.id";
    const column = ctx.adapter.identifiers.column(ctx.rootAlias, "id");
    // The packer's selector over the rows it captured: the key it read, and
    // the exact-text membership pin beside it.
    // MySQL spells an exact text equality as its own index-usable pair.
    const selector = ctx.adapter.operators.exactTextEq(
      column,
      ctx.adapter.literals.value(captured)
    );
    const built = matchWriteResult(ctx, {
      // A `set` row: many rows answer, so the read carries no LIMIT.
      pattern: terminalPattern(engine, org, "findMany", {
        select: { id: true, name: true },
      }),
      form: "reselect",
      selector,
    });
    const expected = golden(
      "updateMany_org_scalar.select",
      pin,
      "org.updateManyReturn.read"
    );
    expect(statement(built, pin)).toEqual({
      sql: expected.sql,
      params: expected.params,
    });
  });

  test("a reselect whose key only execution binds is refused", () => {
    const { engine, ctx, org } = orgScope(POSTGRES);
    expect(() =>
      matchWriteResult(ctx, {
        pattern: terminalPattern(engine, org, "findMany", {
          select: { id: true },
        }),
        form: "reselect",
      })
    ).toThrow(NEEDS_A_SELECTOR);
  });
});

// =============================================================================
// THE PROJECTION ROUND TRIP
// =============================================================================

const SEED = Number(process.env.PATTERN_FUZZ_SEED ?? 20_240_902);
const COUNT = Number(process.env.PATTERN_WRITE_RESULT_COUNT ?? 200);

const READ_WEIGHTS: Readonly<Record<RootOperation, number>> = {
  findMany: 3,
  findFirst: 1,
  findUnique: 1,
  count: 0,
  aggregate: 0,
  groupBy: 0,
  create: 0,
  update: 0,
  upsert: 0,
  delete: 0,
  createMany: 0,
  updateMany: 0,
  deleteMany: 0,
};

describe("the projection a K1 pattern states is the projection it was built from", () => {
  test.each(DIALECTS.map((pin) => [pin.dialect, pin] as const))(
    "%s",
    (_name, pin) => {
      let compared = 0;
      const differences: string[] = [];
      for (const name of Object.keys(schemas) as SchemaName[]) {
        const schema = schemas[name] as Record<string, Model<any>>;
        const engine = engineFor(schema, pin);
        for (const payload of generateCorpus(
          schema,
          createSchemaRegistry(schema),
          SEED,
          COUNT,
          { weights: READ_WEIGHTS }
        )) {
          const model = schema[payload.model] as Model<any>;
          const operation = payload.operation as ReadOperation;
          let expected: string;
          let built: string;
          try {
            const validated = validate<Record<string, unknown>>(
              engine.schemaRegistry,
              model,
              operation as Operation,
              payload.args
            );
            // Today's projection, from the request.
            const oracleCtx = createQueryScope(engine, model);
            expected = oracleCtx.adapter.mutations
              .returning(
                buildSelect(
                  oracleCtx,
                  validated.select as Record<string, unknown> | undefined,
                  validated.include as Record<string, unknown> | undefined,
                  ""
                )
              )
              .toStatement(pin.placeholder);
            // The same projection, from the pattern.
            const ctx = createQueryScope(engine, model);
            built = matchWriteResult(ctx, {
              pattern: constructRead(
                model,
                operation,
                validated,
                engine.relations
              ),
              form: "returning",
              mutation: sql.raw(["M"]),
            })
              .toStatement(pin.placeholder)
              .slice("M ".length);
          } catch {
            // A payload today refuses (an empty select, an unsupported order)
            // is not this test's subject; the read differential owns refusals.
            continue;
          }
          compared++;
          if (built !== expected && differences.length < 5) {
            differences.push(
              `${name}:${payload.seed}:${payload.model}.${payload.operation}\n    oracle ${expected}\n    mine   ${built}`
            );
          }
        }
      }
      // eslint-disable-next-line no-console
      console.log(
        `write-result projection round trip on ${pin.dialect}: ${compared} payloads, ${differences.length} differences\n${differences.join("\n")}`
      );
      expect(differences).toEqual([]);
      expect(compared).toBeGreaterThan(100);
    },
    120_000
  );
});
