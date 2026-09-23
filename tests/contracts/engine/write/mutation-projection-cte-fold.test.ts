import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { SQLite3Driver } from "@drivers/sqlite3";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { NotFoundError, UniqueConstraintError } from "@errors";

import { hydrateSchemaNames, s } from "@schema";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { beforeAll, describe, expect, test } from "vitest";

/**
 * PHASE 8.1/8.2 — the terminal read and the nested-create tree, RE-EXPRESSED
 * onto the shipped fold (D-15).
 *
 * WHAT THIS FILE PINNED. The retired engine had a second, Phase-8 fold on top of
 * the scalar one: a CTE that carried a relation-projecting mutation and its
 * terminal read in ONE statement,
 *
 *   WITH "__viborm_mutation" AS (UPDATE … RETURNING <every column>)
 *   SELECT <projection over the CTE> FROM "__viborm_mutation" AS "t0"
 *
 * gated by two snapshot-legality guards (`projectionReadsMutatedModel`,
 * `setCanFireReferentialAction`), plus a Phase-8.2 variant that chained a
 * nested-create tree through sibling `"__viborm_write_n"` arms. MEASURED at
 * c9c06e5, PGlite, before that fold: update + include 3 statements
 * (transaction) / 4 (atomic batch), create + include 2 — and after it: 1, 2, 1.
 *
 * WHAT SHIPPED. D-15 retired the `pattern/` experiment and every production
 * owner it alone kept alive, and the CTE machinery went with it: grep
 * `__viborm_mutation` or `MUTATION_CTE` across `src/` and there is nothing.
 * Raptor 3 ports the FIRST fold only — the scalar `UPDATE/INSERT … RETURNING` —
 * behind one gate, `Queries.returningSafeProjection`
 * (`src/query-engine/raptor3/shared/query.ts`, "the one owner of 'may this
 * projection ride a RETURNING?' — `fields.every(kind === "scalar" || kind === "sentinel")`",
 * `raptor3/AGENTS.md`). A relation projection — an `include`, a relation
 * `select`, a `_count` — must read other rows, which no `RETURNING` carries, so
 * it keeps the located/mutated/re-read route; `g4/unit02/note.md` §12.1 measures
 * that route and leaves it multi-statement on purpose ("update with a relation
 * projection | n statements, 1 tx | unchanged"). The two snapshot guards were
 * the CTE's own legality question and have no shipped counterpart: the terminal
 * read is a separate statement, so it always reads post-mutation state, which is
 * why every answer below is unchanged.
 *
 * So the statement-traffic cells now pin the SHIPPED route and its shape, the
 * retired per-case `folds` decisions are recorded as history beside the cases
 * that carried them, and the ORACLE — the half that was never about the fold —
 * stands exactly as it was: every answer is asserted against the SAME projection
 * read back through `findUnique`, on the same row, over seeded state, on both
 * substrates.
 */

const account = s
  .model({
    id: s.int().id(),
    email: s.string().unique(),
    label: s.string(),
    notes: s.toMany(() => note),
    managerId: s.int().nullable(),
    manager: s
      .toOne(() => account)
      .fields("managerId")
      .references("id"),
    reports: s.toMany(() => account),
  })
  .map("p81_accounts");

const note = s
  .model({
    id: s.int().id(),
    body: s.string(),
    accountId: s.int(),
    account: s
      .toOne(() => account)
      .fields("accountId")
      .references("id")
      .onUpdate("cascade"),
  })
  .map("p81_notes");

const schema = { account, note };

/** A SECOND schema whose parent key nothing cascades from, so the referential
 *  action guard has a control: the same PK rewrite that declines above folds
 *  here — the guard is not simply "never fold a key rewrite". */
const tag = s
  .model({
    id: s.int().id(),
    name: s.string(),
    color: s.string(),
    palettes: s.toMany(() => palette),
  })
  .map("p81_tags");
const palette = s
  .model({
    id: s.int().id(),
    title: s.string(),
    tags: s.toMany(() => tag),
  })
  .map("p81_palettes");
const soloSchema = { tag, palette };

/** Phase 8.2's declining control: a model whose primary key the DATABASE
 *  generates, over children whose keys it ALSO generates. Two arms calling
 *  `nextval`, and PostgreSQL does not specify the order it runs unread
 *  data-modifying arms in. (Package M lowered the value FLOW — one generated
 *  parent key IS readable from a later arm now — so what this pair still
 *  isolates is the ordering conjunct, not the flow.) */
const seq = s
  .model({
    id: s.int().id().increment(),
    label: s.string(),
    kids: s.toMany(() => kid),
  })
  .map("p82_seq");
const kid = s
  .model({
    id: s.int().id().increment(),
    body: s.string(),
    seqId: s.int(),
    parent: s
      .toOne(() => seq)
      .fields("seqId")
      .references("id"),
  })
  .map("p82_kid");
const seqSchema = { seq, kid };

/** Phase 8.2's ORDERING control: a literal parent key over children whose keys
 *  the DATABASE assigns. Nothing flows between the arms — every FK is the
 *  literal `hostId` — so the fold's other conjuncts all pass, and the sequence
 *  is the only thing left that can tell the arms apart. */
const crate = s
  .model({
    id: s.int().id(),
    label: s.string(),
    items: s.toMany(() => item),
  })
  .map("p82_crate");
const item = s
  .model({
    id: s.int().id().increment(),
    body: s.string(),
    crateId: s.int(),
    holder: s
      .toOne(() => crate)
      .fields("crateId")
      .references("id"),
  })
  .map("p82_item");
const crateSchema = { crate, item };

/** Phase 8.1 guard 2's UNIQUE-INDEX control. `.index([...], { unique: true })`
 *  is a unique column set the database enforces but no `whereUnique` can
 *  address — and PostgreSQL accepts it as a foreign-key target, which the
 *  migration driver's `CREATE UNIQUE INDEX` makes real here. A guard that
 *  enumerated unique CONSTRAINTS alone folded this cascade and answered with
 *  the pre-cascade (empty) child list. */
