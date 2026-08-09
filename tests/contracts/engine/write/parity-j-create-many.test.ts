import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { MySQL2Driver } from "@drivers/mysql2";
import { PGliteDriver } from "@drivers/pglite";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import {
  isOperationValueReference,
  type OperationFragment,
  type OperationStep,
  type PlanningFragment,
  type StatementStep,
} from "@src/query-engine/write-engine/OperationFragment";
import { constructRoutedOperation } from "@src/query-engine/write-engine/routing";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

/**
 * PARITY WITNESS — Package J (§6 J, "Lift root relation-bearing createMany").
 *
 * Package J routes any row carrying a general relation program to a new
 * `CreateManyRecordSeries`, and its keep gate is that "scalar and
 * direct-polymorphic-connect plans are byte-identical" (§6 J, Keep gate). A router
 * that gains a second destination can silently re-plan the destination it kept, so
 * this file is the byte-for-byte record of the scalar plan the lift must not move.
 * It enters at `constructRoutedOperation`, the one seam J2 edits.
 *
 * DIMENSIONS PINNED (plan §6 A2's nine):
 *   · planning IDs and order, planning SQL and parameters, planning outputs — every
 *     scalar arm plans NOTHING, and that empty planning is itself the fact J2 must
 *     keep: a record series plans per member;
 *   · final IDs and order — `<model>.createMany`, then `#1` for a second shape run.
 *     The ids are also how the three owners are told apart without naming a class:
 *     `createMany`, `createManyReturn` (returning fold), `createReturn.insert` /
 *     `createReturn.read` (the non-returning refetch pair);
 *   · final SQL and parameters — the grouped multi-row `INSERT`, verbatim, on three
 *     dialects, plus each dialect's `skipDuplicates` spelling;
 *   · guards and expects — none exist on this path, asserted rather than assumed;
 *   · race pins — none; `onUniqueConflict: "skip"` is pinned where it IS set
 *     (MySQL) and where it is not (the SQL-leaf dialects);
 *   · exact errors — the refusal J1 lifts, verbatim, on both arms;
 *   · statement counts — the step list IS the statement count. Round trips equal
 *     steps here: `createMany` has no decision, so every step it lists is issued.
 *
 * `create-many-return-fold.test.ts` already owns the RETURNING fold's SHAPE (how many
 * write steps, that the output is the ordered source list). This file adds the bytes
 * that file deliberately left as `toContain("INSERT")` — the dimension a re-plan
 * moves without failing it.
 *
 * NOT PINNED HERE, recorded so the family stays auditable. J's keep gate names
 * "scalar AND direct-polymorphic-connect plans are byte-identical", and `parityJSchema`
 * has no polymorphic member, so the whole `bulk-polymorphic-connect` route inside
 * `ManyAndReturnOperation` — the probe steps, the resolved guards, the grouped INSERT's
 * private `(type, id)` values, and its own refusal at ManyAndReturnOperation.ts:185
 * ("Driver '<name>' cannot execute 'createMany' with 'select', 'skipDuplicates', and
 * polymorphic connects…") — has no before-picture. It is the one path on which
 * `createMany` PLANS anything, which is exactly the fact J2's router keys on.
 *
 * FALSIFIED 2026-08-09 against `src/query-engine/operations/create.ts`: in
 * `buildCreateManyPlan`, forcing `const units = splitGroupsIntoRows(valueGroups);`
 * — abandoning the grouped multi-row INSERT for one statement per row — turned the
 * grouped-INSERT and RETURNING-fold tests red on step ids, SQL and parameters, while
 * the MySQL per-row arms stayed green, so this file distinguishes the grouped plan
 * from the split one rather than merely observing that an INSERT happens. The
 * original was restored from a scratchpad copy taken before the edit.
 */

