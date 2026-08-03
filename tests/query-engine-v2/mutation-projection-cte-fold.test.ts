import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { SQLite3Driver } from "@drivers/sqlite3";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { NotFoundError, UniqueConstraintError } from "@errors";
import { push } from "@migrations";
import { hydrateSchemaNames, s } from "@schema";
import { beforeAll, describe, expect, test } from "vitest";

/**
 * PHASE 8.1 — the terminal read, folded into the mutating statement
 * (query-performance-plan).
 *
 * A mutation that answers with a RELATION projection used to send its write and
 * then a separate `SELECT` to shape the answer. On PostgreSQL the two are now one
 * statement:
 *
 *   WITH "__viborm_mutation" AS (UPDATE … RETURNING <every column>)
 *   SELECT <projection over the CTE> FROM "__viborm_mutation" AS "t0"
 *
 * MEASURED at c9c06e5, PGlite, before the fold:
 *   update + include, transaction ....... 3 statements (locate, UPDATE, SELECT)
 *   update + include, atomic batch ...... 4 statements (locate, guard, UPDATE, SELECT)
 *   update + `_count`, transaction ...... 3 statements
 *   create + include, transaction ....... 2 statements (INSERT, SELECT)
 * and after: 1, 2 (the batch keeps its in-unit presence guard), 1, 1.
 *
 * The fold is legal only while the outer `SELECT` reads nothing the statement
 * CHANGES — PostgreSQL gives every sub-statement of one command the same
 * snapshot, so a read of a changed table answers pre-statement. Two guards say
 * so, and both are witnessed here declining:
 *   · `projectionReadsMutatedModel` — a self-relation in the projection.
 *   · `setCanFireReferentialAction` — a SET that can cascade into a child table.
 *
 * The ORACLE below is what makes the whole thing checkable: every folded answer
 * is asserted against the SAME projection read back through `findUnique`, on the
 * same row, over seeded state. Not against a literal, and not only on the
 * substrate that happens to fold.
 */

const account = s
  .model({
    id: s.int().id(),
    email: s.string().unique(),
    label: s.string(),
    notes: s.oneToMany(() => note),
    managerId: s.int().nullable(),
    manager: s
      .manyToOne(() => account)
      .fields("managerId")
      .references("id")
      .optional(),
    reports: s.oneToMany(() => account),
  })
  .map("p81_accounts");

const note = s
  .model({
    id: s.int().id(),
    body: s.string(),
    accountId: s.int(),
    account: s
      .manyToOne(() => account)
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
    palettes: s.manyToMany(() => palette),
  })
  .map("p81_tags");
const palette = s
  .model({
    id: s.int().id(),
    title: s.string(),
    tags: s.manyToMany(() => tag),
  })
  .map("p81_palettes");
const soloSchema = { tag, palette };

/** Phase 8.2's declining control: a model whose primary key the DATABASE
 *  generates. Its children's foreign key is a value that only exists once the
 *  parent INSERT has run, and a `WITH` arm cannot read what a sibling wrote. */
const seq = s
  .model({
    id: s.int().id().increment(),
    label: s.string(),
    kids: s.oneToMany(() => kid),
  })
  .map("p82_seq");
const kid = s
  .model({
    id: s.int().id().increment(),
    body: s.string(),
    seqId: s.int(),
    parent: s
      .manyToOne(() => seq)
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
    items: s.oneToMany(() => item),
  })
  .map("p82_crate");