const host = s
  .model({
    id: s.int().id(),
    code: s.string(),
    label: s.string(),
    pets: s.toMany(() => pet),
  })
  .map("p81_hosts")
  .index(["code"], { unique: true })
  // A PLAIN index, so the widening is pinned to unique ones: an ordinary
  // read-performance index is not a column set anything can reference, and a
  // guard that counted it would decline every fold on every indexed model.
  .index(["label"]);
const pet = s
  .model({
    id: s.int().id(),
    name: s.string(),
    hostCode: s.string(),
    host: s
      .toOne(() => host)
      .fields("hostCode")
      .references("code")
      .onUpdate("cascade"),
  })
  .map("p81_pets");
const hostSchema = { host, pet };

beforeAll(() => {
  hydrateSchemaNames(schema);
  hydrateSchemaNames(seqSchema);
  hydrateSchemaNames(soloSchema);
  hydrateSchemaNames(crateSchema);
  hydrateSchemaNames(hostSchema);
});

const getAccountFamily = usePGliteSchemaFamily(schema);
const getHostFamily = usePGliteSchemaFamily(hostSchema);
const getSoloFamily = usePGliteSchemaFamily(soloSchema);
const getSequenceFamily = usePGliteSchemaFamily(seqSchema);
const getCrateFamily = usePGliteSchemaFamily(crateSchema);

/**
 * Records every statement the operation sends, in order. Hooks the PROTECTED
 * `execute`/`executeRaw` seam (as `delete-fold.test.ts` does), because a
 * transaction runs its statements through a transaction-bound driver that
 * delegates back to exactly these two — so one hook sees both substrates.
 */
class RecordingPGliteDriver extends PGliteDriver {
  readonly statements: string[] = [];
  recording = false;

  protected override execute<T>(
    client: PGlite | Transaction,
    sqlText: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    if (this.recording) this.statements.push(sqlText);
    return super.execute<T>(client, sqlText, params, context);
  }

  protected override executeRaw<T>(
    client: PGlite | Transaction,
    sqlText: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    if (this.recording) this.statements.push(sqlText);
    return super.executeRaw<T>(client, sqlText, params, context);
  }
}

class BatchOnlyRecordingDriver extends RecordingPGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    return this.transaction(client, async (transaction) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries) {
        results.push(
          await this.executeRaw<T>(transaction, query.sql, query.params)
        );
      }
      return results;
    });
  }
}

async function boot(batch = false) {
  const family = getAccountFamily();
  await family.reset();
  const driver = batch
    ? new BatchOnlyRecordingDriver({
        client: family.database,
        namespace: family.namespace,
      })
    : new RecordingPGliteDriver({
        client: family.database,
        namespace: family.namespace,
      });
  const client = createClient({ schema, driver });
  for (const id of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    await client.account.create({
      data: { id, email: `a${id}@x`, label: `L${id}` },
    });
  }
  // Account 3 owns three notes; account 4 owns one; the rest own none, so an
  // empty relation payload and a non-empty one are both exercised and a wrong
  // count cannot coincide with a right one.
  for (const id of [30, 31, 32]) {
    await client.note.create({ data: { id, body: `n${id}`, accountId: 3 } });
  }
  await client.note.create({ data: { id: 40, body: "n40", accountId: 4 } });
  // Account 9 reports to account 8, and account 7 is its OWN manager — the
  // self-relation witnesses. The self-managed row is the one that makes guard 1
  // load-bearing: its `manager` subquery reads the row the statement is
  // updating, so a fold would answer with that row's PRE-update shape.
  await client.account.update({ where: { id: 9 }, data: { managerId: 8 } });
  await client.account.update({ where: { id: 7 }, data: { managerId: 7 } });
  return { client, driver };
}

function drain(driver: RecordingPGliteDriver): string[] {
  return driver.statements.splice(0, driver.statements.length);
}

/**
 * D-15: the SHIPPED fold is the scalar one — the mutating statement alone,
 * answering out of its own `RETURNING`. `WITH "__viborm_mutation"` is gone, so
 * "folded" can no longer mean "starts with WITH".
 */
const foldedInOneStatement = (statements: string[]) =>
  statements.length === 1 &&
  MUTATION_STATEMENT.test(statements[0] ?? "") &&
  statements[0]?.includes(" RETURNING ") === true;
const MUTATION_STATEMENT = /^(?:UPDATE|INSERT|DELETE)\b/;
/** No statement is a CTE fold: the machinery D-15 deleted emitted nothing else. */
const noCteFold = (statements: string[]) =>
  statements.every((sql) => !sql.startsWith("WITH "));

