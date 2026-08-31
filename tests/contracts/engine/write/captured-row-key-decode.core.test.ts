/**
 * A CAPTURED row key addresses the row it was captured from.
 *
 * A planning probe publishes its rows exactly as the provider spelled them, and
 * the write engine then RE-ADDRESSES those values: into a `whereUnique`, into a
 * filter, into a junction insert. That second trip goes through the ordinary
 * where/values builder, which lowers a LOGICAL value — so the captured spelling
 * and the re-bound spelling have to be the same value, and on SQLite a decimal
 * column's two spellings are not:
 *
 *   logical 10.00 at scale 2   physical "1000"   re-bound as logical -> "100000"
 *
 * `"100000"` is the coefficient of 1000, a DIFFERENT ROW. The probe that
 * captured it selected `CAST("id" AS TEXT)`, so nothing about the captured value
 * says which vocabulary it is in; only the decode does (plan 5.1: "cursors,
 * deduplication, relation stitching, identity maps, cache keys, and write-engine
 * agreement use the descriptor codec's canonical private string").
 *
 * Every case below compiles a real operation against a synthetic planning
 * result — the physical row a SQLite probe would have published — and reads the
 * VALUES the compiled statement binds. Three owners route their captures
 * through `parseCapturedRowKeys`, and each one is asserted through the arm that
 * reaches it:
 *
 *   RelationWritePart.capturedTargetRow  -> the `set` reparent + its guard
 *   RelationWritePart.capturedRow        -> the targeted `delete`
 *   RelationJunctionPart.capturedRowKeys -> m2m `connect` and `deleteMany`
 *   RelationJunctionToOnePart.firstRowKey -> the singular inverse `delete`
 *
 * The controls are the falsification: PostgreSQL (which spells the same value
 * as native text) and an INT primary key both have to come out byte-identical,
 * so a decode that mangled ordinary captures rather than decoding decimals would
 * fail here.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { type Dialect, Driver } from "@drivers";
import { bindRelation } from "@query-engine/builders/relation-data-builder";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { s } from "@schema";
import type { Model } from "@schema/model";
import {
  createQueryScope,
  lookupRelation,
} from "@src/query-engine/context/query-scope";
import type {
  OperationStep,
  StatementStep,
} from "@src/query-engine/write-engine/OperationFragment";
import {
  bindRelationMembership,
  literalParentId,
  membershipProjection,
} from "@src/query-engine/write-engine/relation-membership";
import { parseCapturedRows } from "@src/query-engine/write-engine/series-result-read";
import {
  buildTargetProjection,
  capturedTargetColumnPredicate,
  targetProjectionColumns,
  targetProjectionSelect,
} from "@src/query-engine/write-engine/target-projection";
import { UpdateOperation } from "@src/query-engine/write-engine/UpdateOperation";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

/** SQL-only: a compiled statement is a pure function of the adapter. */
class SqlOnlyDriver extends Driver<null, null> {
  readonly adapter: DatabaseAdapter;

  constructor(adapter: DatabaseAdapter, dialect: Dialect) {
    super(dialect, `captured-row-key-${dialect}`);
    this.adapter = adapter;
  }

  protected async initClient() {
    return null;
  }

  protected async closeClient() {
    // SQL-only driver: no external client is allocated.
  }

  protected async execute<T>(): Promise<{ rows: T[]; rowCount: number }> {
    return { rows: [], rowCount: 0 };
  }

  protected async executeRaw<T>(): Promise<{ rows: T[]; rowCount: number }> {
    return { rows: [], rowCount: 0 };
  }

  protected async transaction<T>(
    _client: null,
    fn: (transaction: null) => Promise<T>
  ): Promise<T> {
    return fn(null);
  }
}

class BatchSqlOnlyDriver extends SqlOnlyDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
}

const MONEY = { precision: 12, scale: 2 } as const;

/**
 * The captured target's logical row key, and the two physical spellings of it.
 *
 * `CAPTURED_COEFFICIENT` is what a SQLite probe publishes for `LOGICAL_KEY`;
 * `MISADDRESSED` is what re-binding that spelling as a logical value produces —
 * the coefficient of 1000, which addresses another row entirely.
 */
