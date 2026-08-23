import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { MySQL2Driver } from "@drivers/mysql2";
import { PGliteDriver } from "@drivers/pglite";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import { validateClientSchemaOrThrow } from "@schema/validation/validator";
import {
  isOperationValueReference,
  type OperationFragment,
  type OperationStep,
  type PlanningFragment,
  type StatementStep,
} from "@src/query-engine/write-engine/OperationFragment";
import { isRecordSeries } from "@src/query-engine/write-engine/record-series";
import { constructRoutedOperation } from "@src/query-engine/write-engine/routing";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { publishedOutputs } from "@tests/fixtures/planning-published";
import { fragmentAtom } from "@tests/fixtures/routed-fragment-atom";
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
 * HOLE CLOSED BY PACKAGE J (it was declared here, unpinned, by Package A). J's keep gate
 * names "scalar AND direct-polymorphic-connect plans are byte-identical", and
 * `parityJSchema` had no polymorphic member — so the whole `bulk-polymorphic-connect`
 * route had no before-picture at all. It does now: the probe steps (one per relation and
 * concrete variant, `FOR UPDATE` in a transaction and guarded in a forced batch), the
 * grouped INSERT's private `(type, id)` values, and the route's own refusal
 * ("Driver '<name>' cannot execute 'createMany' with 'select', 'skipDuplicates', and
 * polymorphic connects…") are pinned below. It is the one path on which `createMany`
 * PLANS anything, which is exactly the fact J2's router keys on.
 *
 * MEASURED AS A TRUE BEFORE-PICTURE, 2026-08-10: the four polymorphic pins were run with
 * `routing.ts` and `validation/model/core/create.ts` restored to their pre-J contents
 * (copied back from a scratchpad snapshot, never `git checkout`), and passed unchanged.
 * J moves nothing on this route — by construction, since its discriminant reads the
 * ORDINARY relation set.
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
        .toOne(() => bin)
        .fields("binId")
        .references("id"),
    })
    .map("pj_parcels");
  const bin = s
    .model({
      id: s.int().id(),
      name: s.string(),
      parcels: s.toMany(() => parcel),
    })
    .map("pj_bins");
  // PACKAGE J closes the hole this file's header declared: `parityJSchema` had no
  // polymorphic member, so the direct-polymorphic BULK CONNECT route — the one path on
  // which `createMany` plans anything — had no before-picture at all. It is half of J's
  // keep gate ("scalar AND direct-polymorphic-connect plans are byte-identical"), and it
  // is also the route J2's discriminant must NOT claim: a row whose only relation work
  // is a polymorphic `connect` stays bulk-compatible.
  const label = s
    .model({ id: s.int().id(), text: s.string() })
    .map("pj_labels");
  const sticker = s
    .model({ id: s.int().id(), text: s.string() })
    .map("pj_stickers");
  const tag = s
    .model({
      id: s.int().id(),
      note: s.string(),
      subject: s.toOne(
        { label: () => label, sticker: () => sticker },
        { values: { label: "pj.label.v1", sticker: "pj.sticker.v1" } }
      ),
    })
    .map("pj_tags");
  // PACKAGE E adds the OTHER half of the same discriminant. `relationBearingRow`
  // is now cardinality-dispatched over the polymorphic set (plan §9.6): a
  // COLLECTION key routes to the record series, because its memberships live in
  // per-variant member junction rows that cannot exist before the owner row does.
  // The twin below is what keeps that widening from silently swallowing `tag`'s
  // grouped route, which is the byte contract this whole file exists to hold.
  const board = s
    .model({
      id: s.int().id(),
      note: s.string(),
      subjects: s.toMany(
        { label: () => label, sticker: () => sticker },
        { values: { label: "pj.blabel.v1", sticker: "pj.bsticker.v1" } }
      ),
    })
    .map("pj_boards");
  return { crate, autoCrate, blank, parcel, bin, label, sticker, tag, board };
})();