describe("Phase 8.1 — the fold's statement traffic", () => {
  test("update + include is the located/mutated/re-read route, not one statement", async () => {
    const { driver, client } = await boot();

    driver.recording = true;
    const updated = await client.account.update({
      where: { id: 3 },
      data: { label: "changed" },
      include: { notes: true },
    });
    const statements = drain(driver);
    driver.recording = false;

    // THE measurement, re-expressed onto the shipped gate (D-15): `include` is a
    // relation projection, `returningSafeProjection` refuses it, and the three
    // statements the Phase-8 CTE folded into one are the three the shipped
    // engine sends — locate, mutate, re-read. The mutation still carries the
    // RETURNING the scalar fold answers its own row from.
    expect(noCteFold(statements)).toBe(true);
    expect(statements).toHaveLength(3);
    expect(statements[0]?.startsWith("SELECT")).toBe(true);
    expect(statements[1]?.startsWith("UPDATE")).toBe(true);
    expect(statements[1]).toContain(" RETURNING ");
    expect(statements[2]?.startsWith("SELECT")).toBe(true);

    expect(updated).toEqual({
      id: 3,
      email: "a3@x",
      label: "changed",
      managerId: null,
      notes: [
        { id: 30, body: "n30", accountId: 3 },
        { id: 31, body: "n31", accountId: 3 },
        { id: 32, body: "n32", accountId: 3 },
      ],
    });
    // …and the write landed.
    expect(
      await client.account.findUnique({
        where: { id: 3 },
        select: { label: true },
      })
    ).toEqual({ label: "changed" });
  });

  test("create + include is an INSERT and its terminal read, not one statement", async () => {
    const { driver, client } = await boot();

    driver.recording = true;
    const created = await client.account.create({
      data: { id: 100, email: "a100@x", label: "L100" },
      include: { notes: true },
    });
    const statements = drain(driver);
    driver.recording = false;

    // D-15: same gate, the `create` arm. A fresh root asks nothing first, so the
    // route is the INSERT and the terminal read — two, where the CTE made one.
    expect(noCteFold(statements)).toBe(true);
    expect(statements).toHaveLength(2);
    expect(statements[0]?.startsWith("INSERT")).toBe(true);
    expect(statements[1]?.startsWith("SELECT")).toBe(true);

    // A fresh row owns nothing, and the terminal read says so — the same `[]` the separate
    // terminal read answered.
    expect(created).toEqual({
      id: 100,
      email: "a100@x",
      label: "L100",
      managerId: null,
      notes: [],
    });
  });

  // PIN RE-EXPRESSED (D-15). The Phase-8 fold left this shape at two statements
  // — the in-unit presence guard and the CTE — by removing the locate and the
  // terminal read. With the CTE gone all four are back: planning locate, in-unit
  // presence guard, UPDATE, terminal SELECT. The guard is what the atomic batch
  // uses instead of a JS postcondition (PLAN Phase 6.2) and is unaffected.
  test("batch mode keeps its in-unit presence guard, and the route around it", async () => {
    const { driver, client } = await boot(true);

    driver.recording = true;
    const updated = await client.account.update({
      where: { id: 4 },
      data: { label: "batched" },
      include: { notes: true },
    });
    const statements = drain(driver);
    driver.recording = false;

    expect(noCteFold(statements)).toBe(true);
    expect(statements).toHaveLength(4);
    expect(statements[0]?.startsWith("SELECT")).toBe(true);
    expect(statements[1]).toContain("__viborm_assert__");
    expect(statements[2]?.startsWith("UPDATE")).toBe(true);
    expect(statements[3]?.startsWith("SELECT")).toBe(true);

    expect(updated).toEqual({
      id: 4,
      email: "a4@x",
      label: "batched",
      managerId: null,
      notes: [{ id: 40, body: "n40", accountId: 4 }],
    });
  });
});

/** The same reach as the two cases above, one combinator down. Hoisted out of
 *  the `as const` table below so the `AND` array stays mutable, which is what
 *  the typed `where` surface accepts. */
const filterUnderAnd = {
  include: {
    notes: { where: { AND: [{ account: { label: { equals: "oracle" } } }] } },
  },
};

describe("Phase 8.1 — the fold answers what the read answers", () => {
  /**
   * THE ORACLE. Each case runs the mutation and asserts its projection against
   * `findUnique`'s answer for the SAME projection on the SAME row — the control
   * the `_count` correlation defect got past on the RETURNING fold
   * (`delete-fold.test.ts`).
   *
   * D-15: every projection in this table is a RELATION projection, so the
   * shipped gate (`returningSafeProjection`) refuses every one of them and they
   * all take the same route — locate, UPDATE, terminal read, plus the batch
   * leg's in-unit presence guard. The retired `folds` column that told them
   * apart went with the CTE, and each case's own note below is kept as the
   * record of why the RETIRED gate decided as it did. What the cases still do,
   * and what they were always strongest at, is the oracle: twelve distinct
   * projections, each answered identically by the mutation and by the read, on
   * both substrates.
   */
  const projections = [
    {
      name: "a to-many include",
      args: { include: { notes: true } },
    },
    {
      name: "a to-many include with its own select",
      args: { include: { notes: { select: { body: true } } } },
    },
    {
      name: "a to-many include with a where and an orderBy",
      args: {
        include: {
          notes: { where: { id: { gt: 30 } }, orderBy: { id: "desc" } },
        },
      },
    },
    {
      name: "_count with an explicit relation",
      args: { select: { id: true, _count: { select: { notes: true } } } },
    },
    {
      // DECLINES, and the reason is guard 1: the shorthand counts EVERY
      // relation, and `manager`/`reports` are self-relations — so this
      // projection reads the very table the statement changes. The oracle
      // still holds, which is the point of asserting the answer separately
      // from the fold decision.
      name: "_count shorthand (every relation)",
      args: { select: { id: true, _count: true } },
    },
    {
      name: "a select mixing scalars and a relation",
      args: { select: { label: true, notes: { select: { id: true } } } },
    },
    // ── The relation payload's FILTER reaches the mutated table ──────────────
    //
    // A relation payload's `where` compiles to a correlated subquery that READS
    // a table, and `note.account` reads the one this statement is updating. The
    // guard first shipped walking each payload's `select`/`include` and nothing
    // else, so these folded and answered on the PRE-update `label`. Both
    // directions are here on purpose: the first case is empty when it should be
    // full, the second full when it should be empty, and a walk that missed the
    // `where` cannot get both right by luck.
    {
      name: "an include filtered through a relation on the mutated table (NEW value)",
      args: {
        include: {
          notes: { where: { account: { label: { equals: "oracle" } } } },
        },
      },
    },
    {
      name: "an include filtered through a relation on the mutated table (OLD value)",
      args: {
        include: { notes: { where: { account: { label: { equals: "L3" } } } } },
      },
    },
    {
      // The walk is over the whole payload, not over a list of keys that may
      // carry a filter: an array element is walked like any other value.
      name: "the same filter under an AND",
      args: filterUnderAnd,
    },
    {
      // `_count`'s per-relation `where` reaches by the identical mechanism, and
      // it answered 0 against a truth of 3.
      name: "_count whose per-relation where reaches the mutated table",
      args: {
        select: {
          id: true,
          _count: {
            select: {
              notes: { where: { account: { label: { equals: "oracle" } } } },
            },
          },
        },
      },
    },
    {
      // `orderBy` reads a table exactly as `where` does.
      name: "an include ordered through a relation on the mutated table",
      args: { include: { notes: { orderBy: { account: { label: "asc" } } } } },
    },
    {
      // ANTI-VACUITY for the five above. The correction is "walk the payload for
      // a reach", NOT "decline any payload carrying a filter" — a `where`, an
      // `orderBy` and a `cursor` over the CHILD's own columns read only the
      // untouched child table, and they still fold into ONE statement. The
      // `where`+`orderBy` case earlier in this list is the other half of this.
      name: "a to-many include with a cursor on the child's own key",
      args: {
        include: {
          notes: { cursor: { id: 31 }, orderBy: { id: "asc" }, take: 5 },
        },
      },
    },
  ] as const;

  for (const projection of projections) {
    test(`${projection.name} answers what the read answers, on both substrates`, async () => {
      const { client: truthClient } = await boot();
      // The control reads the row AFTER the same write, through the read path.
      await truthClient.account.update({
        where: { id: 3 },
        data: { label: "oracle" },
      });
      const truth = await truthClient.account.findUnique({
        where: { id: 3 },
        ...projection.args,
      });

      for (const batch of [false, true]) {
        const { driver, client } = await boot(batch);
        driver.recording = true;
        const answer = await client.account.update({
          where: { id: 3 },
          data: { label: "oracle" },
          ...projection.args,
        });
        const statements = drain(driver);
        driver.recording = false;

        expect(answer).toEqual(truth);
        // …and by the route the SHIPPED gate chooses, not another one: no CTE
        // fold exists to take, the mutation is its own statement, and the
        // projection is shaped by the terminal read that follows it.
        expect(noCteFold(statements)).toBe(true);
        expect(statements).toHaveLength(batch ? 4 : 3);
        expect(statements[batch ? 2 : 1]?.startsWith("UPDATE")).toBe(true);
        expect(statements.at(-1)?.startsWith("SELECT")).toBe(true);
      }
    });
  }

  test("a create's include answers what the read answers, through its terminal read", async () => {
    const { client: truthClient } = await boot();
    await truthClient.account.create({
      data: { id: 200, email: "a200@x", label: "L200" },
    });
    const truth = await truthClient.account.findUnique({
      where: { id: 200 },
      select: { id: true, _count: { select: { notes: true } } },
    });

    const { driver, client } = await boot();
    driver.recording = true;
    const created = await client.account.create({
      data: { id: 200, email: "a200@x", label: "L200" },
      select: { id: true, _count: { select: { notes: true } } },
    });
    const statements = drain(driver);
    driver.recording = false;

    expect(created).toEqual(truth);
    // D-15: `_count` is a relation projection too (`g4/unit02/note.md` §4.4), so
    // the create answers through its terminal read rather than through a CTE.
    expect(noCteFold(statements)).toBe(true);
    expect(statements).toHaveLength(2);
    expect(statements[0]?.startsWith("INSERT")).toBe(true);
    expect(statements[1]?.startsWith("SELECT")).toBe(true);
  });
});

