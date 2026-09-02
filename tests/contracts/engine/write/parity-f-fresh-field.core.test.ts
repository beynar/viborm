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
import { UnsupportedOperationError } from "@src/query-engine/write-engine/shared";
import { UpdateOperation } from "@src/query-engine/write-engine/UpdateOperation";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { publishedOutputs } from "@tests/fixtures/planning-published";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

class TransactionPlanningDriver extends PlanningDriver {
  constructor() {
    super("postgresql");
  }
}

class BatchPlanningDriver extends PlanningDriver {
  constructor() {
    super("postgresql", {
      supportsTransactions: false,
      supportsBatch: true,
    });
  }
}

class MySQLPlanningDriver extends PlanningDriver {
  constructor() {
    super("mysql", { driverName: "mysql2" });
  }
}

const PGliteDriver = TransactionPlanningDriver;
const BatchOnlyPGliteDriver = BatchPlanningDriver;
const MySQL2Driver = MySQLPlanningDriver;

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
 *   · a demanded GENERATED identity costs THREE statements on a non-returning driver
 *     that must carry the value BETWEEN statements. PostgreSQL publishes through the
 *     producer's own `RETURNING <pk>` + `firstRowField` on both execution substrates;
 *     Package M first enabled the fold in transaction mode; the generated-output pass
 *     then made the same exact PostgreSQL fold available in batch mode. The value no
 *     longer travels between statements — see `foldedOneChild` / `foldedTwoChildren`
 *     below and `mutation-dependency-fold.test.ts`. What F pins is untouched:
 *     the same single published field, the same one `RETURNING` column for two consumers,
 *     the same destination cast at the same column. The three-statement form remains
 *     asserted here on the non-returning MySQL leg and on three dialects in
 *     `parity-m-create-dag.core.test.ts`;
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
 * THE JUNCTION CONSUMER (Package A's unpinned hole, closed 2026-08-10 by Package F). The
 * `hub` ⇄ `wire` many-to-many below gives the join row a before-picture: a junction target
 * whose own key is produced spends the SAME reference the join row spends, and the whole
 * arm is three statements. `RelationJunctionPart.ts:1374`'s `skipDuplicates` refusal is
 * still not reachable from this schema — `wire` declares one unique, which E6.8 rewrites
 * as an adopt — and `junction-skip-adoption` owns that shape.
 *
 * DIMENSIONS PINNED (plan §6 A2's nine): planning IDs/order/SQL/params/outputs (all three
 * shapes plan NOTHING — a fresh record has no row to locate); final IDs and order; final
 * SQL and parameters, byte-level, in three dialect/substrate spellings; expects; race pins
 * (none survive — pinned `null`); exact errors; statement counts, which are the point.
 * Guards do not arise on these shapes and round trips equal the step count.
 *
 * THE CANNOT-RESOLVE CENSUS, re-anchored 2026-08-10 at the Package F commit. §F4
 * classified "every K1, K2, and K4 site" by value state; the sites all SURVIVE, and what
 * changed is which value states reach them. Every payload below is now the KEEP row of
 * that table — an omitted NULLABLE unique, which the parse boundary supplies as an
 * explicit `null` — because the DATABASE-PRODUCED row publishes instead of refusing
 * (`fresh-produced-field`). Nine live sites, anchored on their `throw` statement as
 * forbidden-shapes-reference.md anchors them, four distinct sentences:
 *   · CreateOperation.ts:2014 — "…for relation '<r>'…". PINNED below, twice: once through
 *     `referencedValue` (a nested create leaf) and once through the connect Part's foreign
 *     key assignment. Both rows reach the SAME site with the same string, so they separate
 *     two payload paths, not two guards;
 *   · CreateOperation.ts:2098 — "…cannot resolve the parent id…". PINNED below. The same
 *     sentence is already pinned at compound-relation-adoption-behavior.ts:318, so this row
 *     is a restatement kept beside its siblings for the census's sake;
 *   · CreateOperation.ts:1693 — the `-v2` before-parent text. PINNED below;
 *   · CreateOperation.ts:912 and :936 — the SAME before-parent text without the `-v2`
 *     prefix, two byte-identical twins inside the bound-polymorphic path (and :936 is a
 *     `QueryEngineError` rather than an `UnsupportedOperationError`). UNPINNED: this schema
 *     has no direct polymorphic edge, and no message could tell the twins apart anyway;
 *   · RecordUpdateCompiler.ts:3202 — the before-ROOT `-v2` text. PINNED below, and also
 *     already pinned at parent-held-lookup-behavior.ts:619;
 *   · RecordUpdateCompiler.ts:847, :872 and :1072 — a fourth, shorter sentence
 *     ("query-engine update cannot resolve referenced field '<f>' for relation '<r>'.")
 *     emitted verbatim at three `QueryEngineError` sites. UNPINNED, and unpinnable as
 *     three: §O2's duplicate-cluster ledger owns separating them first.
 *
 * ONE SITE LEFT THE CENSUS in Package F, and it is named here because this file's job is
 * to hold the family: `RelationJunctionPart.ts:1862` — "create-through-junction … requires
 * the target primary key in the create data" — was measured UNREACHABLE and is now a
 * `QueryEngineError` describing an internal invariant. `planNestedCreateIdentity` is total
 * over a single-member primary key, and `getRequiredSinglePrimaryKeyField` guarantees the
 * junction target has one. The write-engine census is unchanged at 22 because Package F
 * also ADDED one batch-substrate publication refusal in `producedReference`; the later
 * generated-output segmentation pass retired that broad boundary for default operations.
 *
 * The shared-primary-key SPLIT is `parity-e-shared-pk.test.ts`'s subject; only its
 * produced-identity leg is pinned below.
 *
 * RE-BASELINED 2026-08-14: the generated-output pass deliberately made the former
 * falsification true. PostgreSQL batch roots now emit their own `RETURNING`, use a
 * `firstRowField`, and take the exact CTE fold where available. Transaction expectations
 * remain rollback-enforced; batch folds omit transaction-only postconditions. The
 * non-returning MySQL control is unchanged.
 */

const freshFieldSchema = (() => {
  const hub = s
    .model({
      id: s.int().id().increment(),
      name: s.string(),
      /** A NON-primary-key unique a child edge can reference — the D4 shape. */
      tag: s.string().unique().nullable(),
      spans: s.toMany(() => span),
      /** A SECOND consumer of the same produced identity — the double-registration probe. */
      clips: s.toMany(() => clip),
      marks: s.toMany(() => mark).name("marks"),
      badge: s.toOne(() => badge),
      /** The junction consumer of a produced identity (Package A's unpinned hole). */
      wires: s.toMany(() => wire),
    })
    .map("parity_f_hubs");
  const wire = s
    .model({
      id: s.int().id().increment(),
      label: s.string().unique(),
      hubs: s.toMany(() => hub),
      pins: s.toMany(() => pin),
    })
    .map("parity_f_wires");
  /** A grandchild, so the junction arm is a delegated SUBTREE and not a folded leaf. */
  const pin = s
    .model({
      id: s.string().id(),
      wireId: s.int(),
      wire: s
        .toOne(() => wire)
        .fields("wireId")
        .references("id"),
    })
    .map("parity_f_pins");
  const span = s
    .model({
      id: s.string().id(),
      hubId: s.int().nullable(),
      hub: s
        .toOne(() => hub)
        .fields("hubId")
        .references("id"),
    })
    .map("parity_f_spans");
  const clip = s
    .model({
      id: s.string().id(),
      hubId: s.int().nullable(),
      hub: s
        .toOne(() => hub)
        .fields("hubId")
        .references("id"),
    })
    .map("parity_f_clips");
  const mark = s
    .model({
      id: s.string().id(),
      hubTag: s.string().nullable(),
      hub: s
        .toOne(() => hub)
        .fields("hubTag")
        .references("tag")
        .name("marks"),
    })
    .map("parity_f_marks");
  /** The shared primary key whose value the parent's INSERT produces. */
  const badge = s
    .model({
      hubId: s.int().id(),
      note: s.string(),
      hub: s
        .toOne(() => hub)
        .fields("hubId")
        .references("id"),
    })
    .map("parity_f_badges");
  const crate = s
    .model({
      id: s.string().id(),
      slotKey: s.string().unique().nullable(),
      boxes: s.toMany(() => box),
    })
    .map("parity_f_crates");
  const box = s
    .model({
      id: s.string().id(),
      crateKey: s.string().nullable(),
      crate: s
        .toOne(() => crate)
        .fields("crateKey")
        .references("slotKey"),
    })
    .map("parity_f_boxes");
  return { hub, span, clip, mark, badge, crate, box, wire, pin };
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
    outputs: normalized(publishedOutputs(fragment)),
  };
}

const EMPTY_PLANNING = { steps: [], outputs: {} };

/**
 * PACKAGE M's re-baseline, in one place so the two shapes it moved are legible
 * side by side. On the ONE substrate whose `WITH` accepts a data-modifying
 * statement, the three (and four) statements below are one: the reference the
 * child spends is lowered to `(SELECT "id" FROM "__viborm_mutation")` and Phase
 * 8.2's tree fold merges the arms. Everything F pins is still here — the demand
 * registry still publishes ONE field for two consumers (one `RETURNING` column
 * in the first arm, spent twice), the destination cast still wraps the value at
 * the child's own column — it is now spelled inside one command instead of
 * across three. The non-returning substrate keeps the series verbatim, and
 * `parity-m-create-dag.core.test.ts` pins it on three dialects.
 */
const CREATE_TERMINAL_FAILURE = {
  kind: "exactlyOneRow",
  failure: {
    kind: "query",
    message: "query-engine-v2 create terminal read expected exactly one row.",
    raceable: false,
  },
};

function foldedOneChild(
  terminalExpects: typeof CREATE_TERMINAL_FAILURE | null
) {
  return {
    steps: [
      {
        id: "hub.create",
        kind: "write",
        sql: 'WITH "__viborm_mutation" AS (INSERT INTO "public"."parity_f_hubs" ("name", "tag") VALUES ($1, $2) RETURNING "id", "name", "tag"), "__viborm_write_0" AS (INSERT INTO "public"."parity_f_spans" ("id", "hubId") VALUES ($3, CAST((SELECT "id" FROM "__viborm_mutation") AS INTEGER))) SELECT "t0"."id" AS "id" FROM "__viborm_mutation" AS "t0"',
        params: ["H", "t", "s1"],
        outputs: { result: { kind: "rows" } },
        expects: terminalExpects,
        racePin: null,
        onUniqueConflict: null,
      },
    ],
    outputs: { result: { ref: "hub.create.result" } },
  };
}

function foldedTwoChildren(
  terminalExpects: typeof CREATE_TERMINAL_FAILURE | null
) {
  return {
    steps: [
      {
        id: "hub.create",
        kind: "write",
        // ONE `RETURNING` list, and the same CTE column read by BOTH arms — the
        // fold spends the published field twice exactly as the series did.
        sql: 'WITH "__viborm_mutation" AS (INSERT INTO "public"."parity_f_hubs" ("name", "tag") VALUES ($1, $2) RETURNING "id", "name", "tag"), "__viborm_write_0" AS (INSERT INTO "public"."parity_f_spans" ("id", "hubId") VALUES ($3, CAST((SELECT "id" FROM "__viborm_mutation") AS INTEGER))), "__viborm_write_1" AS (INSERT INTO "public"."parity_f_clips" ("id", "hubId") VALUES ($4, CAST((SELECT "id" FROM "__viborm_mutation") AS INTEGER))) SELECT "t0"."id" AS "id" FROM "__viborm_mutation" AS "t0"',
        params: ["H", "t", "s1", "k1"],
        outputs: { result: { kind: "rows" } },
        expects: terminalExpects,
        racePin: null,
        onUniqueConflict: null,
      },
    ],
    outputs: { result: { ref: "hub.create.result" } },
  };
}

// ---------------------------------------------------------------------------
// A produced identity: one CTE statement wherever PostgreSQL can spell it in
// the command, and three statements on the non-returning control.
// ---------------------------------------------------------------------------

for (const substrate of [
  {
    // PostgreSQL captures the key from the producer's own RETURNING list.
    name: "PostgreSQL transaction plan (RETURNING)",
    createDriver: () => new PGliteDriver(),
    quote: (name: string) => `"${name}"`,
    // A persistent table, as opposed to a column/alias/CTE name: PostgreSQL
    // renders it schema-qualified, unbound MySQL2 renders it bare.
    table: (name: string) => `"public"."${name}"`,
    placeholder: (index: number) => `$${index}`,
    intCast: "INTEGER",
    capturesByReturning: true,
    // PostgreSQL accepts a data-modifying statement inside this fold.
    foldsCteWithMutations: true,
    // Only a transaction gets an `expects`: a batch step cannot abort on a
    // postcondition, so the shape is one assertion shorter.
    terminalExpects: CREATE_TERMINAL_FAILURE,
  },
  {
    // Batch execution uses the same exact PostgreSQL RETURNING and CTE fold. It omits
    // only the transaction-owned terminal postcondition.
    name: "PostgreSQL atomic-batch plan (RETURNING + CTE fold)",
    createDriver: () => new BatchOnlyPGliteDriver(),
    quote: (name: string) => `"${name}"`,
    table: (name: string) => `"public"."${name}"`,
    placeholder: (index: number) => `$${index}`,
    intCast: "INTEGER",
    capturesByReturning: true,
    foldsCteWithMutations: true,
    terminalExpects: null,
  },
  {
    // A transaction, but `supportsReturning: false` — the other half of the same
    // conjunct, reached from the adapter rather than from the substrate.
    name: "MySQL2 (insertId)",
    createDriver: () => new MySQL2Driver(),
    quote: (name: string) => `\`${name}\``,
    table: (name: string) => `\`${name}\``,
    placeholder: () => "?",
    intCast: "SIGNED",
    capturesByReturning: false,
    // MySQL CTEs are read-only.
    foldsCteWithMutations: false,
    terminalExpects: CREATE_TERMINAL_FAILURE,
  },
]) {
  const q = substrate.quote;
  const t = substrate.table;
  const p = substrate.placeholder;
  const identityOutput = substrate.capturesByReturning
    ? { kind: "firstRowField", field: "id" }
    : { kind: "insertId" };
  const returningClause = substrate.capturesByReturning
    ? ` RETURNING ${q("id")} AS ${q("id")}`
    : "";

  describe(`parity F — a demanded produced identity (${substrate.name})`, () => {
    test("uses one exact PostgreSQL CTE fold or the non-returning three-statement transport", () => {
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
      if (substrate.foldsCteWithMutations) {
        expect(fragmentContract(driver, operation.compile({}))).toEqual(
          foldedOneChild(substrate.terminalExpects)
        );
        return;
      }
      expect(fragmentContract(driver, operation.compile({}))).toEqual({
        steps: [
          {
            id: "hub.create",
            kind: "write",
            // Provider RETURNING capability decides this clause and output kind.
            // The non-returning control below keeps insertId transport.
            sql: `INSERT INTO ${t("parity_f_hubs")} (${q("name")}, ${q("tag")}) VALUES (${p(1)}, ${p(2)})${returningClause}`,
            params: ["H", "t"],
            outputs: { id: identityOutput },
            expects: null,
            racePin: null,
            onUniqueConflict: null,
          },
          {
            id: "span.create",
            kind: "write",
            sql: `INSERT INTO ${t("parity_f_spans")} (${q("id")}, ${q("hubId")}) VALUES (${p(1)}, CAST(${p(2)} AS ${substrate.intCast}))`,
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
            sql: `SELECT ${q("t0")}.${q("id")} AS ${q("id")} FROM ${t("parity_f_hubs")} AS ${q("t0")} WHERE ${q("t0")}.${q("id")} = CAST(${p(1)} AS ${substrate.intCast}) LIMIT 1`,
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
      if (substrate.foldsCteWithMutations) {
        expect(fragmentContract(driver, operation.compile({}))).toEqual(
          foldedTwoChildren(substrate.terminalExpects)
        );
        return;
      }
      expect(fragmentContract(driver, operation.compile({}))).toEqual({
        steps: [
          {
            id: "hub.create",
            kind: "write",
            // ONE clause and ONE output key, with two descendants demanding the field.
            // A demand registry that appended per consumer would double both.
            sql: `INSERT INTO ${t("parity_f_hubs")} (${q("name")}, ${q("tag")}) VALUES (${p(1)}, ${p(2)})${returningClause}`,
            params: ["H", "t"],
            outputs: { id: identityOutput },
            expects: null,
            racePin: null,
            onUniqueConflict: null,
          },
          {
            id: "span.create",
            kind: "write",
            sql: `INSERT INTO ${t("parity_f_spans")} (${q("id")}, ${q("hubId")}) VALUES (${p(1)}, CAST(${p(2)} AS ${substrate.intCast}))`,
            params: ["s1", reference("hub.create", "id")],
            outputs: {},
            expects: null,
            racePin: null,
            onUniqueConflict: null,
          },
          {
            id: "clip.create",
            kind: "write",
            sql: `INSERT INTO ${t("parity_f_clips")} (${q("id")}, ${q("hubId")}) VALUES (${p(1)}, CAST(${p(2)} AS ${substrate.intCast}))`,
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
            sql: `SELECT ${q("t0")}.${q("id")} AS ${q("id")} FROM ${t("parity_f_hubs")} AS ${q("t0")} WHERE ${q("t0")}.${q("id")} = CAST(${p(1)} AS ${substrate.intCast}) LIMIT 1`,
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
                  sql: `INSERT INTO ${t("parity_f_hubs")} (${q("name")}, ${q("tag")}) VALUES (${p(1)}, NULL) RETURNING ${q("name")} AS ${q("name")}`,
                  params: ["H"],
                  outputs: { result: { kind: "rows" } },
                  expects: substrate.terminalExpects,
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
                  sql: `INSERT INTO ${t("parity_f_hubs")} (${q("name")}, ${q("tag")}) VALUES (${p(1)}, NULL)`,
                  params: ["H"],
                  outputs: { id: { kind: "insertId" } },
                  expects: null,
                  racePin: null,
                  onUniqueConflict: null,
                },
                {
                  id: "hub.select",
                  kind: "read",
                  sql: `SELECT ${q("t0")}.${q("name")} AS ${q("name")} FROM ${t("parity_f_hubs")} AS ${q("t0")} WHERE ${q("t0")}.${q("id")} = CAST(${p(1)} AS ${substrate.intCast}) LIMIT 1`,
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
                  sql: `INSERT INTO ${t("parity_f_crates")} (${q("id")}, ${q("slotKey")}) VALUES (${p(1)}, NULL) RETURNING ${q("id")} AS ${q("id")}`,
                  params: ["c1"],
                  outputs: { result: { kind: "rows" } },
                  expects: substrate.terminalExpects,
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
                  sql: `INSERT INTO ${t("parity_f_crates")} (${q("id")}, ${q("slotKey")}) VALUES (${p(1)}, NULL)`,
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
                  sql: `SELECT ${q("t0")}.${q("id")} AS ${q("id")} FROM ${t("parity_f_crates")} AS ${q("t0")} WHERE ${q("t0")}.${q("id")} = ${p(1)} LIMIT 1`,
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
            sql: `INSERT INTO ${t("parity_f_hubs")} (${q("name")}, ${q("tag")}) VALUES (${p(1)}, NULL)${returningClause}`,
            params: ["H"],
            outputs: { id: identityOutput },
            expects: null,
            racePin: null,
            onUniqueConflict: null,
          },
          {
            id: "badge.create",
            kind: "write",
            sql: `INSERT INTO ${t("parity_f_badges")} (${q("hubId")}, ${q("note")}) VALUES (CAST(${p(1)} AS ${substrate.intCast}), ${p(2)})`,
            params: [reference("hub.create", "id"), "n"],
            outputs: {},
            expects: null,
            racePin: null,
            onUniqueConflict: null,
          },
          {
            id: "badge.select",
            kind: "read",
            sql: `SELECT ${q("t0")}.${q("hubId")} AS ${q("hubId")} FROM ${t("parity_f_badges")} AS ${q("t0")} WHERE ${q("t0")}.${q("hubId")} = CAST(${p(1)} AS ${substrate.intCast}) LIMIT 1`,
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
// The junction consumer of a produced identity — Package A's unpinned hole
// ---------------------------------------------------------------------------

describe("parity F — a junction target whose own key its INSERT produces", () => {
  test("the join row spends the SUBTREE's produced reference, not a re-derived key", () => {
    const driver = new PGliteDriver();
    const operation = new CreateOperation(
      engineFor(driver),
      freshFieldSchema.hub as Model<any>,
      {
        data: {
          name: "H",
          tag: "t",
          wires: { create: { label: "w1", pins: { create: { id: "p1" } } } },
        },
        select: { id: true },
      }
    );
    expect(fragmentContract(driver, operation.planning())).toEqual(
      EMPTY_PLANNING
    );
    const compiled = fragmentContract(driver, operation.compile({})) as {
      steps: { id: string; sql: string; params: unknown[] }[];
    };
    // FIVE statements: the hub INSERT, the wire subtree (its own INSERT + the grandchild),
    // the join row, and the terminal read. The arm is a delegated SUBTREE — E4-U3 — so the
    // wire's key is produced, not folded from a literal.
    expect(compiled.steps.map((step) => step.id)).toEqual([
      "hub.create",
      "wire.create",
      "pin.create",
      "wire.junction.insert",
      "hub.select",
    ]);
    // ONE produced identity per producing INSERT, and BOTH the grandchild and the join row
    // spend the wire's. A join row that re-derived the key (a second lookup, a session
    // sentinel) would not carry this reference at all.
    expect(compiled.steps[2]?.params).toEqual([
      "p1",
      reference("wire.create", "id"),
    ]);
    expect(compiled.steps[3]?.params).toEqual([
      reference("hub.create", "id"),
      reference("wire.create", "id"),
    ]);
    expect(compiled.steps[1]?.sql).toBe(
      `INSERT INTO "public"."parity_f_wires" ("label") VALUES ($1) RETURNING "id" AS "id"`
    );
  });
});

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
          sql: 'WITH "__viborm_mutation" AS (INSERT INTO "public"."parity_f_hubs" ("name", "tag") VALUES ($1, $2) RETURNING "id", "name", "tag"), "__viborm_write_0" AS (INSERT INTO "public"."parity_f_marks" ("id", "hubTag") VALUES ($3, CAST($4 AS TEXT))) SELECT "t0"."id" AS "id" FROM "__viborm_mutation" AS "t0"',
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
      // A child-held nested CREATE leaf. RESIDUAL I re-measured this row: it no longer
      // reaches position `childEdge`, and the change is the lift's rather than a drift.
      // A nested create now carries an `incomingMembership` like the adopt kinds do — the
      // seam the composed-supplier and record-series work needed — and that binding is
      // built from `childEdgeMembers` BEFORE `childFkAssign` runs, so the whole-value
      // parent source is what asks first and `parentId` is the position that answers.
      // Same site (15, `requireRecordReferenced`), same class, same construction phase,
      // zero effects; only the noun moved, and it moved to the one that is now true.
      "a nested create leaf",
      hubCreate({ marks: { create: { id: "m1" } } }),
      "query-engine-v2 create cannot resolve the parent id for relation 'marks': referenced field 'tag' is neither this record's primary key nor a knowable value in its own create data.",
    ],
    [
      // The connect leaf still reaches `childEdge`: a connect Part takes the per-column FK
      // assignment directly, with no membership binding built ahead of it. The two rows
      // therefore no longer share a position, which is why they no longer share a message
      // — the earlier note here claimed they did, and that claim expired with the seam.
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
      // The same fact at an update root, where the enclosing statement is an UPDATE
      // rather than an INSERT. Residual G deleted the update root's own site: the
      // before-root target now demands the value from its own fresh subtree
      // (`FreshRecordPart.requireRootReferenced`), so `requireRecordReferenced`
      // answers under position `beforeRootTarget` and this sentence is unchanged.
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