const parityJSchema = (() => {
  const crate = s
    .model({
      id: s.int().id(),
      label: s.string(),
    })
    .map("pj_crates");
  const autoCrate = s
    .model({
      id: s.int().id().increment(),
      label: s.string(),
    })
    .map("pj_auto_crates");
  /** Every scalar generated, so a `{}` row is a legal DEFAULT VALUES row. */
  const blank = s
    .model({
      id: s.int().id().increment(),
    })
    .map("pj_blanks");
  const parcel = s
    .model({
      id: s.int().id(),
      label: s.string(),
      binId: s.int().nullable(),
      bin: s
        .manyToOne(() => bin)
        .fields("binId")
        .references("id")
        .optional(),
    })
    .map("pj_parcels");
  const bin = s
    .model({
      id: s.int().id(),
      name: s.string(),
      parcels: s.oneToMany(() => parcel),
    })
    .map("pj_bins");
  return { crate, autoCrate, blank, parcel, bin };
})();

hydrateSchemaNames(parityJSchema);

function engineFor(driver: AnyDriver): QueryEngine {
  return new QueryEngine(
    driver,
    createModelRegistry(parityJSchema, createSchemaRegistry(parityJSchema))
  );
}

/** Routes through the public operation name — the seam J2 edits. */
function route(
  driver: AnyDriver,
  model: (typeof parityJSchema)[keyof typeof parityJSchema],
  args: Record<string, unknown>
) {
  const routed = constructRoutedOperation(
    engineFor(driver),
    model,
    "createMany",
    args
  );
  if (!routed) throw new Error("'createMany' did not route");
  return routed;
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

function prepared(
  driver: AnyDriver,
  current: StatementStep
): { readonly sql: string; readonly params: unknown } {
  const query = driver._prepare(current.statement);
  return { sql: query.sql, params: normalized(query.params) };
}

function stepContract(driver: AnyDriver, current: OperationStep): unknown {
  if (current.kind === "guard") throw new Error("createMany plans no guard.");
  return {
    id: current.id,
    kind: current.kind,
    ...prepared(driver, current),
    outputs: normalized(current.outputs),
    expects: current.expects ?? null,
    racePin: current.kind === "write" ? (current.racePin ?? null) : null,
    onUniqueConflict:
      current.kind === "write" ? (current.onUniqueConflict ?? null) : null,
  };
}

function fragmentContract(
  driver: AnyDriver,
  fragment: PlanningFragment | OperationFragment
): unknown {
  return {
    steps: fragment.steps.map((current) => stepContract(driver, current)),
    outputs: normalized(fragment.outputs),
  };
}

/** No guard, no pin, no expect — every scalar bulk write step carries the same three. */
const NO_BRANCH = {
  expects: null,
  racePin: null,
  onUniqueConflict: null,
} as const;

const COUNT_OUTPUT = { count: { kind: "rowCount" } };

const THREE_ROWS = [
  { id: 1, label: "one" },
  { id: 2, label: "two" },
  { id: 3, label: "three" },
];

describe("parity J — the scalar grouped multi-row INSERT", () => {
  test("PostgreSQL: three rows ride ONE statement, and nothing is planned", () => {
    const driver = new PGliteDriver();
    const operation = route(driver, parityJSchema.crate, { data: THREE_ROWS });

    expect(fragmentContract(driver, operation.planning())).toEqual({
      steps: [],
      outputs: {},
    });
    expect(fragmentContract(driver, operation.compile({}))).toEqual({
      steps: [
        {
          id: "crate.createMany",
          kind: "write",
          sql: 'INSERT INTO "pj_crates" ("id", "label") VALUES ($1, $2), ($3, $4), ($5, $6)',
          params: [1, "one", 2, "two", 3, "three"],
          outputs: COUNT_OUTPUT,
          ...NO_BRANCH,
        },
      ],
      // ONE source, but still a LIST: the counts of every statement sum.
      outputs: { count: [reference("crate.createMany", "count")] },
    });
    // The public count is the driver's row count, straight through.
    expect(operation.parse({ count: 3 })).toEqual({ count: 3 });
  });

  test("SQLite and MySQL group the same three rows, differing only in dialect", () => {
    const dialects = [
      {
        driver: new SQLite3Driver(),
        sql: 'INSERT INTO "pj_crates" ("id", "label") VALUES (?, ?), (?, ?), (?, ?)',
      },
      {
        driver: new MySQL2Driver(),
        sql: "INSERT INTO `pj_crates` (`id`, `label`) VALUES (?, ?), (?, ?), (?, ?)",
      },
    ];
    for (const dialect of dialects) {
      const operation = route(dialect.driver, parityJSchema.crate, {
        data: THREE_ROWS,
      });
      expect(operation.planning().steps).toEqual([]);
      expect(fragmentContract(dialect.driver, operation.compile({}))).toEqual({
        steps: [
          {
            id: "crate.createMany",
            kind: "write",
            sql: dialect.sql,
            params: [1, "one", 2, "two", 3, "three"],
            outputs: COUNT_OUTPUT,
            ...NO_BRANCH,
          },
        ],
        outputs: { count: [reference("crate.createMany", "count")] },
      });
    }
  });

  test("a nullable column is written as a literal NULL, not omitted", () => {
    // The row shape is the model's, not the caller's: an unmentioned nullable column
    // still occupies a slot in every VALUES group. That is what keeps rows that differ
    // only in which nullable they mentioned inside ONE grouped statement.
    const driver = new PGliteDriver();
    const operation = route(driver, parityJSchema.parcel, {
      data: [
        { id: 1, label: "one" },
        { id: 2, label: "two", binId: 7 },
      ],
    });
    expect(fragmentContract(driver, operation.compile({}))).toEqual({
      steps: [
        {
          id: "parcel.createMany",
          kind: "write",
          sql: 'INSERT INTO "pj_parcels" ("id", "label", "binId") VALUES ($1, $2, NULL), ($3, $4, $5)',
          params: [1, "one", 2, "two", 7],
          outputs: COUNT_OUTPUT,
          ...NO_BRANCH,
        },
      ],
      outputs: { count: [reference("parcel.createMany", "count")] },
    });
  });

  test("two contiguous shape runs are two statements, in input-run order", () => {
    const driver = new PGliteDriver();
    const operation = route(driver, parityJSchema.autoCrate, {
      data: [
        { id: 30, label: "explicit-high" },
        { id: 20, label: "explicit-low" },
        { label: "generated-first" },
        { label: "generated-second" },
      ],
    });

    expect(fragmentContract(driver, operation.compile({}))).toEqual({
      steps: [
        {
          id: "autoCrate.createMany",
          kind: "write",
          sql: 'INSERT INTO "pj_auto_crates" ("id", "label") VALUES ($1, $2), ($3, $4)',
          params: [30, "explicit-high", 20, "explicit-low"],
          outputs: COUNT_OUTPUT,
          ...NO_BRANCH,
        },
        {
          id: "autoCrate.createMany#1",
          kind: "write",
          sql: 'INSERT INTO "pj_auto_crates" ("label") VALUES ($1), ($2)',
          params: ["generated-first", "generated-second"],
          outputs: COUNT_OUTPUT,
          ...NO_BRANCH,
        },
      ],
      outputs: {
        count: [
          reference("autoCrate.createMany", "count"),
          reference("autoCrate.createMany#1", "count"),
        ],
      },
    });
    // The public count is the SUM the executor resolves from that source list.
    expect(operation.parse({ count: 4 })).toEqual({ count: 4 });
  });

  test("an empty batch plans nothing, compiles nothing, and answers zero", () => {
    const driver = new PGliteDriver();
    const operation = route(driver, parityJSchema.crate, { data: [] });
    expect(operation.planning().steps).toEqual([]);
    const compiled = operation.compile({});
    expect(compiled.steps).toEqual([]);
    expect(compiled.outputs).toEqual({});
    expect(operation.parse(compiled.outputs)).toEqual({ count: 0 });
  });
});

describe("parity J — each dialect's skipDuplicates spelling", () => {
  test("the SQL-leaf dialects append ON CONFLICT DO NOTHING and set no effect", () => {
    // Note the DOUBLE SPACE after INSERT: the skip clause occupies the "or ignore"
    // slot of the insert template, which both these adapters leave empty. Pinned as
    // it is, because a re-plan that normalizes it is still a byte change.
    const dialects = [
      {
        driver: new PGliteDriver(),
        sql: 'INSERT  INTO "pj_crates" ("id", "label") VALUES ($1, $2), ($3, $4), ($5, $6) ON CONFLICT DO NOTHING',
      },
      {
        driver: new SQLite3Driver(),
        sql: 'INSERT  INTO "pj_crates" ("id", "label") VALUES (?, ?), (?, ?), (?, ?) ON CONFLICT DO NOTHING',
      },
    ];
    for (const dialect of dialects) {
      const operation = route(dialect.driver, parityJSchema.crate, {
        data: THREE_ROWS,
        skipDuplicates: true,
      });
      expect(fragmentContract(dialect.driver, operation.compile({}))).toEqual({
        steps: [
          {
            id: "crate.createMany",
            kind: "write",
            sql: dialect.sql,
            params: [1, "one", 2, "two", 3, "three"],
            outputs: COUNT_OUTPUT,
            ...NO_BRANCH,
          },
        ],
        outputs: { count: [reference("crate.createMany", "count")] },
      });
    }
  });

  test("MySQL has no SQL leaf: the run splits per row, each a savepoint effect", () => {
    const driver = new MySQL2Driver();
    const operation = route(driver, parityJSchema.crate, {
      data: THREE_ROWS,
      skipDuplicates: true,
    });
    const perRow = (id: string, params: unknown[]) => ({
      id,
      kind: "write",
      sql: "INSERT INTO `pj_crates` (`id`, `label`) VALUES (?, ?)",
      params,
      outputs: COUNT_OUTPUT,
      expects: null,
      racePin: null,
      onUniqueConflict: "skip",
    });
    expect(fragmentContract(driver, operation.compile({}))).toEqual({
      steps: [
        perRow("crate.createMany", [1, "one"]),
        perRow("crate.createMany#1", [2, "two"]),
        perRow("crate.createMany#2", [3, "three"]),
      ],
      outputs: {
        count: [
          reference("crate.createMany", "count"),
          reference("crate.createMany#1", "count"),
          reference("crate.createMany#2", "count"),
        ],
      },
    });
  });
});

describe("parity J — the RETURNING fold", () => {
  test("a returning driver folds four rows into ONE INSERT … RETURNING", () => {
    const driver = new PGliteDriver();
    const operation = route(driver, parityJSchema.crate, {
      data: [
        { id: 40, label: "first" },
        { id: 10, label: "second" },
        { id: 30, label: "third" },
        { id: 20, label: "fourth" },
      ],
      select: { id: true, label: true },
    });

    expect(fragmentContract(driver, operation.planning())).toEqual({
      steps: [],
      outputs: {},
    });
    expect(fragmentContract(driver, operation.compile({}))).toEqual({
      steps: [
        {
          id: "crate.createManyReturn",
          kind: "write",
          sql: 'INSERT INTO "pj_crates" ("id", "label") VALUES ($1, $2), ($3, $4), ($5, $6), ($7, $8) RETURNING "id" AS "id", "label" AS "label"',
          params: [40, "first", 10, "second", 30, "third", 20, "fourth"],
          outputs: { result: { kind: "rows" } },
          ...NO_BRANCH,
        },
      ],
      outputs: { result: [reference("crate.createManyReturn", "result")] },
    });
  });

  test("a NON-returning driver keeps one INSERT and one refetch per input row", () => {
    const driver = new MySQL2Driver();
    const operation = route(driver, parityJSchema.crate, {
      data: [
        { id: 40, label: "first" },
        { id: 10, label: "second" },
      ],
      select: { id: true, label: true },
    });

    const insert = (id: string, params: unknown[]) => ({
      id,
      kind: "write",
      sql: "INSERT INTO `pj_crates` (`id`, `label`) VALUES (?, ?)",
      params,
      outputs: {},
      ...NO_BRANCH,
    });
    const refetch = (id: string, params: unknown[]) => ({
      id,
      kind: "read",
      // MySQL inlines integer limits, so the `LIMIT 1` is not a bound parameter.
      sql: "SELECT `t0`.`id` AS `id`, `t0`.`label` AS `label` FROM `pj_crates` AS `t0` WHERE `t0`.`id` = ? LIMIT 1",
      params,
      outputs: { result: { kind: "rows" } },
      ...NO_BRANCH,
    });
    expect(fragmentContract(driver, operation.compile({}))).toEqual({
      steps: [
        insert("crate.createReturn.insert", [40, "first"]),
        refetch("crate.createReturn.read", [40]),
        insert("crate.createReturn.insert#1", [10, "second"]),
        refetch("crate.createReturn.read#1", [10]),
      ],
      outputs: {
        result: [
          reference("crate.createReturn.read", "result"),
          reference("crate.createReturn.read#1", "result"),
        ],
      },
    });
  });
});

describe("parity J — the atomic-batch substrate plans nothing either", () => {
  test("the `{count}` arm and the returning arm are byte-identical on a batch-only driver", () => {
    // §4.4 refuses the record SERIES where no interactive transaction exists, so the
    // batch substrate is where a router that behaves differently without one would show.
    const driver = new BatchOnlyPGliteDriver();
    const counting = route(driver, parityJSchema.crate, { data: THREE_ROWS });
    expect(fragmentContract(driver, counting.planning())).toEqual({
      steps: [],
      outputs: {},
    });
    expect(fragmentContract(driver, counting.compile({}))).toEqual({
      steps: [
        {
          id: "crate.createMany",
          kind: "write",
          sql: 'INSERT INTO "pj_crates" ("id", "label") VALUES ($1, $2), ($3, $4), ($5, $6)',
          params: [1, "one", 2, "two", 3, "three"],
          outputs: COUNT_OUTPUT,
          ...NO_BRANCH,
        },
      ],
      outputs: { count: [reference("crate.createMany", "count")] },
    });

    const returning = route(driver, parityJSchema.crate, {
      data: THREE_ROWS,
      select: { id: true, label: true },
    });
    expect(fragmentContract(driver, returning.planning())).toEqual({
      steps: [],
      outputs: {},
    });
    expect(fragmentContract(driver, returning.compile({}))).toEqual({
      steps: [
        {
          id: "crate.createManyReturn",
          kind: "write",
          sql: 'INSERT INTO "pj_crates" ("id", "label") VALUES ($1, $2), ($3, $4), ($5, $6) RETURNING "id" AS "id", "label" AS "label"',
          params: [1, "one", 2, "two", 3, "three"],
          outputs: { result: { kind: "rows" } },
          ...NO_BRANCH,
        },
      ],
      outputs: { result: [reference("crate.createManyReturn", "result")] },
    });
  });
});

describe("parity J — the refusal J1 lifts, verbatim", () => {
  const refusalOf = async (
    args: Record<string, unknown>
  ): Promise<string | undefined> => {
    const client = createClient({
      schema: parityJSchema,
      driver: new PGliteDriver(),
    }) as any;
    return await client.parcel.createMany(args).then(
      () => undefined,
      (thrown: unknown) => (thrown as Error).message
    );
  };

  test("a relation key inside a createMany row is an unknown key today", async () => {
    expect(
      await refusalOf({
        data: [{ id: 1, label: "one", bin: { connect: { id: 9 } } }],
      })
    ).toBe("Validation failed for createMany: Unknown key: bin");
  });

  test("the returning arm refuses it under the SAME public operation name", async () => {
    // `createManyAndReturn` is the internal routed kind, never the diagnostic: both
    // arms answer as the one public family the client called.
    expect(
      await refusalOf({
        data: [{ id: 1, label: "one", bin: { create: { id: 9, name: "b" } } }],
        select: { id: true },
      })
    ).toBe("Validation failed for createMany: Unknown key: bin");
  });

  /** J1 adds a THIRD refusal to this family. Its two live members are pinned here so a
   *  re-sort that changes which one answers first is visible. */
  test("a duplicate-only DEFAULT VALUES row still refuses under skipDuplicates", () => {
    const driver = new PGliteDriver();
    let thrown: unknown;
    try {
      route(driver, parityJSchema.blank, {
        // The row supplies no explicit scalar at all, so skipping duplicates would need
        // a duplicate-only DEFAULT VALUES primitive no dialect portably has.
        data: [{}],
        skipDuplicates: true,
      }).compile({});
    } catch (error) {
      thrown = error;
    }
    expect({
      name: (thrown as Error).constructor.name,
      message: (thrown as Error).message,
    }).toEqual({
      name: "QueryEngineError",
      message:
        "createMany with skipDuplicates cannot include a row with no explicit scalar values; no portable duplicate-only DEFAULT VALUES primitive exists.",
    });
  });
});