describe("Phase 8.1 — the two legality guards", () => {
  /**
   * GUARD 1 — the projection reaches the MUTATED model. `manager` and `reports`
   * are self-relations on `account`: their subquery reads the very table the CTE
   * is updating, and inside one PostgreSQL command that read is the
   * PRE-statement snapshot. Folding a row that is its OWN manager would hand
   * back the pre-update copy of itself.
   */
  test("a self-managed row declines the fold and answers with its POST-update self", async () => {
    const { driver, client } = await boot();

    driver.recording = true;
    const updated = await client.account.update({
      where: { id: 7 },
      data: { label: "renamed" },
      include: { manager: true },
    });
    const statements = drain(driver);
    driver.recording = false;

    // THE answer a fold would get wrong — asserted FIRST, so removing the guard
    // shows the wrong answer and not merely the wrong route: account 7 IS its
    // own manager, so the nested copy must carry the new label. A CTE would
    // read it from the pre-statement snapshot and hand back "L7".
    expect(updated).toEqual({
      id: 7,
      email: "a7@x",
      label: "renamed",
      managerId: 7,
      manager: {
        id: 7,
        email: "a7@x",
        label: "renamed",
        managerId: 7,
      },
    });
    expect(statements.some((sql) => sql.startsWith("WITH "))).toBe(false);
    expect(statements.length).toBeGreaterThan(1);
  });

  test("a plain self-relation declines it too, and matches the read", async () => {
    const { driver, client } = await boot();

    driver.recording = true;
    const updated = await client.account.update({
      where: { id: 9 },
      data: { label: "self" },
      include: { manager: true },
    });
    const statements = drain(driver);
    driver.recording = false;

    expect(statements.some((sql) => sql.startsWith("WITH "))).toBe(false);
    expect(updated).toEqual(
      await client.account.findUnique({
        where: { id: 9 },
        include: { manager: true },
      })
    );
  });

  test("a self-relation nested two levels down declines it too", async () => {
    const { driver, client } = await boot();

    driver.recording = true;
    await client.account.update({
      where: { id: 3 },
      data: { label: "deep" },
      include: { notes: { include: { account: true } } },
    });
    const statements = drain(driver);
    driver.recording = false;

    // `notes` alone would fold; `notes.account` walks back to `p81_accounts`,
    // which is what the statement changes. The walk is what catches it.
    expect(statements.some((sql) => sql.startsWith("WITH "))).toBe(false);
  });

  /**
   * GUARD 2 — the SET can fire a referential action. `note.accountId` is
   * `ON UPDATE CASCADE` onto `account.id`, so rewriting the primary key rewrites
   * the child rows inside the same statement — and the outer SELECT would read
   * them from the pre-cascade snapshot, under the NEW key, and find none.
   */
  test("a primary-key rewrite with a to-many include declines the fold and carries the children", async () => {
    const { driver, client } = await boot();

    driver.recording = true;
    const updated = await client.account.update({
      where: { id: 3 },
      data: { id: 33 },
      include: { notes: true },
    });
    const statements = drain(driver);
    driver.recording = false;

    // THE answer the fold would have got wrong — asserted FIRST, so removing
    // the guard shows the wrong answer and not merely the wrong route: three
    // cascaded children under the new key, not the empty list a pre-cascade
    // snapshot reports.
    expect(updated).toEqual({
      id: 33,
      email: "a3@x",
      label: "L3",
      managerId: null,
      notes: [
        { id: 30, body: "n30", accountId: 33 },
        { id: 31, body: "n31", accountId: 33 },
        { id: 32, body: "n32", accountId: 33 },
      ],
    });
    expect(statements.some((sql) => sql.startsWith("WITH "))).toBe(false);
  });

  test("a rewrite of a UNIQUE INDEX column declines too, and carries its cascaded children", async () => {
    const family = getHostFamily();
    const driver = new RecordingPGliteDriver({
      client: family.database,
      namespace: family.namespace,
    });
    const client = createClient({ schema: hostSchema, driver });
    await client.host.create({ data: { id: 1, code: "OLD", label: "h" } });
    await client.pet.create({ data: { id: 10, name: "p1", hostCode: "OLD" } });
    await client.pet.create({ data: { id: 11, name: "p2", hostCode: "OLD" } });

    driver.recording = true;
    const updated = await client.host.update({
      where: { id: 1 },
      data: { code: "NEW" },
      include: { pets: true },
    });
    const statements = drain(driver);
    driver.recording = false;

    // Answer FIRST. `code` is in no unique CONSTRAINT — only in a unique INDEX —
    // so a guard that asked `getTargetIdentityFields` folded this and reported
    // the cascaded children as an empty list.
    expect(updated).toEqual({
      id: 1,
      code: "NEW",
      label: "h",
      pets: [
        { id: 10, name: "p1", hostCode: "NEW" },
        { id: 11, name: "p2", hostCode: "NEW" },
      ],
    });
    expect(statements.some((sql) => sql.startsWith("WITH "))).toBe(false);
  });

  test("on that same model, a scalar-only projection still folds", async () => {
    const family = getHostFamily();
    const driver = new RecordingPGliteDriver({
      client: family.database,
      namespace: family.namespace,
    });
    const client = createClient({ schema: hostSchema, driver });
    await client.host.create({ data: { id: 2, code: "K2", label: "h2" } });
    await client.pet.create({ data: { id: 20, name: "q1", hostCode: "K2" } });

    driver.recording = true;
    const updated = await client.host.update({
      where: { id: 2 },
      data: { label: "renamed" },
      include: { pets: true },
    });
    const statements = drain(driver);
    driver.recording = false;

    // ANTI-VACUITY, re-expressed onto the shipped gate (D-15). The retired
    // guard 2 asked what the SET rewrites, and this case witnessed that widening
    // it to unique indexes had not turned it into "never fold a model that has
    // one". The shipped gate asks about the PROJECTION instead
    // (`returningSafeProjection`), so the same `label` SET folds or not by what
    // it answers with: a relation projection takes the three-statement route…
    expect(noCteFold(statements)).toBe(true);
    expect(statements).toHaveLength(3);
    expect(updated).toEqual({
      id: 2,
      code: "K2",
      label: "renamed",
      pets: [{ id: 20, name: "q1", hostCode: "K2" }],
    });

    // …and a scalar-only projection over the very same SET is still ONE
    // statement, the mutation answering out of its own RETURNING. That is the
    // fold Raptor 3 ports, and this model has a unique index all the same.
    driver.recording = true;
    const renamed = await client.host.update({
      where: { id: 2 },
      data: { label: "renamed twice" },
      select: { id: true, label: true },
    });
    const scalarOnly = drain(driver);
    driver.recording = false;
    expect(foldedInOneStatement(scalarOnly)).toBe(true);
    expect(renamed).toEqual({ id: 2, label: "renamed twice" });
  });

  test("a unique rewrite with a scalar-only projection is untouched by guard 2", async () => {
    const { driver, client } = await boot();

    driver.recording = true;
    const updated = await client.account.update({
      where: { id: 5 },
      data: { email: "moved@x" },
    });
    const statements = drain(driver);
    driver.recording = false;

    // The scalar fold is the pre-Phase-8 `UPDATE … RETURNING`, whose legality
    // never depended on a snapshot: no relation is read at all.
    expect(statements).toHaveLength(1);
    expect(statements[0]?.startsWith("UPDATE")).toBe(true);
    expect(updated.email).toBe("moved@x");
  });
});

