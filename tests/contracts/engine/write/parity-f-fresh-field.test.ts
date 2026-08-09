import type { AnyDriver } from "@drivers";
import { MySQL2Driver } from "@drivers/mysql2";
import { PGliteDriver } from "@drivers/pglite";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import type { Model } from "@schema/model";
import { CreateOperation } from "@src/query-engine/write-engine/CreateOperation";
import {
  isOperationValueReference,
  type OperationFragment,
  type PlanningFragment,
} from "@src/query-engine/write-engine/OperationFragment";
import { UnsupportedOperationError } from "@src/query-engine/write-engine/shared";
import { UpdateOperation } from "@src/query-engine/write-engine/UpdateOperation";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

/**
 * PARITY WITNESS — Package F (§6 F, "Publish demanded fresh-record fields").
 *
 * F1 makes `rootReferenced(field)` register demand for ANY referenced scalar field; F2
 * adds demanded database-produced fields to the root `RETURNING`; F3 adds an INSERT-then-
 * SELECT for non-returning substrates; F4 narrows the refusals to the two rows of its
 * table that keep them. Every one of those edits changes what a fresh record's INSERT
 * publishes, so this witness pins what it publishes TODAY.
 *
 * The keep gate F must satisfy is "existing create paths that request no additional field
 * remain byte-identical" and "at most one post-insert read publishes all demanded fields
 * for a root". Both are counted here rather than asserted in prose:
 *
 *   · a demanded GENERATED identity costs THREE statements on every driver class, and the
 *     driver class changes only HOW the root INSERT reports the key — `RETURNING <pk>` +
 *     `firstRowField` on a returning driver in transaction mode, a bare INSERT +
 *     `insertId` otherwise (CreateOperation.ts:2414). Same ids, same order, same count;
 *   · a demanded field that is already KNOWN from the create data costs ONE statement,
 *     because the whole subtree folds into a single write-dependency CTE. F1 must not turn
 *     a knowable value into a published one and buy a second statement with it;
 *   · a demanded field that is NEITHER refuses, at construction, with one of four exact
 *     sentences. §F4's table is what re-sorts those four, so they are the before-picture;
 *   · TWO descendants demanding the same produced field cost ONE `RETURNING` column and
 *     ONE output key, and spend the same reference. F1 fixes the minimal output set "after
 *     all descendants have registered their requests", so a registry that appended per
 *     consumer is exactly what that row catches;
 *   · a relation-free create — no descendant, therefore no demand — is pinned on both a
 *     generated and an application-supplied key. That is F's keep gate stated as bytes.
 *
 * NOT PINNED HERE: F's focused families also name a junction consumer of a produced
 * identity, including RelationJunctionPart.ts:1349's `skipDuplicates` refusal. This schema
 * has no many-to-many member, so neither the accepted junction INSERT's parent parameter
 * nor that refusal has a before-picture in this file.
 *
 * DIMENSIONS PINNED (plan §6 A2's nine): planning IDs/order/SQL/params/outputs (all three
 * shapes plan NOTHING — a fresh record has no row to locate); final IDs and order; final
 * SQL and parameters, byte-level, in three dialect/substrate spellings; expects; race pins
 * (none survive — pinned `null`); exact errors; statement counts, which are the point.
 * Guards do not arise on these shapes and round trips equal the step count.
 *
 * THE CANNOT-RESOLVE CENSUS. §F4 classifies "every K1, K2, and K4 site" by value state,
 * so the family is listed in full — nine live sites, anchored on their `throw` statement
 * as forbidden-shapes-reference.md anchors them, four distinct sentences:
 *   · CreateOperation.ts:1968 — "…for relation '<r>'…". PINNED below, twice: once through
 *     `referencedValue` (a nested create leaf) and once through the connect Part's foreign
 *     key assignment. Both rows reach the SAME site with the same string, so they separate
 *     two payload paths, not two guards;
 *   · CreateOperation.ts:2052 — "…cannot resolve the parent id…". PINNED below. The same
 *     sentence is already pinned at compound-relation-adoption-behavior.ts:318, so this row
 *     is a restatement kept beside its siblings for the census's sake;
 *   · CreateOperation.ts:1647 — the `-v2` before-parent text. PINNED below;
 *   · CreateOperation.ts:884 and :908 — the SAME before-parent text without the `-v2`
 *     prefix, two byte-identical twins inside the bound-polymorphic path (and :908 is a
 *     `QueryEngineError` rather than an `UnsupportedOperationError`). UNPINNED: this schema
 *     has no direct polymorphic edge, and no message could tell the twins apart anyway;
 *   · RecordUpdateCompiler.ts:3161 — the before-ROOT `-v2` text. PINNED below, and also
 *     already pinned at parent-held-lookup-behavior.ts:619;
 *   · RecordUpdateCompiler.ts:815, :840 and :1048 — a fourth, shorter sentence
 *     ("query-engine update cannot resolve referenced field '<f>' for relation '<r>'.")
 *     emitted verbatim at three `QueryEngineError` sites. UNPINNED, and unpinnable as
 *     three: §O2's duplicate-cluster ledger owns separating them first.
 *
 * The shared-primary-key SPLIT is `parity-e-shared-pk.test.ts`'s subject; only its
 * produced-identity leg is pinned below.
 *
 * FALSIFIED 2026-08-09 against `src/query-engine/write-engine/CreateOperation.ts`:
 * dropping the `txMode &&` conjunct from both halves of the identity-capture choice
 * (:2419 and :2433) made the PGlite ATOMIC-BATCH root INSERT emit `RETURNING "id"` with a
 * `firstRowField` output. Exactly the two PGlite-batch legs went red; the PGlite
 * transaction legs, the MySQL2 legs (refused by `supportsReturning`, the other conjunct),
 * the CTE-fold pin, and all five refusals stayed green. The original was restored from a
 * scratchpad copy taken before the edit.
 */