const LOGICAL_KEY = "10";
const CAPTURED_COEFFICIENT = "1000";
const MISADDRESSED = "100000";
const UNSAFE_LOGICAL_KEY = "90071992547409.93";
const UNSAFE_COEFFICIENT = "9007199254740993";
const UNSAFE_MISADDRESSED = "900719925474099300";
/** What PostgreSQL publishes for the same row: native `NUMERIC(12,2)` text. */
const CAPTURED_TEXT = "10.00";
/** The result parser's own short-row refusal, which this file no longer copies. */
const SHORT_ROW_REFUSAL = /does not match the requested result columns/;

const schema = (() => {
  const ledger = s
    .model({
      id: s.string().id(),
      label: s.string(),
      entries: s.toMany(() => entry),
      counters: s.toMany(() => counter),
      tags: s
        .toMany(() => tag)
        .through("crk_ledger_tags")
        .source("ledger_ref")
        .target("tag_ref"),
    })
    .map("crk_ledgers");

  const entry = s
    .model({
      id: s.decimal(MONEY).id(),
      label: s.string(),
      ledgerId: s.string().nullable(),
      ledger: s
        .toOne(() => ledger)
        .fields("ledgerId")
        .references("id"),
    })
    .map("crk_entries");

  /** The non-decimal control: same shape, ordinary integer identity. */
  const counter = s
    .model({
      id: s.int().id(),
      label: s.string(),
      ledgerId: s.string().nullable(),
      ledger: s
        .toOne(() => ledger)
        .fields("ledgerId")
        .references("id"),
    })
    .map("crk_counters");

  const tag = s
    .model({
      id: s.decimal(MONEY).id(),
      name: s.string(),
      ledgers: s.toMany(() => ledger),
    })
    .map("crk_tags");

  return { ledger, entry, counter, tag };
})();

/** The singular collection inverse: a member table whose OWNER keys on a decimal. */
const inverseSchema = (() => {
  const slip = s
    .model({
      id: s.int().id(),
      note: s.string(),
      crate: s.toOne(() => crate),
    })
    .map("crk_slips");
  const crate = s
    .model({
      id: s.decimal({ precision: 16, scale: 2 }).id(),
      label: s.string(),
      items: s
        .toMany({ slip: () => slip }, { values: { slip: "crk.slip.v1" } })
        .through({
          slip: { table: "crk_crate_slips", source: "holder", target: "entry" },
        }),
    })
    .map("crk_crates");
  return { slip, crate };
})();

/**
 * The root locate consumes more than its row key: the nested create stores the
 * account's decimal reference key in `note.accountCode`. Both selected fields
 * therefore have to cross the same private decode before either is re-bound.
 */
const fullProjectionSchema = (() => {
  const account = s
    .model({
      id: s.decimal(MONEY).id(),
      code: s.decimal(MONEY).unique(),
      label: s.string(),
      notes: s.toMany(() => note),
    })
    .map("crk_accounts");
  const note = s
    .model({
      id: s.int().id(),
      label: s.string(),
      accountCode: s.decimal(MONEY),
      account: s
        .toOne(() => account)
        .fields("accountCode")
        .references("code"),
    })
    .map("crk_notes");
  return { account, note };
})();

/** A polymorphic target identity carried by one private storage column. */
const privateDecimalIdentity = s.decimal({ precision: 18, scale: 2 }).id();
const privateDecimalStorageSchema = (() => {
  const article = s
    .model({
      id: privateDecimalIdentity,
      title: s.string(),
      cards: s.toMany(() => card).name("subject"),
    })
    .map("crk_private_articles");
  const card = s
    .model({
      id: s.string().id(),
      label: s.string(),
      subject: s
        .toOne(
          { article: () => article },
          { values: { article: "crk.private.article.v1" } }
        )
        .name("subject")
        .optional(),
    })
    .map("crk_private_cards");
  return { article, card };
})();