describe("Phase 8.1 — what the fold must not change", () => {
  test("a missed target raises the same NotFoundError, on both substrates", async () => {
    for (const batch of [false, true]) {
      const { client } = await boot(batch);
      await expect(
        client.account.update({
          where: { id: 4242 },
          data: { label: "ghost" },
          include: { notes: true },
        })
      ).rejects.toBeInstanceOf(NotFoundError);
    }
  });

  /**
   * Failure attribution through constraint names. The folded statement violates
   * a unique constraint INSIDE the CTE, and the driver must still map it to the
   * typed error the unfolded path raised — same class, and naming the same
   * field, not a raw driver error escaping through the new statement shape.
   */
  test("a constraint violated inside the CTE keeps its typed attribution", async () => {
    const { client } = await boot();

    const folded = await client.account
      .update({
        where: { id: 6 },
        data: { email: "a7@x" },
        include: { notes: true },
      })
      .catch((error: unknown) => error);
    const unfolded = await client.account
      .update({ where: { id: 6 }, data: { email: "a7@x" } })
      .catch((error: unknown) => error);

    expect(folded).toBeInstanceOf(UniqueConstraintError);
    expect(unfolded).toBeInstanceOf(UniqueConstraintError);
    expect((folded as UniqueConstraintError).message).toBe(
      (unfolded as UniqueConstraintError).message
    );
    // …and nothing was written by the aborted fold.
    expect(
      await client.account.findUnique({
        where: { id: 6 },
        select: { email: true },
      })
    ).toEqual({ email: "a6@x" });
  });

  /**
   * NON-PG DIALECTS ARE BYTE-IDENTICAL TO BEFORE. SQLite's `WITH` admits a
   * SELECT and nothing else (measured on 3.51.2: `near "UPDATE": syntax
   * error`), which is exactly what `supportsCteWithMutations: false` now says —
   * corrected in this phase, PLAN 10.1. The gate reads that flag, so SQLite
   * keeps the three-statement path.
   */
  test("SQLite keeps the unfolded path and the same answer", async () => {
    const sqliteClient = createClient({
      schema,
      driver: new SQLite3Driver({ dataDir: ":memory:" }),
    });
    await syncLiveSchema(sqliteClient);
    for (const id of [1, 2, 3]) {
      await sqliteClient.account.create({
        data: { id, email: `a${id}@x`, label: `L${id}` },
      });
    }
    for (const id of [30, 31]) {
      await sqliteClient.note.create({
        data: { id, body: `n${id}`, accountId: 3 },
      });
    }

    const updated = await sqliteClient.account.update({
      where: { id: 3 },
      data: { label: "sqlite" },
      include: { notes: true },
    });
    expect(updated).toEqual(
      await sqliteClient.account.findUnique({
        where: { id: 3 },
        include: { notes: true },
      })
    );
  });

  test("a model nothing references takes the same route as the cascading one", async () => {
    const family = getSoloFamily();
    const driver = new RecordingPGliteDriver({
      client: family.database,
      namespace: family.namespace,
    });
    const client = createClient({ schema: soloSchema, driver });
    await client.tag.create({ data: { id: 1, name: "red", color: "#f00" } });
    await client.palette.create({ data: { id: 1, title: "warm" } });

    driver.recording = true;
    const updated = await client.tag.update({
      where: { id: 1 },
      data: { color: "#00f" },
      select: { id: true, _count: { select: { palettes: true } } },
    });
    const statements = drain(driver);
    driver.recording = false;

    // The retired guard 2 asked what the SET rewrites, not whether the model has
    // relations: `color` is in no unique constraint, so no action could fire and
    // the m2m `_count` folded here while the cascading model's key rewrite
    // declined. D-15 retired that question with the CTE. The shipped gate asks
    // about the PROJECTION, and `_count` is a relation projection on both models
    // (`g4/unit02/note.md` §4.4) — so the route is the same three statements on
    // either, and what is left to tell is that the answer is the read's.
    expect(noCteFold(statements)).toBe(true);
    expect(statements).toHaveLength(3);
    expect(updated).toEqual(
      await client.tag.findUnique({
        where: { id: 1 },
        select: { id: true, _count: { select: { palettes: true } } },
      })
    );
  });
});