const item = s
  .model({
    id: s.int().id().increment(),
    body: s.string(),
    crateId: s.int(),
    holder: s
      .manyToOne(() => crate)
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
    pets: s.oneToMany(() => pet),
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
      .manyToOne(() => host)
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

async function boot(driver: RecordingPGliteDriver) {
  const client = createClient({ schema, driver });
  await push(client, { force: true });
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
  return client;
}

function drain(driver: RecordingPGliteDriver): string[] {
  return driver.statements.splice(0, driver.statements.length);
}

const foldedInOneStatement = (statements: string[]) =>
  statements.length === 1 && statements[0]?.startsWith("WITH ") === true;

describe("Phase 8.1 — the fold's statement traffic", () => {
  test("update + include is ONE statement, and it is the CTE", async () => {
    const driver = new RecordingPGliteDriver();
    const client = await boot(driver);

    driver.recording = true;
    const updated = await client.account.update({
      where: { id: 3 },
      data: { label: "changed" },
      include: { notes: true },
    });
    const statements = drain(driver);
    driver.recording = false;

    // THE measurement: three payload statements became one.
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('WITH "__viborm_mutation" AS (UPDATE');
    expect(statements[0]).toContain('FROM "__viborm_mutation"');

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

  test("create + include is ONE statement, and it is the CTE", async () => {
    const driver = new RecordingPGliteDriver();
    const client = await boot(driver);

    driver.recording = true;
    const created = await client.account.create({
      data: { id: 100, email: "a100@x", label: "L100" },
      include: { notes: true },
    });
    const statements = drain(driver);
    driver.recording = false;

    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('WITH "__viborm_mutation" AS (INSERT');

    // A fresh row owns nothing, and the CTE says so — the same `[]` the separate
    // terminal read answered.
    expect(created).toEqual({
      id: 100,
      email: "a100@x",
      label: "L100",
      managerId: null,
      notes: [],
    });
  });

  // PIN UPDATED DELIBERATELY. This shape sent four statements (planning locate,
  // in-unit presence guard, UPDATE, terminal SELECT). The guard is what the
  // atomic batch uses instead of a JS postcondition (PLAN Phase 6.2), so it
  // stays; the locate and the terminal read are what the fold removes.
  test("batch mode folds behind its in-unit presence guard", async () => {
    const driver = new BatchOnlyRecordingDriver();
    const client = await boot(driver);

    driver.recording = true;
    const updated = await client.account.update({
      where: { id: 4 },
      data: { label: "batched" },
      include: { notes: true },
    });
    const statements = drain(driver);
    driver.recording = false;

    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("__viborm_assert__");
    expect(statements[1]).toContain('WITH "__viborm_mutation" AS (UPDATE');

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
   * THE ORACLE. Each case runs the mutation folded and asserts its projection
   * against `findUnique`'s answer for the SAME projection on the SAME row — the
   * control the `_count` correlation defect got past on the RETURNING fold
   * (`delete-fold.test.ts`), and the reason this fold projects over an aliased
   * `FROM` instead.
   */
  const projections = [
    {
      name: "a to-many include",
      folds: true,
      args: { include: { notes: true } },
    },
    {
      name: "a to-many include with its own select",
      folds: true,
      args: { include: { notes: { select: { body: true } } } },
    },
    {
      name: "a to-many include with a where and an orderBy",
      folds: true,
      args: {
        include: {
          notes: { where: { id: { gt: 30 } }, orderBy: { id: "desc" } },
        },
      },
    },
    {
      name: "_count with an explicit relation",
      folds: true,
      args: { select: { id: true, _count: { select: { notes: true } } } },
    },
    {
      // DECLINES, and the reason is guard 1: the shorthand counts EVERY
      // relation, and `manager`/`reports` are self-relations — so this
      // projection reads the very table the statement changes. The oracle
      // still holds, which is the point of asserting the answer separately
      // from the fold decision.
      name: "_count shorthand (every relation)",
      folds: false,
      args: { select: { id: true, _count: true } },
    },
    {
      name: "a select mixing scalars and a relation",
      folds: true,
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
      folds: false,
      args: {
        include: {
          notes: { where: { account: { label: { equals: "oracle" } } } },
        },
      },
    },
    {
      name: "an include filtered through a relation on the mutated table (OLD value)",
      folds: false,
      args: {
        include: { notes: { where: { account: { label: { equals: "L3" } } } } },
      },
    },
    {
      // The walk is over the whole payload, not over a list of keys that may
      // carry a filter: an array element is walked like any other value.
      name: "the same filter under an AND",
      folds: false,
      args: filterUnderAnd,
    },
    {
      // `_count`'s per-relation `where` reaches by the identical mechanism, and
      // it answered 0 against a truth of 3.
      name: "_count whose per-relation where reaches the mutated table",
      folds: false,
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
      folds: false,
      args: { include: { notes: { orderBy: { account: { label: "asc" } } } } },
    },
    {
      // ANTI-VACUITY for the five above. The correction is "walk the payload for
      // a reach", NOT "decline any payload carrying a filter" — a `where`, an
      // `orderBy` and a `cursor` over the CHILD's own columns read only the
      // untouched child table, and they still fold into ONE statement. The
      // `where`+`orderBy` case earlier in this list is the other half of this.
      name: "a to-many include with a cursor on the child's own key",
      folds: true,
      args: {
        include: {
          notes: { cursor: { id: 31 }, orderBy: { id: "asc" }, take: 5 },
        },
      },
    },
  ] as const;

  for (const projection of projections) {
    test(`${projection.name} answers what the read answers, on both substrates`, async () => {
      const truthDriver = new RecordingPGliteDriver();
      const truthClient = await boot(truthDriver);
      // The control reads the row AFTER the same write, through the read path.
      await truthClient.account.update({
        where: { id: 3 },
        data: { label: "oracle" },
      });
      const truth = await truthClient.account.findUnique({
        where: { id: 3 },
        ...projection.args,
      });

      for (const driver of [
        new RecordingPGliteDriver(),
        new BatchOnlyRecordingDriver(),
      ]) {
        const client = await boot(driver);
        driver.recording = true;
        const answer = await client.account.update({
          where: { id: 3 },
          data: { label: "oracle" },
          ...projection.args,
        });
        const statements = drain(driver);
        driver.recording = false;

        expect(answer).toEqual(truth);
        // …and by the route the gate chose, not another one.
        expect(statements.some((sql) => sql.startsWith("WITH "))).toBe(
          projection.folds
        );
      }
    });
  }

  test("a create's include folds to the read's answer", async () => {
    const truthDriver = new RecordingPGliteDriver();
    const truthClient = await boot(truthDriver);
    await truthClient.account.create({
      data: { id: 200, email: "a200@x", label: "L200" },
    });
    const truth = await truthClient.account.findUnique({
      where: { id: 200 },
      select: { id: true, _count: { select: { notes: true } } },
    });

    const driver = new RecordingPGliteDriver();
    const client = await boot(driver);
    driver.recording = true;
    const created = await client.account.create({
      data: { id: 200, email: "a200@x", label: "L200" },
      select: { id: true, _count: { select: { notes: true } } },
    });
    const statements = drain(driver);
    driver.recording = false;

    expect(created).toEqual(truth);
    expect(foldedInOneStatement(statements)).toBe(true);
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
    const driver = new RecordingPGliteDriver();
    const client = await boot(driver);

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
    const driver = new RecordingPGliteDriver();
    const client = await boot(driver);

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
    const driver = new RecordingPGliteDriver();
    const client = await boot(driver);

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
    const driver = new RecordingPGliteDriver();
    const client = await boot(driver);

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
    const driver = new RecordingPGliteDriver();
    const client = createClient({ schema: hostSchema, driver });
    await push(client, { force: true });
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

  test("on that same model, an ordinary column still folds", async () => {
    const driver = new RecordingPGliteDriver();
    const client = createClient({ schema: hostSchema, driver });
    await push(client, { force: true });
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

    // ANTI-VACUITY: widening guard 2 to unique indexes did not turn it into
    // "never fold a model that has one". `label` participates in nothing.
    expect(foldedInOneStatement(statements)).toBe(true);
    expect(updated).toEqual({
      id: 2,
      code: "K2",
      label: "renamed",
      pets: [{ id: 20, name: "q1", hostCode: "K2" }],
    });
  });

  test("a unique rewrite with a scalar-only projection is untouched by guard 2", async () => {
    const driver = new RecordingPGliteDriver();
    const client = await boot(driver);

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
    for (const driver of [
      new RecordingPGliteDriver(),
      new BatchOnlyRecordingDriver(),
    ]) {
      const client = await boot(driver);
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
    const driver = new RecordingPGliteDriver();
    const client = await boot(driver);

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
    await push(sqliteClient, { force: true });
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

  test("a model nothing references folds a key rewrite that the cascading model declines", async () => {
    const driver = new RecordingPGliteDriver();
    const client = createClient({ schema: soloSchema, driver });
    await push(client, { force: true });
    await client.tag.create({ data: { id: 1, name: "red", color: "#f00" } });
    await client.palette.create({ data: { id: 1, title: "warm" } });

    driver.recording = true;
    await client.tag.update({
      where: { id: 1 },
      data: { color: "#00f" },
      select: { id: true, _count: { select: { palettes: true } } },
    });
    const statements = drain(driver);
    driver.recording = false;

    // Guard 2 is about what the SET rewrites, not about the model having
    // relations: `color` is in no unique constraint, so no action can fire and
    // the m2m `_count` folds.
    expect(foldedInOneStatement(statements)).toBe(true);
  });
});

/**
 * PHASE 8.2 — the guard-free nested-create tree, folded into one statement.
 *
 * MEASURED at c9c06e5, PGlite, before the fold: a root plus two nested children
 * sent FOUR statements — three INSERTs and the terminal read. After: one.
 *
 * The fresh-parent elision ladder (ATOM §4) is what makes it legal: a child of a
 * row this operation is creating cannot pre-exist, so no correlated probe under
 * it can match, and the tree asks the database nothing before it writes. That is
 * why the fold's gate is spelled "no guards, and no statement reads another
 * statement's output" rather than as a shape whitelist.
 */
describe("Phase 8.2 — the nested-create tree", () => {
  test("a root and its two children are ONE statement", async () => {
    const driver = new RecordingPGliteDriver();
    const client = await boot(driver);

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

    // THE measurement: four statements became one.
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('WITH "__viborm_mutation" AS (INSERT');
    expect(statements[0]).toContain('"__viborm_write_0" AS (INSERT');
    expect(statements[0]).toContain('"__viborm_write_1" AS (INSERT');

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

  test("a nested createMany rides the same fold", async () => {
    const driver = new RecordingPGliteDriver();
    const client = await boot(driver);

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

    expect(statements).toHaveLength(1);
    expect(
      await client.note.findMany({ where: { accountId: 301 } })
    ).toHaveLength(2);
  });

  test("a constraint violated in a child arm rolls the whole tree back", async () => {
    const driver = new RecordingPGliteDriver();
    const client = await boot(driver);

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
    const driver = new RecordingPGliteDriver();
    const client = await boot(driver);

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

  test("a database-generated parent key declines: the child's FK is a value no arm can read", async () => {
    const driver = new RecordingPGliteDriver();
    const client = createClient({ schema: seqSchema, driver });
    await push(client, { force: true });

    driver.recording = true;
    const created = await client.seq.create({
      data: { label: "G", kids: { create: [{ body: "k0" }] } },
    });
    const statements = drain(driver);
    driver.recording = false;

    expect(statements.some((sql) => sql.startsWith("WITH "))).toBe(false);
    expect(created).toEqual({ id: 1, label: "G" });
    // The child took the key the parent's INSERT generated — which is exactly
    // the value one statement could not have carried between its arms.
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
    const driver = new RecordingPGliteDriver();
    const client = createClient({ schema: crateSchema, driver });
    await push(client, { force: true });

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

  test("ONE arm taking a generated key still folds: its row order is the statement's own", async () => {
    const driver = new RecordingPGliteDriver();
    const client = createClient({ schema: crateSchema, driver });
    await push(client, { force: true });

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

    // ANTI-VACUITY: the conjunct is "at most one arm", not "no generated keys".
    // A multi-row INSERT assigns its sequence values in its own VALUES order,
    // which the planner does not get to choose — so this one folds, and the
    // rows still come back in the order they were written.
    expect(foldedInOneStatement(statements)).toBe(true);
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
    const driver = new RecordingPGliteDriver();
    const client = await boot(driver);
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

  test("a lone scalar create keeps its own single-statement fold", async () => {
    const driver = new RecordingPGliteDriver();
    const client = await boot(driver);

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