const freshFieldSchema = (() => {
  const hub = s
    .model({
      id: s.int().id().increment(),
      name: s.string(),
      /** A NON-primary-key unique a child edge can reference — the D4 shape. */
      tag: s.string().unique().nullable(),
      spans: s.oneToMany(() => span),
      /** A SECOND consumer of the same produced identity — the double-registration probe. */
      clips: s.oneToMany(() => clip),
      marks: s.oneToMany(() => mark),
      badge: s.oneToOne(() => badge).optional(),
    })
    .map("parity_f_hubs");
  const span = s
    .model({
      id: s.string().id(),
      hubId: s.int().nullable(),
      hub: s
        .manyToOne(() => hub)
        .fields("hubId")
        .references("id")
        .optional(),
    })
    .map("parity_f_spans");
  const clip = s
    .model({
      id: s.string().id(),
      hubId: s.int().nullable(),
      hub: s
        .manyToOne(() => hub)
        .fields("hubId")
        .references("id")
        .optional(),
    })
    .map("parity_f_clips");
  const mark = s
    .model({
      id: s.string().id(),
      hubTag: s.string().nullable(),
      hub: s
        .manyToOne(() => hub)
        .fields("hubTag")
        .references("tag")
        .optional()
        .name("marks"),
    })
    .map("parity_f_marks");
  /** The shared primary key whose value the parent's INSERT produces. */
  const badge = s
    .model({
      hubId: s.int().id(),
      note: s.string(),
      hub: s
        .oneToOne(() => hub)
        .fields("hubId")
        .references("id"),
    })
    .map("parity_f_badges");
  const crate = s
    .model({
      id: s.string().id(),
      slotKey: s.string().unique().nullable(),
      boxes: s.oneToMany(() => box),
    })
    .map("parity_f_crates");
  const box = s
    .model({
      id: s.string().id(),
      crateKey: s.string().nullable(),
      crate: s
        .manyToOne(() => crate)
        .fields("crateKey")
        .references("slotKey")
        .optional(),
    })
    .map("parity_f_boxes");
  return { hub, span, clip, mark, badge, crate, box };
})();

hydrateSchemaNames(freshFieldSchema);