/**
 * PHASE 8.2 — the guard-free nested-create tree, folded into one statement.
 *
 * MEASURED at c9c06e5, PGlite, before the fold: a root plus two nested children
 * sent FOUR statements — three INSERTs and the terminal read. After: one.
 *
 * The fresh-parent elision ladder (ATOM §4) is what made it legal: a child of a
 * row this operation is creating cannot pre-exist, so no correlated probe under
 * it can match, and the tree asks the database nothing before it writes. That is
 * why the fold's gate was spelled "no guards, and no statement reads another
 * statement's output" rather than as a shape whitelist.
 *
 * D-15 retired that machinery with the rest of the CTE (`"__viborm_write_n"`
 * sibling arms included), so the four statements are back and the cells below
 * pin the route the shipped engine sends: one statement per arm, in the order
 * the payload declared them, then the terminal read. The elision ladder itself
 * is untouched — it is why none of these trees asks anything first — and every
 * declining case in this describe still declines, for the reason it always did.
 */
describe("Phase 8.2 — the nested-create tree", () => {
  test("a root and its two children are one INSERT per arm, in declaration order", async () => {
    const { driver, client } = await boot();

    driver.recording = true;
    const created = await client.account.create({
      data: {
        id: 300,
        email: "a300@x",
        label: "L300",
        notes: {
          create: [
            { id: 3000, body: "b0" },
            { id: 3001, body: "b1" },
          ],
        },
      },
    });
    const statements = drain(driver);
    driver.recording = false;

    // THE measurement, re-expressed (D-15): the four statements the tree fold
    // chained into one are the four the shipped engine sends — the root's INSERT,
    // one INSERT per arm in the payload's order, and the terminal read.
    expect(noCteFold(statements)).toBe(true);
    expect(statements).toHaveLength(4);
    expect(statements[0]).toContain('"p81_accounts"');
    expect(statements[1]).toContain('"p81_notes"');
    expect(statements[2]).toContain('"p81_notes"');
    expect(statements[3]?.startsWith("SELECT")).toBe(true);

    expect(created).toEqual({
      id: 300,
      email: "a300@x",
      label: "L300",
      managerId: null,
    });
    // …and every row of the tree is there, with the edges the tree declared.
    expect(
      await client.note.findMany({
        where: { accountId: 300 },
        orderBy: { id: "asc" },
      })
    ).toEqual([
      { id: 3000, body: "b0", accountId: 300 },
      { id: 3001, body: "b1", accountId: 300 },
    ]);
  });

  test("a nested createMany rides the same route, one INSERT per row", async () => {
    const { driver, client } = await boot();

    driver.recording = true;
    await client.account.create({
      data: {
        id: 301,
        email: "a301@x",
        label: "L301",
        notes: {
          createMany: {
            data: [
              { id: 3010, body: "c0" },
              { id: 3011, body: "c1" },
            ],
          },
        },
      },
    });
    const statements = drain(driver);
    driver.recording = false;

    expect(noCteFold(statements)).toBe(true);
    expect(statements).toHaveLength(4);
    expect(statements[1]).toContain('"p81_notes"');
    expect(statements[2]).toContain('"p81_notes"');
    expect(
      await client.note.findMany({ where: { accountId: 301 } })
    ).toHaveLength(2);
  });

  test("a constraint violated in a child arm rolls the whole tree back", async () => {
    const { client } = await boot();

    await expect(
      client.account.create({
        data: {
          id: 302,
          email: "a302@x",
          label: "L302",
          notes: {
            create: [
              { id: 3020, body: "d0" },
              // Same primary key as its sibling: the second arm violates the
              // child table's own constraint.
              { id: 3020, body: "d1" },
            ],
          },
        },
      })
    ).rejects.toBeInstanceOf(UniqueConstraintError);

    // Statement-atomic: nothing of the tree survives, not the parent and not the
    // child arm that would have succeeded on its own.
    expect(await client.account.findUnique({ where: { id: 302 } })).toBeNull();
    expect(await client.note.findUnique({ where: { id: 3020 } })).toBeNull();
  });

  test("an include declines the tree fold and reads the children it just wrote", async () => {
    const { driver, client } = await boot();

    driver.recording = true;
    const created = await client.account.create({
      data: {
        id: 303,
        email: "a303@x",
        label: "L303",
        notes: { create: [{ id: 3030, body: "e0" }] },
      },
      include: { notes: true },
    });
    const statements = drain(driver);
    driver.recording = false;

    // THE answer the fold would have got wrong: the sibling arms' effects are
    // invisible to the outer SELECT of the same command, so a folded include
    // would report the empty pre-statement truth.
    expect(created).toEqual({
      id: 303,
      email: "a303@x",
      label: "L303",
      managerId: null,
      notes: [{ id: 3030, body: "e0", accountId: 303 }],
    });
    expect(statements.some((sql) => sql.startsWith("WITH "))).toBe(false);
  });

  test("TWO database-generated keys decline: their sequence order is the planner's", async () => {
    const family = getSequenceFamily();
    const driver = new RecordingPGliteDriver({
      client: family.database,
      namespace: family.namespace,
    });
    const client = createClient({ schema: seqSchema, driver });

    driver.recording = true;
    const created = await client.seq.create({
      data: { label: "G", kids: { create: [{ body: "k0" }] } },
    });
    const statements = drain(driver);
    driver.recording = false;

    expect(statements.some((sql) => sql.startsWith("WITH "))).toBe(false);
    expect(created).toEqual({ id: 1, label: "G" });
    // The child took the key the parent's INSERT generated. Package M can spell
    // that value inside one command — `(SELECT "id" FROM "__viborm_mutation")` —
    // so the flow is no longer what declines here. The `kid` key is generated
    // TOO, and two arms taking a database-assigned value are two the planner may
    // run in either order. Removing Package M's lowering leaves this test green,
    // which is how it stays a control for one thing.
    expect(await client.kid.findMany()).toEqual([
      { id: 1, body: "k0", seqId: 1 },
    ]);
  });

  test("database-generated CHILD keys decline, and keep declaration order", async () => {
    // PostgreSQL does not specify the order it runs unread data-modifying `WITH`
    // arms in, and on PG 16 / PGlite it runs them LAST-TO-FIRST — so a folded
    // tree handed sequence value 1 to the last-declared child. Nothing in the
    // arms is a value another arm reads, so every other conjunct passes: this
    // one is the whole of what keeps the order the caller wrote.
    const family = getCrateFamily();
    const driver = new RecordingPGliteDriver({
      client: family.database,
      namespace: family.namespace,
    });
    const client = createClient({ schema: crateSchema, driver });

    driver.recording = true;
    await client.crate.create({
      data: {
        id: 1,
        label: "C",
        items: {
          create: [{ body: "i0" }, { body: "i1" }, { body: "i2" }],
        },
      },
    });
    const statements = drain(driver);
    driver.recording = false;

    // Answer FIRST: the ids follow the order the payload declared. Under the
    // fold they came back reversed — invisible in the operation's own result
    // (the tree fold requires a scalar-only projection), and wrong on disk.
    expect(await client.item.findMany({ orderBy: { id: "asc" } })).toEqual([
      { id: 1, body: "i0", crateId: 1 },
      { id: 2, body: "i1", crateId: 1 },
      { id: 3, body: "i2", crateId: 1 },
    ]);
    expect(statements.some((sql) => sql.startsWith("WITH "))).toBe(false);
  });

  test("ONE arm taking a generated key keeps the caller's row order across its INSERTs", async () => {
    const family = getCrateFamily();
    const driver = new RecordingPGliteDriver({
      client: family.database,
      namespace: family.namespace,
    });
    const client = createClient({ schema: crateSchema, driver });

    driver.recording = true;
    await client.crate.create({
      data: {
        id: 2,
        label: "D",
        items: {
          createMany: { data: [{ body: "j0" }, { body: "j1" }] },
        },
      },
    });
    const statements = drain(driver);
    driver.recording = false;

    // ANTI-VACUITY, re-expressed (D-15). The retired conjunct was "at most one
    // arm", not "no generated keys": a multi-row INSERT assigned its sequence
    // values in its own VALUES order, which the planner did not get to choose,
    // so this shape folded where its two-arm sibling above declined. With the
    // tree fold gone the arm is one INSERT per row, sent in the payload's order,
    // and the row order it produces is the same one — which is the claim this
    // case was ever making.
    expect(noCteFold(statements)).toBe(true);
    expect(statements).toHaveLength(4);
    expect(statements[1]).toContain('"p82_item"');
    expect(statements[2]).toContain('"p82_item"');
    expect(
      await client.item.findMany({
        where: { crateId: 2 },
        orderBy: { id: "asc" },
      })
    ).toEqual([
      { id: 1, body: "j0", crateId: 2 },
      { id: 2, body: "j1", crateId: 2 },
    ]);
  });

  test("a tree that PROBED declines: it has already spent the round trip", async () => {
    const { driver, client } = await boot();
    await client.note.create({
      data: { id: 3050, body: "orphan", accountId: 1 },
    });

    driver.recording = true;
    await client.account.create({
      data: {
        id: 305,
        email: "a305@x",
        label: "L305",
        notes: { connect: [{ id: 3050 }] },
      },
    });
    const statements = drain(driver);
    driver.recording = false;

    // A child-held `connect` under a fresh root has no correlated probe to run
    // (elision), but it does have to verify the target EXISTS — a planning read
    // whose rows the client reads to decide. Merging the write after that buys a
    // statement and loses nothing, but it also does not restore the property the
    // fold is for, so the gate keeps the honest line at "asked nothing".
    expect(statements.some((sql) => sql.startsWith("WITH "))).toBe(false);
    expect(
      await client.note.findUnique({
        where: { id: 3050 },
        select: { accountId: true },
      })
    ).toEqual({ accountId: 305 });
  });

  test("a tree that PROBED declines: the parent-held connect, where only the planning conjunct stands", async () => {
    // P8/P9 review (blocking): the child-held sibling above is ALSO declined by
    // the order-insensitivity classification (its connect write comes from a
    // Part), so deleting the empty-planning conjunct left that witness green —
    // coincidental coverage. A PARENT-held to-one connect is classified, so the
    // ONLY conjunct standing between it and the fold is planningSteps.length
    // === 0 — its probe is a `SELECT … FOR UPDATE` planning read. This witness
    // fails if that conjunct is deleted.
    const { driver, client } = await boot();

    driver.recording = true;
    await client.account.create({
      data: {
        id: 306,
        email: "a306@x",
        label: "L306",
        manager: { connect: { id: 5 } },
        notes: { create: [{ id: 3060, body: "n" }] },
      },
    });
    const statements = drain(driver);
    driver.recording = false;

    expect(statements.some((sql) => sql.startsWith("WITH "))).toBe(false);
    expect(
      await client.account.findUnique({
        where: { id: 306 },
        select: { managerId: true },
      })
    ).toEqual({ managerId: 5 });
    expect(
      await client.note.findUnique({
        where: { id: 3060 },
        select: { accountId: true },
      })
    ).toEqual({ accountId: 306 });
  });

  test("a folded tree declines when a skip-carrying arm shares its table with another arm", async () => {
    // P8/P9 review (blocking): ON CONFLICT DO NOTHING cannot see a tuple another
    // arm of the SAME command inserted, so folding this shape turned a succeeding
    // create into a UniqueConstraintError with nothing written. The gate now
    // declines it; the unfolded path keeps skipDuplicates' contract.
    const { driver, client } = await boot();

    driver.recording = true;
    const created = await client.account.create({
      data: {
        id: 307,
        email: "a307@x",
        label: "L307",
        notes: {
          create: [{ id: 3070, body: "A" }],
          createMany: {
            data: [
              { id: 3070, body: "B" },
              { id: 3071, body: "C" },
            ],
            skipDuplicates: true,
          },
        },
      },
    });
    const statements = drain(driver);
    driver.recording = false;

    expect(created).toMatchObject({ id: 307 });
    expect(statements.some((sql) => sql.startsWith("WITH "))).toBe(false);
    // The duplicate skipped, the sibling landed — skipDuplicates' promise.
    const notes = await client.note.findMany({
      where: { accountId: 307 },
      orderBy: { id: "asc" },
      select: { id: true, body: true },
    });
    expect(notes).toEqual([
      { id: 3070, body: "A" },
      { id: 3071, body: "C" },
    ]);
  });

  test("a skip-carrying arm on another table takes a member rollback region per row", async () => {
    const { driver, client } = await boot();

    driver.recording = true;
    await client.account.create({
      data: {
        id: 308,
        email: "a308@x",
        label: "L308",
        notes: {
          createMany: {
            data: [
              { id: 3080, body: "A" },
              { id: 3081, body: "B" },
            ],
            skipDuplicates: true,
          },
        },
      },
    });
    const statements = drain(driver);
    driver.recording = false;

    // D-15 retired the tree fold, and what this arm shows instead is the shipped
    // `skipDuplicates` mechanism on the live route: each row's INSERT inside its
    // OWN member rollback region (`SAVEPOINT` / `RELEASE SAVEPOINT`), which is
    // the region G3P-04 names and the atomic-batch leg refuses for want of.
    expect(noCteFold(statements)).toBe(true);
    expect(statements).toHaveLength(8);
    expect(
      statements.filter((sql) => sql.startsWith("SAVEPOINT "))
    ).toHaveLength(2);
    expect(
      statements.filter((sql) => sql.startsWith("RELEASE SAVEPOINT "))
    ).toHaveLength(2);
    expect(
      await client.note.findMany({
        where: { accountId: 308 },
        orderBy: { id: "asc" },
        select: { id: true },
      })
    ).toEqual([{ id: 3080 }, { id: 3081 }]);
  });

  test("a self-relation skip arm declines because it shares the root table", async () => {
    const { driver, client } = await boot();

    driver.recording = true;
    await client.account.create({
      data: {
        id: 309,
        email: "a309@x",
        label: "L309",
        reports: {
          createMany: {
            data: [{ id: 3090, email: "a3090@x", label: "report" }],
            skipDuplicates: true,
          },
        },
      },
    });
    const statements = drain(driver);
    driver.recording = false;

    expect(statements.some((sql) => sql.startsWith("WITH "))).toBe(false);
    expect(
      await client.account.findUnique({
        where: { id: 3090 },
        select: { managerId: true },
      })
    ).toEqual({ managerId: 309 });
  });

  test("a lone scalar create keeps its own single-statement fold", async () => {
    const { driver, client } = await boot();

    driver.recording = true;
    await client.account.create({
      data: { id: 304, email: "a304@x", label: "L304" },
    });
    const statements = drain(driver);
    driver.recording = false;

    // Phase 8.2 needs at least one sibling arm to be worth a CTE; a childless
    // create still rides the plain `INSERT … RETURNING <select>` it always did.
    expect(statements).toHaveLength(1);
    expect(statements[0]?.startsWith("INSERT")).toBe(true);
  });
});