/** The three write topologies that can re-pin a target's private carrier. */
const privateCaptureTopologySchema = (() => {
  const article = s.model({
    id: s.decimal({ precision: 18, scale: 2 }).id(),
    title: s.string(),
    cards: s.toMany(() => card).name("subject"),
  });
  const folder = s.model({
    id: s.string().id(),
    cards: s.toMany(() => card),
  });
  const board = s.model({
    id: s.string().id(),
    cards: s
      .toMany(() => card)
      .name("boardCards")
      .through("crk_private_board_cards")
      .source("board_ref")
      .target("card_ref"),
  });
  const card = s.model({
    id: s.string().id(),
    folderId: s.string().nullable(),
    folder: s
      .toOne(() => folder)
      .fields("folderId")
      .references("id"),
    boards: s.toMany(() => board).name("boardCards"),
    subject: s
      .toOne(
        { article: () => article },
        { values: { article: "crk.private.topology.article.v1" } }
      )
      .name("subject")
      .optional(),
  });
  return { article, board, card, folder };
})();

interface CompiledUpdate {
  readonly steps: readonly OperationStep[];
}

/**
 * Compile one nested update whose planning probes already ran.
 *
 * `capturedRow` is the row the TARGET probe published — the physical spelling
 * under test. The root locate publishes its own key, which is never a decimal
 * here so that every value asserted below comes from the capture.
 */
function compile(
  models: Record<string, Model<any>>,
  root: Model<any>,
  where: Record<string, unknown>,
  data: Record<string, unknown>,
  rootPrefix: string,
  rootRow: Record<string, unknown>,
  capturedRow: Record<string, unknown>,
  adapter: DatabaseAdapter = new SQLiteAdapter(),
  dialect: Dialect = "sqlite"
): CompiledUpdate {
  const engine = new QueryEngine(
    new SqlOnlyDriver(adapter, dialect),
    createModelRegistry(models, createSchemaRegistry(models))
  );
  const operation = new UpdateOperation(engine, root, {
    where,
    data,
    select: { id: true },
  });
  const known: Record<string, unknown> = {};
  for (const step of operation.planning().steps) {
    known[`${step.id}.rows`] = step.id.startsWith(rootPrefix)
      ? [rootRow]
      : [capturedRow];
  }
  return { steps: operation.compile(known).steps };
}

/** The compiled statement whose id is exactly `id`, with its bound values. */
function statement(compiled: CompiledUpdate, id: string): StatementStep {
  const step = compiled.steps.find(
    (candidate): candidate is StatementStep =>
      candidate.id === id &&
      (candidate.kind === "write" || candidate.kind === "read")
  );
  if (!step) {
    const ids = compiled.steps.map((candidate) => candidate.id).join(", ");
    throw new Error(`No compiled statement '${id}'. Compiled: ${ids}`);
  }
  return step;
}

function valuesOf(compiled: CompiledUpdate, id: string): unknown[] {
  return [...statement(compiled, id).statement.values];
}

function ledgerUpdate(
  data: Record<string, unknown>,
  capturedRow: Record<string, unknown>,
  adapter?: DatabaseAdapter,
  dialect?: Dialect
): CompiledUpdate {
  return compile(
    schema,
    schema.ledger,
    { id: "L1" },
    data,
    "ledger",
    { id: "L1" },
    capturedRow,
    adapter,
    dialect
  );
}

function privateDecimalCarrierCapture(rawType: unknown, rawId: unknown) {
  const engine = new QueryEngine(
    new SqlOnlyDriver(new SQLiteAdapter(), "sqlite"),
    createModelRegistry(
      privateDecimalStorageSchema,
      createSchemaRegistry(privateDecimalStorageSchema)
    )
  );
  const edge = engine.relations
    .get(privateDecimalStorageSchema.card)
    ?.get("subject")?.edge;
  if (edge?.kind !== "variantRowCarrier") {
    throw new Error("Expected a resolved row-held variant carrier.");
  }
  const typeColumn = edge.storage.typeColumn;
  const idColumn = edge.storage.idColumn;
  const columns = [typeColumn, idColumn];
  const projection = buildTargetProjection(
    privateDecimalStorageSchema.card,
    [],
    columns
  );
  const captured = parseCapturedRows(
    engine,
    privateDecimalStorageSchema.card,
    [
      {
        id: "card-1",
        [typeColumn.name]: rawType,
        [idColumn.name]: rawId,
      },
    ],
    targetProjectionSelect(projection),
    columns
  )[0];
  if (!captured) throw new Error("Expected one captured carrier row.");

  return { captured, engine, idColumn, projection, typeColumn };
}