function engineFor(driver: AnyDriver): QueryEngine {
  return new QueryEngine(
    driver,
    createModelRegistry(
      freshFieldSchema,
      createSchemaRegistry(freshFieldSchema)
    )
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
    outputs: normalized(fragment.outputs),
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

// ---------------------------------------------------------------------------
// A produced identity: the same three statements everywhere, one line apart
// ---------------------------------------------------------------------------

for (const substrate of [
  {
    // `supportsReturning` AND transaction mode: the only combination that captures
    // the key from the statement's own RETURNING list.
    name: "PGlite transaction (RETURNING)",
    createDriver: () => new PGliteDriver(),
    quote: (name: string) => `"${name}"`,
    placeholder: (index: number) => `$${index}`,
    intCast: "INTEGER",
    capturesByReturning: true,
    // Only a transaction gets an `expects`: a batch step cannot abort on a
    // postcondition, so the shape is one assertion shorter.
    terminalExpects: CREATE_TERMINAL_FAILURE,
  },
  {
    // The adapter returns, but a batch step's rows are not addressable, so the key
    // comes from the driver's `insertId` scratch instead.
    name: "PGlite atomic batch (insertId)",
    createDriver: () => new BatchOnlyPGliteDriver(),
    quote: (name: string) => `"${name}"`,
    placeholder: (index: number) => `$${index}`,
    intCast: "INTEGER",
    capturesByReturning: false,
    terminalExpects: null,
  },
  {
    // A transaction, but `supportsReturning: false` — the other half of the same
    // conjunct, reached from the adapter rather than from the substrate.
    name: "MySQL2 (insertId)",
    createDriver: () => new MySQL2Driver(),
    quote: (name: string) => `\`${name}\``,
    placeholder: () => "?",
    intCast: "SIGNED",
    capturesByReturning: false,
    terminalExpects: CREATE_TERMINAL_FAILURE,
  },
]) {
  const q = substrate.quote;
  const p = substrate.placeholder;
  const identityOutput = substrate.capturesByReturning
    ? { kind: "firstRowField", field: "id" }
    : { kind: "insertId" };
  const returningClause = substrate.capturesByReturning
    ? ` RETURNING ${q("id")} AS ${q("id")}`
    : "";

  describe(`parity F — a demanded produced identity (${substrate.name})`, () => {
    test("costs three statements, and only the root INSERT's reporting channel moves", () => {
      const driver = substrate.createDriver();
      const operation = new CreateOperation(
        engineFor(driver),
        freshFieldSchema.hub as Model<any>,
        {
          data: { name: "H", tag: "t", spans: { create: { id: "s1" } } },
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
            // `supportsReturning && txMode` decides this one clause and this one
            // output kind (CreateOperation.ts:2414-2436). Nothing else moves.
            sql: `INSERT INTO ${q("parity_f_hubs")} (${q("name")}, ${q("tag")}) VALUES (${p(1)}, ${p(2)})${returningClause}`,
            params: ["H", "t"],
            outputs: { id: identityOutput },
            expects: null,
            racePin: null,
            onUniqueConflict: null,
          },
          {
            id: "span.create",
            kind: "write",
            sql: `INSERT INTO ${q("parity_f_spans")} (${q("id")}, ${q("hubId")}) VALUES (${p(1)}, CAST(${p(2)} AS ${substrate.intCast}))`,
            params: ["s1", reference("hub.create", "id")],
            outputs: {},
            expects: null,
            racePin: null,
            onUniqueConflict: null,
          },
          {
            // THE ONE post-insert read. §F's keep gate caps a lifted root at one; today
            // it is the terminal projection, and it spends the SAME reference the child
            // spent rather than re-deriving the key.
            id: "hub.select",
            kind: "read",
            sql: `SELECT ${q("t0")}.${q("id")} AS ${q("id")} FROM ${q("parity_f_hubs")} AS ${q("t0")} WHERE ${q("t0")}.${q("id")} = CAST(${p(1)} AS ${substrate.intCast}) LIMIT 1`,
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

    test("TWO consumers spend ONE published field: one RETURNING column, one output", () => {
      const driver = substrate.createDriver();
      const operation = new CreateOperation(
        engineFor(driver),
        freshFieldSchema.hub as Model<any>,
        {
          data: {
            name: "H",
            tag: "t",
            spans: { create: { id: "s1" } },
            clips: { create: { id: "k1" } },
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
            // ONE clause and ONE output key, with two descendants demanding the field.
            // A demand registry that appended per consumer would double both.
            sql: `INSERT INTO ${q("parity_f_hubs")} (${q("name")}, ${q("tag")}) VALUES (${p(1)}, ${p(2)})${returningClause}`,
            params: ["H", "t"],
            outputs: { id: identityOutput },
            expects: null,
            racePin: null,
            onUniqueConflict: null,
          },
          {
            id: "span.create",
            kind: "write",
            sql: `INSERT INTO ${q("parity_f_spans")} (${q("id")}, ${q("hubId")}) VALUES (${p(1)}, CAST(${p(2)} AS ${substrate.intCast}))`,
            params: ["s1", reference("hub.create", "id")],
            outputs: {},
            expects: null,
            racePin: null,
            onUniqueConflict: null,
          },
          {
            id: "clip.create",
            kind: "write",
            sql: `INSERT INTO ${q("parity_f_clips")} (${q("id")}, ${q("hubId")}) VALUES (${p(1)}, CAST(${p(2)} AS ${substrate.intCast}))`,
            // The SAME reference, not a second one.
            params: ["k1", reference("hub.create", "id")],
            outputs: {},
            expects: null,
            racePin: null,
            onUniqueConflict: null,
          },
          {
            id: "hub.select",
            kind: "read",
            sql: `SELECT ${q("t0")}.${q("id")} AS ${q("id")} FROM ${q("parity_f_hubs")} AS ${q("t0")} WHERE ${q("t0")}.${q("id")} = CAST(${p(1)} AS ${substrate.intCast}) LIMIT 1`,
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

    test("KEEP GATE: a relation-free create on a GENERATED key asks for nothing extra", () => {
      const driver = substrate.createDriver();
      const operation = new CreateOperation(
        engineFor(driver),
        freshFieldSchema.hub as Model<any>,
        { data: { name: "H" }, select: { name: true } }
      );
      expect(fragmentContract(driver, operation.planning())).toEqual(
        EMPTY_PLANNING
      );
      // With no descendant there is no demand, so the key is published only where the
      // substrate needs it to address the terminal read at all.
      expect(fragmentContract(driver, operation.compile({}))).toEqual(
        substrate.capturesByReturning
          ? {
              steps: [
                {
                  id: "hub.create",
                  kind: "write",
                  sql: `INSERT INTO ${q("parity_f_hubs")} (${q("name")}, ${q("tag")}) VALUES (${p(1)}, NULL) RETURNING ${q("name")} AS ${q("name")}`,
                  params: ["H"],
                  outputs: { result: { kind: "rows" } },
                  expects: CREATE_TERMINAL_FAILURE,
                  racePin: null,
                  onUniqueConflict: null,
                },
              ],
              outputs: { result: reference("hub.create", "result") },
            }
          : {
              steps: [
                {
                  id: "hub.create",
                  kind: "write",
                  sql: `INSERT INTO ${q("parity_f_hubs")} (${q("name")}, ${q("tag")}) VALUES (${p(1)}, NULL)`,
                  params: ["H"],
                  outputs: { id: { kind: "insertId" } },
                  expects: null,
                  racePin: null,
                  onUniqueConflict: null,
                },
                {
                  id: "hub.select",
                  kind: "read",
                  sql: `SELECT ${q("t0")}.${q("name")} AS ${q("name")} FROM ${q("parity_f_hubs")} AS ${q("t0")} WHERE ${q("t0")}.${q("id")} = CAST(${p(1)} AS ${substrate.intCast}) LIMIT 1`,
                  params: [reference("hub.create", "id")],
                  outputs: { result: { kind: "rows" } },
                  expects: substrate.terminalExpects,
                  racePin: null,
                  onUniqueConflict: null,
                },
              ],
              outputs: { result: reference("hub.select", "result") },
            }
      );
    });

    test("KEEP GATE: a relation-free create on an APPLICATION-supplied key publishes none", () => {
      const driver = substrate.createDriver();
      const operation = new CreateOperation(
        engineFor(driver),
        freshFieldSchema.crate as Model<any>,
        { data: { id: "c1" }, select: { id: true } }
      );
      expect(fragmentContract(driver, operation.compile({}))).toEqual(
        substrate.capturesByReturning
          ? {
              steps: [
                {
                  id: "crate.create",
                  kind: "write",
                  sql: `INSERT INTO ${q("parity_f_crates")} (${q("id")}, ${q("slotKey")}) VALUES (${p(1)}, NULL) RETURNING ${q("id")} AS ${q("id")}`,
                  params: ["c1"],
                  outputs: { result: { kind: "rows" } },
                  expects: CREATE_TERMINAL_FAILURE,
                  racePin: null,
                  onUniqueConflict: null,
                },
              ],
              outputs: { result: reference("crate.create", "result") },
            }
          : {
              steps: [
                {
                  id: "crate.create",
                  kind: "write",
                  sql: `INSERT INTO ${q("parity_f_crates")} (${q("id")}, ${q("slotKey")}) VALUES (${p(1)}, NULL)`,
                  params: ["c1"],
                  // NO output at all: the key was the caller's, so nothing is captured.
                  outputs: {},
                  expects: null,
                  racePin: null,
                  onUniqueConflict: null,
                },
                {
                  id: "crate.select",
                  kind: "read",
                  sql: `SELECT ${q("t0")}.${q("id")} AS ${q("id")} FROM ${q("parity_f_crates")} AS ${q("t0")} WHERE ${q("t0")}.${q("id")} = ${p(1)} LIMIT 1`,
                  params: ["c1"],
                  outputs: { result: { kind: "rows" } },
                  expects: substrate.terminalExpects,
                  racePin: null,
                  onUniqueConflict: null,
                },
              ],
              outputs: { result: reference("crate.select", "result") },
            }
      );
    });

    test("a shared primary key rides the same produced reference, at the same count", () => {
      const driver = substrate.createDriver();
      const operation = new CreateOperation(
        engineFor(driver),
        freshFieldSchema.badge as Model<any>,
        {
          data: { note: "n", hub: { create: { name: "H" } } },
          select: { hubId: true },
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
            // The omitted nullable unique is spelled as an explicit NULL, not skipped.
            sql: `INSERT INTO ${q("parity_f_hubs")} (${q("name")}, ${q("tag")}) VALUES (${p(1)}, NULL)${returningClause}`,
            params: ["H"],
            outputs: { id: identityOutput },
            expects: null,
            racePin: null,
            onUniqueConflict: null,
          },
          {
            id: "badge.create",
            kind: "write",
            sql: `INSERT INTO ${q("parity_f_badges")} (${q("hubId")}, ${q("note")}) VALUES (CAST(${p(1)} AS ${substrate.intCast}), ${p(2)})`,
            params: [reference("hub.create", "id"), "n"],
            outputs: {},
            expects: null,
            racePin: null,
            onUniqueConflict: null,
          },
          {
            id: "badge.select",
            kind: "read",
            sql: `SELECT ${q("t0")}.${q("hubId")} AS ${q("hubId")} FROM ${q("parity_f_badges")} AS ${q("t0")} WHERE ${q("t0")}.${q("hubId")} = CAST(${p(1)} AS ${substrate.intCast}) LIMIT 1`,
            params: [reference("hub.create", "id")],
            outputs: { result: { kind: "rows" } },
            expects: substrate.terminalExpects,
            racePin: null,
            onUniqueConflict: null,
          },
        ],
        outputs: { result: reference("badge.select", "result") },
      });
    });
  });
}

// ---------------------------------------------------------------------------
// A knowable non-primary-key referenced field: ONE statement, and it must stay one
// ---------------------------------------------------------------------------

describe("parity F — a referenced field already known from the create data", () => {
  test("costs one statement: the child INSERT folds into the root's CTE", () => {
    const driver = new PGliteDriver();
    const operation = new CreateOperation(
      engineFor(driver),
      freshFieldSchema.hub as Model<any>,
      {
        data: { name: "H", tag: "t", marks: { create: { id: "m1" } } },
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
          // `tag` is spent TWICE as the same literal — once as the record's own
          // column, once as the child's foreign key. A demand-driven publication that
          // re-read it through the root's RETURNING would buy a second statement for
          // a value construction already had.
          sql: 'WITH "__viborm_mutation" AS (INSERT INTO "parity_f_hubs" ("name", "tag") VALUES ($1, $2) RETURNING "id", "name", "tag"), "__viborm_write_0" AS (INSERT INTO "parity_f_marks" ("id", "hubTag") VALUES ($3, CAST($4 AS TEXT))) SELECT "t0"."id" AS "id" FROM "__viborm_mutation" AS "t0"',
          params: ["H", "t", "m1", "t"],
          outputs: { result: { kind: "rows" } },
          expects: CREATE_TERMINAL_FAILURE,
          racePin: null,
          onUniqueConflict: null,
        },
      ],
      outputs: { result: reference("hub.create", "result") },
    });
  });
});

// ---------------------------------------------------------------------------
// The cannot-resolve family, verbatim, one payload per site
// ---------------------------------------------------------------------------

describe("parity F — the cannot-resolve refusals §F4 re-sorts", () => {
  const refusal = (build: () => unknown): { name: string; message: string } => {
    let thrown: unknown;
    try {
      build();
    } catch (error) {
      thrown = error;
    }
    if (!(thrown instanceof UnsupportedOperationError)) {
      throw new Error(
        `Expected UnsupportedOperationError, got ${String(thrown)}`
      );
    }
    return { name: thrown.name, message: thrown.message };
  };

  const hubCreate = (relations: Record<string, unknown>) => () =>
    new CreateOperation(
      engineFor(new PGliteDriver()),
      freshFieldSchema.hub as Model<any>,
      { data: { name: "H", ...relations } }
    );

  test.each([
    [
      // CreateOperation.referencedValue — a child-held leaf's own FK column. This row and
      // the next reach the SAME site (:1969) by two payload paths; the message cannot tell
      // them apart, so the labels carry the distinction.
      "a nested create leaf",
      hubCreate({ marks: { create: { id: "m1" } } }),
      "query-engine-v2 create cannot resolve referenced field 'tag' for relation 'marks': it is neither this record's primary key nor a knowable value in its own create data.",
    ],
    [
      // Same site, reached through the connect Part's FK assignment.
      "a connect leaf",
      hubCreate({ marks: { connect: { id: "m1" } } }),
      "query-engine-v2 create cannot resolve referenced field 'tag' for relation 'marks': it is neither this record's primary key nor a knowable value in its own create data.",
    ],
    [
      // CreateOperation.referencedParentSource — the whole-value source an adopt Part
      // consumes, which spells the same fact differently.
      "a connectOrCreate leaf",
      hubCreate({
        marks: {
          connectOrCreate: { where: { id: "m1" }, create: { id: "m1" } },
        },
      }),
      "query-engine-v2 create cannot resolve the parent id for relation 'marks': referenced field 'tag' is neither this record's primary key nor a knowable value in its own create data.",
    ],
    [
      // CreateOperation.targetReferencedValue — the BEFORE-parent target's value,
      // consumed by the record whose FK points at it.
      "a before-parent target under a create root",
      () =>
        new CreateOperation(
          engineFor(new PGliteDriver()),
          freshFieldSchema.box as Model<any>,
          { data: { id: "b1", crate: { create: { id: "c1" } } } }
        ),
      "query-engine-v2 create cannot resolve referenced field 'slotKey' for the before-parent target of relation 'crate': it is neither that record's primary key nor a knowable value in its own create data.",
    ],
    [
      // RecordUpdateCompiler.beforeTargetReferencedValue — the same fact at an update
      // root, where the enclosing statement is an UPDATE rather than an INSERT.
      "a before-root target under an update root",
      () =>
        new UpdateOperation(
          engineFor(new PGliteDriver()),
          freshFieldSchema.box as Model<any>,
          {
            where: { id: "b1" },
            data: { crate: { create: { id: "c1" } } },
            select: { id: true },
          }
        ),
      "query-engine-v2 update cannot resolve referenced field 'slotKey' for the before-root target of relation 'crate': it is neither that record's primary key nor a knowable value in its own create data.",
    ],
  ])("%s refuses at construction", (_label, build, message) => {
    expect(refusal(build)).toEqual({
      name: "UnsupportedOperationError",
      message,
    });
  });
});