hydrateSchemaNames(parityJSchema);
// The polymorphic member needs its storage resolved, which is what the client does on
// construction (`validateClientSchemaOrThrow`); this file builds engines directly.
validateClientSchemaOrThrow(parityJSchema);

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
  return fragmentAtom(
    constructRoutedOperation(engineFor(driver), model, "createMany", args),
    "createMany"
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

function prepared(
  driver: AnyDriver,
  current: StatementStep
): { readonly sql: string; readonly params: unknown } {
  const query = driver._prepare(current.statement);
  return { sql: query.sql, params: normalized(query.params) };
}

function stepContract(driver: AnyDriver, current: OperationStep): unknown {
  if (current.kind === "guard") {
    // Only the direct-polymorphic bulk connect route emits one, and only in BATCH mode
    // (in a transaction the probe's `FOR UPDATE` IS the lock). Every scalar arm below
    // pins its complete step list, so a guard appearing there fails on the list.
    const probe = driver._prepare(current.premise.statement);
    return {
      id: current.id,
      kind: current.kind,
      premise: current.premise.kind,
      sql: probe.sql,
      params: normalized(probe.params),
      failure: current.failure,
    };
  }
  if (current.kind === "recordSeries") {
    return { id: current.id, kind: current.kind };
  }
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
    outputs: normalized(publishedOutputs(fragment)),
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

/**
 * THE DIRECT-POLYMORPHIC BULK CONNECT ROUTE — the half of J's keep gate that had no
 * before-picture (this file's header declared the hole; Package A named it as J's
 * highest-value first addition).
 *
 * It is the ONE `createMany` shape that PLANS anything, and everything about it is
 * cross-ROW: one probe per (relation, concrete variant) covering every row that named
 * that variant, and per-row private `(type, id)` values folded into the ONE grouped
 * INSERT. A router that sent these rows to a record series would turn two probes into
 * three single-row lookups and three INSERTs — plan §5.1 says it must not, and
 * `isRelation` (the ordinary relation set, which excludes polymorphic memberships) is
 * what keeps it out of J2's discriminant.
 *
 * Pinned on both substrates because they differ in exactly one dimension, and it is a
 * dimension a re-route would silently drop: in a transaction the probe's `FOR UPDATE`
 * IS the lock, so no guard is emitted; in a forced batch the probe cannot hold one, so
 * every target gets its own presence guard AHEAD of the write.
 */
describe("parity J — the direct-polymorphic bulk connect route", () => {
  const POLY_ROWS = [
    {
      id: 1,
      note: "a",
      subject: { connect: { type: "label", where: { id: 10 } } },
    },
    {
      id: 2,
      note: "b",
      subject: { connect: { type: "sticker", where: { id: 20 } } },
    },
    {
      id: 3,
      note: "c",
      subject: { connect: { type: "label", where: { id: 11 } } },
    },
  ];
  /** What the two probes answered: every named target exists. */
  const PROBED = {
    "label.find.rows": [{ id: 10 }, { id: 11 }],
    "sticker.find.rows": [{ id: 20 }],
  };
  /** ONE grouped INSERT, with the private `(type, id)` pair per row. */
  const GROUPED_INSERT_PARAMS = [
    1,
    "a",
    "pj.label.v1",
    10,
    2,
    "b",
    "pj.sticker.v1",
    20,
    3,
    "c",
    "pj.label.v1",
    11,
  ];
  const TARGET_MISSING = {
    kind: "nestedWrite",
    message: "Cannot connect relation 'subject': target record was not found.",
    relation: "subject",
    raceable: false,
  };

  test("transaction: one locking probe per variant, and ONE grouped INSERT", () => {
    const driver = new PGliteDriver();
    const operation = route(driver, parityJSchema.tag, { data: POLY_ROWS });

    // TWO probes for THREE rows — the grouping key is (relation, variant), and the two
    // `label` rows share one `OR`-ed lookup. That collapse is the whole route.
    expect(fragmentContract(driver, operation.planning())).toEqual({
      steps: [
        {
          id: "label.find",
          kind: "read",
          sql: 'SELECT "t0"."id" AS "id" FROM "pj_labels" AS "t0" WHERE ("t0"."id" = $1 OR "t0"."id" = $2) FOR UPDATE',
          params: [10, 11],
          outputs: { rows: { kind: "rows" } },
          ...NO_BRANCH,
        },
        {
          id: "sticker.find",
          kind: "read",
          sql: 'SELECT "t0"."id" AS "id" FROM "pj_stickers" AS "t0" WHERE "t0"."id" = $1 FOR UPDATE',
          params: [20],
          outputs: { rows: { kind: "rows" } },
          ...NO_BRANCH,
        },
      ],
      outputs: {
        "label.find.rows": reference("label.find", "rows"),
        "sticker.find.rows": reference("sticker.find", "rows"),
      },
    });
    expect(fragmentContract(driver, operation.compile(PROBED))).toEqual({
      steps: [
        {
          id: "tag.createMany",
          kind: "write",
          sql: 'INSERT INTO "pj_tags" ("id", "note", "subject_type", "subject_id") VALUES ($1, $2, $3, $4), ($5, $6, $7, $8), ($9, $10, $11, $12)',
          params: GROUPED_INSERT_PARAMS,
          outputs: COUNT_OUTPUT,
          ...NO_BRANCH,
        },
      ],
      outputs: { count: [reference("tag.createMany", "count")] },
    });
  });

  test("forced batch: no lock, so each target gets its own guard before the write", () => {
    const driver = new BatchOnlyPGliteDriver();
    const operation = route(driver, parityJSchema.tag, { data: POLY_ROWS });

    expect(fragmentContract(driver, operation.planning())).toEqual({
      steps: [
        {
          id: "label.find",
          kind: "read",
          sql: 'SELECT "t0"."id" AS "id" FROM "pj_labels" AS "t0" WHERE ("t0"."id" = $1 OR "t0"."id" = $2)',
          params: [10, 11],
          outputs: { rows: { kind: "rows" } },
          ...NO_BRANCH,
        },
        {
          id: "sticker.find",
          kind: "read",
          sql: 'SELECT "t0"."id" AS "id" FROM "pj_stickers" AS "t0" WHERE "t0"."id" = $1',
          params: [20],
          outputs: { rows: { kind: "rows" } },
          ...NO_BRANCH,
        },
      ],
      outputs: {
        "label.find.rows": reference("label.find", "rows"),
        "sticker.find.rows": reference("sticker.find", "rows"),
      },
    });
    expect(fragmentContract(driver, operation.compile(PROBED))).toEqual({
      steps: [
        {
          id: "label.guard.exists",
          kind: "guard",
          premise: "exists",
          sql: 'SELECT "t0"."id" AS "id" FROM "pj_labels" AS "t0" WHERE "t0"."id" = $1 ORDER BY "t0"."id" ASC LIMIT $2',
          params: [10, 1],
          failure: TARGET_MISSING,
        },
        {
          id: "label.guard.exists#1",
          kind: "guard",
          premise: "exists",
          sql: 'SELECT "t0"."id" AS "id" FROM "pj_labels" AS "t0" WHERE "t0"."id" = $1 ORDER BY "t0"."id" ASC LIMIT $2',
          params: [11, 1],
          failure: TARGET_MISSING,
        },
        {
          id: "sticker.guard.exists",
          kind: "guard",
          premise: "exists",
          sql: 'SELECT "t0"."id" AS "id" FROM "pj_stickers" AS "t0" WHERE "t0"."id" = $1 ORDER BY "t0"."id" ASC LIMIT $2',
          params: [20, 1],
          failure: TARGET_MISSING,
        },
        {
          id: "tag.createMany",
          kind: "write",
          sql: 'INSERT INTO "pj_tags" ("id", "note", "subject_type", "subject_id") VALUES ($1, $2, $3, $4), ($5, $6, $7, $8), ($9, $10, $11, $12)',
          params: GROUPED_INSERT_PARAMS,
          outputs: COUNT_OUTPUT,
          ...NO_BRANCH,
        },
      ],
      outputs: { count: [reference("tag.createMany", "count")] },
    });
  });

  test("the returning arm keeps the same grouped INSERT and adds RETURNING", () => {
    const driver = new PGliteDriver();
    const operation = route(driver, parityJSchema.tag, {
      data: POLY_ROWS,
      select: { id: true },
    });
    expect(fragmentContract(driver, operation.compile(PROBED))).toEqual({
      steps: [
        {
          id: "tag.createManyReturn",
          kind: "write",
          sql: 'INSERT INTO "pj_tags" ("id", "note", "subject_type", "subject_id") VALUES ($1, $2, $3, $4), ($5, $6, $7, $8), ($9, $10, $11, $12) RETURNING "id" AS "id"',
          params: GROUPED_INSERT_PARAMS,
          outputs: { result: { kind: "rows" } },
          ...NO_BRANCH,
        },
      ],
      outputs: { result: [reference("tag.createManyReturn", "result")] },
    });
  });

  test("a polymorphic TO-ONE payload is NOT a record series, on either arm", () => {
    // J2's discriminant read the ORDINARY relation set; Package E widened it by
    // CARDINALITY, not by set. This is the assertion that keeps the route above
    // reachable at all — and, since E, the negative half of a pair.
    const driver = new PGliteDriver();
    const engine = engineFor(driver);
    const arms = [
      constructRoutedOperation(engine, parityJSchema.tag, "createMany", {
        data: POLY_ROWS,
      }),
      constructRoutedOperation(engine, parityJSchema.tag, "createMany", {
        data: POLY_ROWS,
        select: { id: true },
      }),
    ];
    expect(arms.map((arm) => arm && isRecordSeries(arm))).toEqual([
      false,
      false,
    ]);
  });

  test("a polymorphic COLLECTION payload IS a record series, on either arm", () => {
    // PACKAGE E (§9.6). The positive half of the pair above, in the same file and
    // against the same router, so the asymmetry is one measurement rather than
    // two files that agree by luck. The grouped INSERT cannot express a member
    // junction row, so the whole call goes to the series.
    const driver = new PGliteDriver();
    const engine = engineFor(driver);
    const rows = [
      {
        id: 1,
        note: "a",
        subjects: { connect: [{ type: "label", where: { id: 10 } }] },
      },
    ];
    const arms = [
      constructRoutedOperation(engine, parityJSchema.board, "createMany", {
        data: rows,
      }),
      constructRoutedOperation(engine, parityJSchema.board, "createMany", {
        data: rows,
        select: { id: true },
      }),
    ];
    expect(arms.map((arm) => arm && isRecordSeries(arm))).toEqual([true, true]);

    // …and a SCALAR-ONLY row on the very same model keeps the grouped owner: the
    // discriminant is the ROW's keys, never the model's declaration.
    const scalarOnly = constructRoutedOperation(
      engine,
      parityJSchema.board,
      "createMany",
      { data: [{ id: 2, note: "b" }] }
    );
    expect(scalarOnly && isRecordSeries(scalarOnly)).toBe(false);
  });

  test("the non-returning select+skipDuplicates+polymorphic refusal, verbatim", () => {
    // The route's own refusal (`ManyAndReturnOperation`), which has no other pin. It
    // needs a NON-returning but transaction-capable substrate: on a returning dialect
    // the skipped identities are observable, and on a batch-only one the generic
    // `select`-in-forced-batch refusal answers first.
    let thrown: unknown;
    try {
      route(new MySQL2Driver(), parityJSchema.tag, {
        data: POLY_ROWS,
        skipDuplicates: true,
        select: { id: true },
      });
    } catch (error) {
      thrown = error;
    }
    expect({
      name: (thrown as Error).constructor.name,
      message: (thrown as Error).message,
    }).toEqual({
      name: "TransactionError",
      message:
        "Driver 'mysql2' cannot execute 'createMany' with 'select', 'skipDuplicates', and polymorphic connects because skipped insert identities cannot be observed.",
    });
  });
});

/**
 * WHAT J1 LIFTED, AND THE ONE BOUNDARY IT LEFT.
 *
 * Before Package J both arms answered `Validation failed for createMany: Unknown key:
 * bin` — the root `createMany` row schema was scalars plus a connect-only polymorphic
 * membership, and every ordinary relation key was simply unknown. That pair of pins is
 * replaced here by what the same two payloads do NOW: they route (they no longer refuse),
 * and the router sends them to the record series rather than to either bulk owner.
 *
 * The third member of the family — the portability refusal — is unchanged and stays
 * pinned verbatim below, because it is a different question (a DEFAULT VALUES row under
 * `skipDuplicates`) that J does not touch.
 */
describe("parity J — the refusal J1 lifts", () => {
  const outcomeOf = async (
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

  test("a relation key inside a createMany row is no longer an unknown key", async () => {
    // The payload reaches the database now (nothing was migrated in this compiler-only
    // file, so it fails there) instead of being refused by the schema. The point is
    // which failure it is: the message is no longer a ValidationError about `bin`.
    expect(
      await outcomeOf({
        data: [{ id: 1, label: "one", bin: { connect: { id: 9 } } }],
      })
    ).not.toBe("Validation failed for createMany: Unknown key: bin");
  });

  test("both arms of the lifted payload construct a record series, not a bulk owner", () => {
    const driver = new PGliteDriver();
    const countArm = constructRoutedOperation(
      engineFor(driver),
      parityJSchema.parcel,
      "createMany",
      { data: [{ id: 1, label: "one", bin: { connect: { id: 9 } } }] }
    );
    const returningArm = constructRoutedOperation(
      engineFor(driver),
      parityJSchema.parcel,
      "createMany",
      {
        data: [{ id: 1, label: "one", bin: { create: { id: 9, name: "b" } } }],
        select: { id: true },
      }
    );
    expect([
      countArm && isRecordSeries(countArm),
      returningArm && isRecordSeries(returningArm),
    ]).toEqual([true, true]);
  });

  /** The portability refusal J does NOT touch; pinned so a re-sort that changes which
   *  member of the family answers first is visible. */
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