function privateTopologyEngine() {
  return new QueryEngine(
    new BatchSqlOnlyDriver(new SQLiteAdapter(), "sqlite"),
    createModelRegistry(
      privateCaptureTopologySchema,
      createSchemaRegistry(privateCaptureTopologySchema)
    )
  );
}

function privateTopologyCardRow(): Record<string, unknown> {
  return {
    id: "card-1",
    subject_type: "crk.private.topology.article.v1",
    subject_id: UNSAFE_COEFFICIENT,
  };
}

function privateTopologyArticleRow(): Record<string, unknown> {
  return { id: UNSAFE_COEFFICIENT, title: "before" };
}

function guardStepValues(steps: readonly OperationStep[]): unknown[] {
  return steps.flatMap((step) =>
    step.kind === "guard" ? [...step.premise.statement.values] : []
  );
}

function targetedPrivateCarrierGuardValues(
  root: Model<any>,
  rootPrefix: string,
  rootId: string,
  data: Record<string, unknown>
): unknown[] {
  const engine = privateTopologyEngine();
  const operation = new UpdateOperation(engine, root, {
    where: { id: rootId },
    data,
    select: { id: true },
  });
  const known: Record<string, unknown> = {};
  for (const step of operation.planning().steps) {
    known[`${step.id}.rows`] = step.id.startsWith(rootPrefix)
      ? [{ id: rootId }]
      : step.id.startsWith("article")
        ? [privateTopologyArticleRow()]
        : [privateTopologyCardRow()];
  }
  return guardStepValues(operation.compile(known).steps);
}

function selectedSeriesPrivateCarrierGuardValues(): unknown[] {
  const engine = privateTopologyEngine();
  const operation = new UpdateOperation(
    engine,
    privateCaptureTopologySchema.folder,
    {
      where: { id: "folder-1" },
      data: {
        cards: {
          updateMany: {
            where: {},
            data: {
              subject: {
                update: { type: "article", data: { title: "updated" } },
              },
            },
          },
        },
      },
      select: { id: true },
    }
  );
  const rootKnown: Record<string, unknown> = {};
  for (const step of operation.planning().steps) {
    rootKnown[`${step.id}.rows`] = [{ id: "folder-1" }];
  }
  const seriesStep = operation
    .compile(rootKnown)
    .steps.find((step) => step.kind === "recordSeries");
  if (!seriesStep || seriesStep.kind !== "recordSeries") {
    throw new Error("Expected a nested selected-record series.");
  }
  const capture = seriesStep.series.capture().steps[0];
  if (!capture) throw new Error("Expected the selected-record capture.");
  const member = seriesStep.series.compileMembers({
    [`${capture.id}.rows`]: [{ id: "card-1" }],
  })[0];
  if (!member) throw new Error("Expected one selected-record member.");
  const memberKnown: Record<string, unknown> = {};
  for (const step of member.planning().steps) {
    memberKnown[`${step.id}.rows`] = step.id.startsWith("article")
      ? [privateTopologyArticleRow()]
      : [privateTopologyCardRow()];
  }
  return guardStepValues(member.compile(memberKnown).steps);
}

describe("a captured decimal row key addresses the captured row", () => {
  test("a private polymorphic decimal identity rebinds the captured row", () => {
    const { captured, engine, idColumn, projection } =
      privateDecimalCarrierCapture(
        "crk.private.article.v1",
        CAPTURED_COEFFICIENT
      );

    const predicate = capturedTargetColumnPredicate(
      createQueryScope(engine, privateDecimalStorageSchema.card),
      projection,
      captured
    );
    if (!predicate) throw new Error("Expected the private-column predicate.");

    expect(captured[idColumn.name]).toBe(LOGICAL_KEY);
    expect(predicate.values).toContain(CAPTURED_COEFFICIENT);
    expect(predicate.values).not.toContain(MISADDRESSED);
  });

  test("an unset optional carrier preserves both nullable private columns", () => {
    const { captured, idColumn, typeColumn } = privateDecimalCarrierCapture(
      null,
      null
    );

    expect(captured[typeColumn.name]).toBeNull();
    expect(captured[idColumn.name]).toBeNull();
  });

  test("private decimal identity projections cross SQLite as exact text", () => {
    const { captured, engine, idColumn, projection, typeColumn } =
      privateDecimalCarrierCapture(
        "crk.private.article.v1",
        UNSAFE_COEFFICIENT
      );
    const scope = createQueryScope(engine, privateDecimalStorageSchema.card);
    const targetColumns = targetProjectionColumns(scope, projection);
    const targetType = targetColumns.find(
      (column) => column.name === typeColumn.name
    );
    const targetId = targetColumns.find(
      (column) => column.name === idColumn.name
    );

    const articleScope = createQueryScope(
      engine,
      privateDecimalStorageSchema.article
    );
    const relationRef = lookupRelation(articleScope, "cards");
    if (!relationRef) throw new Error("Expected the variant member inverse.");
    const relation = bindRelation(articleScope, relationRef);
    if (relation.position !== "childHeld") {
      throw new Error("Expected child-held variant membership.");
    }
    const binding = bindRelationMembership(
      relation,
      literalParentId(UNSAFE_LOGICAL_KEY)
    );
    const membershipColumns = membershipProjection(
      scope,
      binding
    ).additionalColumns.map((column) => column.toStatement("?"));

    expect(targetType?.sql.toStatement("?")).toBe(
      '"t0"."subject_type" AS "subject_type"'
    );
    expect(targetId?.sql.toStatement("?")).toBe(
      'CAST("t0"."subject_id" AS TEXT) AS "subject_id"'
    );
    expect(membershipColumns).toEqual([
      '"t0"."subject_type" AS "subject_type"',
      'CAST("t0"."subject_id" AS TEXT) AS "subject_id"',
    ]);

    const predicate = capturedTargetColumnPredicate(
      scope,
      projection,
      captured
    );
    if (!predicate) throw new Error("Expected the private-column predicate.");
    expect(captured[idColumn.name]).toBe(UNSAFE_LOGICAL_KEY);
    expect(predicate.values).toContain(UNSAFE_COEFFICIENT);
  });

  test.each([
    [
      "row-held targeted relation",
      () =>
        targetedPrivateCarrierGuardValues(
          privateCaptureTopologySchema.folder,
          "folder",
          "folder-1",
          {
            cards: {
              update: {
                where: { id: "card-1" },
                data: {
                  subject: {
                    update: {
                      type: "article",
                      data: { title: "updated" },
                    },
                  },
                },
              },
            },
          }
        ),
    ],
    [
      "junction targeted relation",
      () =>
        targetedPrivateCarrierGuardValues(
          privateCaptureTopologySchema.board,
          "board",
          "board-1",
          {
            cards: {
              update: {
                where: { id: "card-1" },
                data: {
                  subject: {
                    update: {
                      type: "article",
                      data: { title: "updated" },
                    },
                  },
                },
              },
            },
          }
        ),
    ],
    ["selected-record series", selectedSeriesPrivateCarrierGuardValues],
  ] as const)("%s re-pins the decoded private identity", (_name, compile) => {
    const values = compile();

    expect(values).not.toContain(UNSAFE_MISADDRESSED);
    expect(values).toContain(UNSAFE_COEFFICIENT);
  });

  test("a full target projection decodes its row key and consumed reference field", () => {
    const compiled = compile(
      fullProjectionSchema,
      fullProjectionSchema.account,
      { id: LOGICAL_KEY },
      {
        notes: {
          create: [{ id: 1, label: "captured reference" }],
        },
      },
      "account",
      {
        id: CAPTURED_COEFFICIENT,
        // Logical 2.5 in SQLite's scale-2 coefficient vocabulary.
        code: "250",
      },
      {}
    );

    // The nested row stores logical 2.5 once. Treating the captured coefficient
    // as logical text would bind "25000" and point at a different account.
    expect(valuesOf(compiled, "note.create")).toContain("250");
    expect(valuesOf(compiled, "note.create")).not.toContain("25000");
    // The final read re-addresses the exact located account, not logical 1000.
    expect(valuesOf(compiled, "account.select")).toEqual([
      CAPTURED_COEFFICIENT,
    ]);
  });

  test("`set` reparents the captured row, not its coefficient's namesake", () => {
    const compiled = ledgerUpdate(
      { entries: { set: [{ id: LOGICAL_KEY }] } },
      { id: CAPTURED_COEFFICIENT }
    );

    // The reparent addresses the captured target…
    expect(valuesOf(compiled, "entry.set")).toEqual([
      "L1",
      CAPTURED_COEFFICIENT,
    ]);
    // …and the departing half, which is built from the USER's own selector
    // rather than from a capture, names the SAME row. One operation cannot
    // exclude one row from the sweep and reparent another: before the capture
    // was decoded these two disagreed, and the disagreement is the defect.
    expect(valuesOf(compiled, "entry.orphan")).toEqual([
      "L1",
      CAPTURED_COEFFICIENT,
    ]);
    expect(valuesOf(compiled, "entry.set")).not.toContain(MISADDRESSED);
  });

  test("a targeted `delete` deletes the row the probe captured", () => {
    const compiled = ledgerUpdate(
      { entries: { delete: [{ id: LOGICAL_KEY }] } },
      { id: CAPTURED_COEFFICIENT }
    );

    expect(valuesOf(compiled, "entry.delete")).toEqual([CAPTURED_COEFFICIENT]);
  });

  test("a junction `connect` joins the captured target", () => {
    const compiled = ledgerUpdate(
      { tags: { connect: [{ id: LOGICAL_KEY }] } },
      { id: CAPTURED_COEFFICIENT }
    );

    expect(valuesOf(compiled, "tag.connect")).toEqual([
      "L1",
      CAPTURED_COEFFICIENT,
    ]);
  });

  test("a junction `deleteMany` sweeps the captured membership set", () => {
    const compiled = ledgerUpdate(
      { tags: { deleteMany: {} } },
      {
        id: CAPTURED_COEFFICIENT,
      }
    );

    // Both halves — the membership rows and the targets themselves — address
    // the same captured set.
    expect(valuesOf(compiled, "tag.junction.delete")).toEqual([
      CAPTURED_COEFFICIENT,
    ]);
    expect(valuesOf(compiled, "tag.deleteMany")).toEqual([
      CAPTURED_COEFFICIENT,
    ]);
  });

  test("the singular collection inverse deletes the owner it captured", () => {
    const compiled = compile(
      inverseSchema,
      inverseSchema.slip,
      { id: 1 },
      { crate: { delete: true } },
      "slip",
      { id: 1 },
      { id: CAPTURED_COEFFICIENT }
    );

    expect(valuesOf(compiled, "crate.delete")).toEqual([CAPTURED_COEFFICIENT]);
  });
});

describe("the decode changes nothing where physical and logical agree", () => {
  test("PostgreSQL: the same capture binds the same row from native text", () => {
    const pg = ledgerUpdate(
      { entries: { set: [{ id: LOGICAL_KEY }] } },
      { id: CAPTURED_TEXT },
      new PostgresAdapter(),
      "postgresql"
    );

    // PG's physical spelling is the logical value with the scale written out,
    // so the canonical text is what both halves bind — and `"10.00"` reaching
    // the builder unchanged would have bound the same row too. What this pins
    // is that the decode CANONICALIZES rather than passing the bytes through:
    // one spelling per value is what makes a row key a key.
    expect(valuesOf(pg, "entry.set")).toEqual(["L1", LOGICAL_KEY]);
    expect(valuesOf(pg, "entry.orphan")).toEqual(["L1", LOGICAL_KEY]);
  });

  test("an int primary key is captured and re-addressed unchanged", () => {
    const compiled = ledgerUpdate(
      { counters: { set: [{ id: 7 }] } },
      { id: 7 }
    );

    expect(valuesOf(compiled, "counter.set")).toEqual(["L1", 7]);
    expect(valuesOf(compiled, "counter.orphan")).toEqual(["L1", 7]);
  });

  test("a captured row that is not a row at all is refused by the parser", () => {
    // The row-shape refusal moved to the one owner of it; nothing in the write
    // engine keeps a second copy. A probe row missing the row key is a short
    // row, not an absent target.
    expect(() =>
      ledgerUpdate(
        { entries: { delete: [{ id: LOGICAL_KEY }] } },
        {
          label: "no id here",
        }
      )
    ).toThrow(SHORT_ROW_REFUSAL);
  });
});
