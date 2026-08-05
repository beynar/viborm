import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { NestedWriteError } from "@errors";
import { push } from "@migrations";
import { createQueryScope } from "@query-engine/context/query-scope";
import { hydrateSchemaNames, s } from "@schema";
import { beforeAll, describe, expect, test } from "vitest";
import {
  countDistinctTargets,
  groupLinkTargets,
  linkGroupSelector,
} from "../../src/query-engine/write-engine/link-target-groups";

/**
 * PHASE 4 — the link IN-list fold (query-performance-plan).
 *
 * `connect`/`disconnect` with N targets used to send an existence probe and a
 * single-row UPDATE for EACH target: `connect: [a, b, c]` under an update cost
 * eight statements, six of them the link. The targets are complete unique keys
 * of one child model, so one probe and one write can name all of them.
 *
 * These are the witnesses for the fold. What the fold must not disturb — the
 * persisted effect, the M2M paths, the driver matrix — is covered by
 * `nested-write-behavior.ts`, `many-to-many-behavior.ts` and the five driver
 * legs. What is new, and what only a test that can see the traffic can prove,
 * is the COUNT, the grouping RULE, and that the missing-target error kept its
 * text, its attribution and its fail-closed phase when the probe that decides
 * it stopped being one probe per target.
 */

const author = s
  .model({
    id: s.int().id(),
    name: s.string(),
    posts: s.oneToMany(() => post),
    notes: s.oneToMany(() => note),
    labels: s.manyToMany(() => label),
  })
  .map("p4_authors");

const label = s
  .model({
    id: s.int().id(),
    text: s.string().unique(),
    authors: s.manyToMany(() => author),
  })
  .map("p4_labels");

const post = s
  .model({
    id: s.int().id(),
    slug: s.string().unique(),
    title: s.string(),
    archived: s.boolean(),
    stamp: s.dateTime().unique(),
    authorId: s.int().nullable(),
    author: s
      .manyToOne(() => author)
      .fields("authorId")
      .references("id")
      .optional(),
  })
  .map("p4_posts");

/** A compound unique — the group whose selector is an OR of complete
 *  equalities rather than an IN list. */
const note = s
  .model({
    id: s.int().id(),
    org: s.string(),
    ref: s.string(),
    authorId: s.int().nullable(),
    author: s
      .manyToOne(() => author)
      .fields("authorId")
      .references("id")
      .optional(),
  })
  .unique(["org", "ref"])
  .map("p4_notes");

const schema = { author, label, note, post };

beforeAll(() => {
  hydrateSchemaNames(schema);
});

/**
 * Records every statement the operation sends, in order. The hook is the
 * PROTECTED `execute`/`executeRaw` seam rather than `_execute`, because a
 * transaction runs its statements through a transaction-bound driver that
 * delegates back to exactly these two methods — so one hook sees both
 * substrates.
 */
class RecordingPGliteDriver extends PGliteDriver {
  readonly statements: string[] = [];
  recording = false;

  protected override execute<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    if (this.recording) this.statements.push(sql);
    return super.execute<T>(client, sql, params, context);
  }

  protected override executeRaw<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    if (this.recording) this.statements.push(sql);
    return super.executeRaw<T>(client, sql, params, context);
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

const STAMP_BASE = Date.UTC(2026, 0, 1);

async function boot(driver: RecordingPGliteDriver) {
  const client = createClient({ schema, driver });
  await push(client, { force: true });
  await client.author.create({ data: { id: 1, name: "A" } });
  await client.author.create({ data: { id: 2, name: "B" } });
  for (const id of [10, 11, 12, 13, 14]) {
    await client.post.create({
      data: {
        id,
        slug: `s${id}`,
        title: `t${id}`,
        archived: id === 14,
        stamp: new Date(STAMP_BASE + id * 1000),
      },
    });
  }
  for (const id of [20, 21, 22]) {
    await client.note.create({ data: { id, org: "acme", ref: `r${id}` } });
  }
  for (const id of [30, 31, 32]) {
    await client.label.create({ data: { id, text: `L${id}` } });
  }
  return client;
}

/** The captured statements, cleared so the next act starts from empty. */
function drain(driver: RecordingPGliteDriver): string[] {
  return driver.statements.splice(0, driver.statements.length);
}

/** Only the statements that touch the CHILD table — the link's own traffic,
 *  free of the root locate and the terminal read. */
function childStatements(statements: string[], table: string): string[] {
  return statements.filter((sql) => sql.includes(table));
}

async function authorOf(client: any, id: number): Promise<number | null> {
  const row = await client.post.findUnique({ where: { id } });
  return row?.authorId ?? null;
}

describe("the link IN-list fold — statement traffic", () => {
  test("connect with three targets of one key shape is TWO statements", async () => {
    const driver = new RecordingPGliteDriver();
    const client = await boot(driver);

    driver.recording = true;
    await client.author.update({
      where: { id: 1 },
      data: { posts: { connect: [{ id: 10 }, { id: 11 }, { id: 12 }] } },
    });
    const statements = drain(driver);
    driver.recording = false;

    // THE measurement: six link statements became two. The rest of the traffic
    // is the root's own locate and terminal read, which this phase does not
    // touch — so the whole operation went from eight statements to four.
    const link = childStatements(statements, "p4_posts");
    expect(link).toHaveLength(2);
    expect(statements).toHaveLength(4);

    // One locked probe over the whole IN list, then one UPDATE over the same.
    expect(link[0]).toContain('"t0"."id" IN ($1, $2, $3)');
    expect(link[0]).toContain("FOR UPDATE");
    expect(link[1]).toContain("UPDATE");
    expect(link[1]).toContain('"p4_posts"."id" IN ($2, $3, $4)');

    // All three rows are reparented, and nothing else moved.
    expect(await authorOf(client, 10)).toBe(1);
    expect(await authorOf(client, 11)).toBe(1);
    expect(await authorOf(client, 12)).toBe(1);
    expect(await authorOf(client, 13)).toBeNull();
  });

  test("a single target keeps the arity-1 statements it always sent", async () => {
    const driver = new RecordingPGliteDriver();
    const client = await boot(driver);

    driver.recording = true;
    await client.author.update({
      where: { id: 1 },
      data: { posts: { connect: [{ id: 10 }] } },
    });
    const link = childStatements(drain(driver), "p4_posts");
    driver.recording = false;

    // A one-member group is not folded into an IN list: the caller's own `where`
    // rides through, which is what keeps every existing single-target pin and
    // plan unmoved. An `IN` here would mean the fold widened its own blast
    // radius to the overwhelmingly common case.
    expect(link).toHaveLength(2);
    expect(link[0]).toContain('"t0"."id" = $1');
    expect(link[0]).not.toContain(" IN (");
    expect(link[1]).toContain('"p4_posts"."id" = $2');
    expect(link[1]).toContain("RETURNING");
    expect(await authorOf(client, 10)).toBe(1);
  });

  test("disconnect with three targets is TWO statements and stays correlated", async () => {
    const driver = new RecordingPGliteDriver();
    const client = await boot(driver);
    await client.author.update({
      where: { id: 1 },
      data: { posts: { connect: [{ id: 10 }, { id: 11 }, { id: 12 }] } },
    });

    driver.recording = true;
    await client.author.update({
      where: { id: 1 },
      data: { posts: { disconnect: [{ id: 10 }, { id: 11 }, { id: 12 }] } },
    });
    const link = childStatements(drain(driver), "p4_posts");
    driver.recording = false;

    expect(link).toHaveLength(2);
    // The probe is still the CORRELATED one — the IN list is conjoined with the
    // foreign-key correlation, not substituted for it. Losing that half would
    // let a caller disconnect another parent's child.
    expect(link[0]).toContain('"t0"."id" IN ($1, $2, $3)');
    expect(link[0]).toContain('"t0"."authorId" = $4');
    expect(link[1]).toContain("UPDATE");
    expect(link[1]).toContain('"authorId" = NULL');

    expect(await authorOf(client, 10)).toBeNull();
    expect(await authorOf(client, 11)).toBeNull();
    expect(await authorOf(client, 12)).toBeNull();
  });

  test("batch mode folds the probe and the write, and keeps ONE GUARD PER TARGET", async () => {
    const driver = new BatchOnlyRecordingDriver();
    const client = await boot(driver);

    driver.recording = true;
    await client.author.update({
      where: { id: 1 },
      data: { posts: { connect: [{ id: 10 }, { id: 11 }, { id: 12 }] } },
    });
    const statements = drain(driver);
    driver.recording = false;

    const link = childStatements(statements, "p4_posts");
    // One planning probe, three in-batch presence assertions, one write. The
    // guards are free inside the atomic unit and stay per target: each one is
    // the assertion for ITS target, so a target that disappears between
    // planning and the batch is still caught by the guard that names it.
    expect(link).toHaveLength(5);
    expect(link[0]).toContain('"t0"."id" IN ($1, $2, $3)');
    expect(
      link.slice(1, 4).every((sql) => sql.includes("__viborm_assert__"))
    ).toBe(true);
    expect(link.slice(1, 4).every((sql) => sql.includes(" IN ("))).toBe(false);
    expect(link[4]).toContain('"p4_posts"."id" IN ($2, $3, $4)');

    expect(await authorOf(client, 10)).toBe(1);
    expect(await authorOf(client, 12)).toBe(1);
  });

  test("mixed key shapes make ONE GROUP PER SHAPE", async () => {
    const driver = new RecordingPGliteDriver();
    const client = await boot(driver);

    driver.recording = true;
    await client.author.update({
      where: { id: 1 },
      data: {
        posts: {
          connect: [{ id: 10 }, { slug: "s11" }, { id: 12 }, { slug: "s13" }],
        },
      },
    });
    const link = childStatements(drain(driver), "p4_posts");
    driver.recording = false;

    // Two shapes, two groups, four statements — not eight, and not one group
    // whose IN list mixed a primary key with a slug.
    expect(link).toHaveLength(4);
    expect(link[0]).toContain('"t0"."id" IN ($1, $2)');
    expect(link[1]).toContain('"t0"."slug" IN ($1, $2)');
    expect(link[2]).toContain('"p4_posts"."id" IN ($2, $3)');
    expect(link[3]).toContain('"p4_posts"."slug" IN ($2, $3)');

    for (const id of [10, 11, 12, 13]) {
      expect(await authorOf(client, id)).toBe(1);
    }
  });

  test("a COMPOUND unique folds to one OR of complete equalities", async () => {
    const driver = new RecordingPGliteDriver();
    const client = await boot(driver);

    driver.recording = true;
    await client.author.update({
      where: { id: 1 },
      data: {
        notes: {
          connect: [
            { org_ref: { org: "acme", ref: "r20" } },
            { org_ref: { org: "acme", ref: "r21" } },
          ],
        },
      },
    });
    const link = childStatements(drain(driver), "p4_notes");
    driver.recording = false;

    // Still one probe and one write. A compound key has no single-column IN
    // spelling, so the group's selector is the OR — the statement COUNT is what
    // the fold is about, not the operator.
    expect(link).toHaveLength(2);
    expect(link[0]).toContain(" OR ");
    expect(link[1]).toContain("UPDATE");
    expect(link[1]).toContain(" OR ");

    const rows = await client.note.findMany({ where: { authorId: 1 } });
    expect(rows.map((row: any) => row.id).sort()).toEqual([20, 21]);
  });

  /**
   * `set` and the M2M `connect` keep their PER-TARGET probes: the batch guard
   * pairs each selector with the primary key THAT selector's probe captured
   * (the split-witness assertion), and a grouped probe cannot hand that pairing
   * back without comparing a decoded column value against an input value. Their
   * WRITE folds anyway, because both already address rows by the captured
   * primary key rather than by the caller's selector — so the fold needs no
   * pairing at all.
   */
  test("set reparents its whole target list in ONE write", async () => {
    const driver = new RecordingPGliteDriver();
    const client = await boot(driver);

    driver.recording = true;
    await client.author.update({
      where: { id: 1 },
      data: { posts: { set: [{ id: 10 }, { id: 11 }, { id: 12 }] } },
    });
    const link = childStatements(drain(driver), "p4_posts");
    driver.recording = false;

    // Three probes (the pairing the guards need), the departing-rows UPDATE that
    // `set` always sends, and ONE reparent write over the captured PKs — five
    // statements where there were seven.
    expect(link).toHaveLength(5);
    expect(link.slice(0, 3).every((sql) => sql.startsWith("SELECT"))).toBe(
      true
    );
    expect(link[3]).toContain('"authorId" = NULL');
    expect(link[4]).toContain('"p4_posts"."id" IN ($2, $3, $4)');

    expect(await authorOf(client, 10)).toBe(1);
    expect(await authorOf(client, 11)).toBe(1);
    expect(await authorOf(client, 12)).toBe(1);
    expect(await authorOf(client, 13)).toBeNull();
  });

  test("set in batch mode keeps a guard per target ahead of the one write", async () => {
    const driver = new BatchOnlyRecordingDriver();
    const client = await boot(driver);

    driver.recording = true;
    await client.author.update({
      where: { id: 1 },
      data: { posts: { set: [{ id: 10 }, { id: 11 }] } },
    });
    const link = childStatements(drain(driver), "p4_posts");
    driver.recording = false;

    // Two probes, two split-witness guards, the departing UPDATE, one reparent.
    expect(link).toHaveLength(6);
    expect(
      link.slice(2, 4).every((sql) => sql.includes("__viborm_assert__"))
    ).toBe(true);
    expect(link[5]).toContain('"p4_posts"."id" IN ($2, $3)');
    expect(await authorOf(client, 10)).toBe(1);
    expect(await authorOf(client, 11)).toBe(1);
  });

  test("an M2M connect list becomes ONE junction insert", async () => {
    const driver = new RecordingPGliteDriver();
    const client = await boot(driver);

    driver.recording = true;
    await client.author.update({
      where: { id: 1 },
      data: { labels: { connect: [{ id: 30 }, { id: 31 }, { id: 32 }] } },
    });
    const statements = drain(driver);
    driver.recording = false;

    // Three INSERTs became one. The duplicate skip is the same clause — the
    // single-row builder IS the many-row builder over a one-element list — so
    // connecting an already-connected label stays idempotent (below).
    const inserts = statements.filter((sql) => sql.startsWith("INSERT"));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toContain("ON CONFLICT DO NOTHING");
    expect(inserts[0]).toContain("($1, $2), ($3, $4), ($5, $6)");

    const author1 = await client.author.findUnique({
      where: { id: 1 },
      include: { labels: true },
    });
    expect(author1?.labels.map((row: any) => row.id).sort()).toEqual([
      30, 31, 32,
    ]);
  });

  test("the folded M2M connect is still idempotent", async () => {
    const driver = new RecordingPGliteDriver();
    const client = await boot(driver);
    await client.author.update({
      where: { id: 1 },
      data: { labels: { connect: [{ id: 30 }, { id: 31 }] } },
    });

    // Re-connecting an existing member alongside a new one must add the new join
    // row and leave the existing one alone, not raise a primary-key conflict.
    await client.author.update({
      where: { id: 1 },
      data: { labels: { connect: [{ id: 30 }, { id: 32 }] } },
    });

    const author1 = await client.author.findUnique({
      where: { id: 1 },
      include: { labels: true },
    });
    expect(author1?.labels.map((row: any) => row.id).sort()).toEqual([
      30, 31, 32,
    ]);
  });

  test("an M2M connect naming an absent label writes no join row", async () => {
    const driver = new RecordingPGliteDriver();
    const client = await boot(driver);

    await expect(
      client.author.update({
        where: { id: 1 },
        data: { labels: { connect: [{ id: 30 }, { id: 999 }] } },
      })
    ).rejects.toThrow(
      "Cannot connect relation 'labels': target record was not found."
    );

    const author1 = await client.author.findUnique({
      where: { id: 1 },
      include: { labels: true },
    });
    expect(author1?.labels).toEqual([]);
  });

  test("the create tree's own connect folds the same way", async () => {
    const driver = new RecordingPGliteDriver();
    const client = await boot(driver);

    driver.recording = true;
    await client.author.create({
      data: {
        id: 9,
        name: "C",
        posts: { connect: [{ id: 10 }, { id: 11 }, { id: 12 }] },
      },
    });
    const link = childStatements(drain(driver), "p4_posts");
    driver.recording = false;

    // `create` builds its child-held connect through its own Part, so this is a
    // second call site of the same rule rather than the same code path.
    expect(link).toHaveLength(2);
    expect(link[0]).toContain('"t0"."id" IN ($1, $2, $3)');
    expect(link[1]).toContain('"p4_posts"."id" IN ($2, $3, $4)');
    expect(await authorOf(client, 11)).toBe(9);
  });
});

describe("the link IN-list fold — what may share a group", () => {
  test("a REPEATED target is one row, not a missing one", async () => {
    const driver = new RecordingPGliteDriver();
    const client = await boot(driver);

    driver.recording = true;
    // Two entries, one row. The missing-target verdict counts DISTINCT keys,
    // so the probe's single row satisfies both entries. Comparing the row
    // count against the entry count instead would reject this outright.
    await client.author.update({
      where: { id: 1 },
      data: { posts: { connect: [{ id: 10 }, { id: 10 }, { id: 11 }] } },
    });
    const link = childStatements(drain(driver), "p4_posts");
    driver.recording = false;

    expect(link).toHaveLength(2);
    expect(await authorOf(client, 10)).toBe(1);
    expect(await authorOf(client, 11)).toBe(1);
  });

  test("a NON-primary alternate unique folds on its own column", async () => {
    const driver = new RecordingPGliteDriver();
    const client = await boot(driver);

    driver.recording = true;
    await client.author.update({
      where: { id: 1 },
      data: { posts: { connect: [{ slug: "s10" }, { slug: "s11" }] } },
    });
    const link = childStatements(drain(driver), "p4_posts");
    driver.recording = false;

    // The fold addresses rows by the key the CALLER named, not by the primary
    // keys the probe read back. In batch mode the probe runs before the atomic
    // unit while the guard runs inside it, so a primary key taken from the probe
    // would be older than the assertion that admits the write; the key columns
    // are exactly what the guard re-asserts.
    expect(link).toHaveLength(2);
    expect(link[0]).toContain('"t0"."slug" IN ($1, $2)');
    expect(link[1]).toContain('"p4_posts"."slug" IN ($2, $3)');
    expect(await authorOf(client, 10)).toBe(1);
    expect(await authorOf(client, 11)).toBe(1);
  });

  test("a DATE-TIME unique key folds, because validation hands over a primitive", async () => {
    const driver = new RecordingPGliteDriver();
    const client = await boot(driver);

    driver.recording = true;
    await client.author.update({
      where: { id: 1 },
      data: {
        posts: {
          connect: [
            { stamp: new Date(STAMP_BASE + 10_000) },
            { stamp: new Date(STAMP_BASE + 11_000) },
          ],
        },
      },
    });
    const link = childStatements(drain(driver), "p4_posts");
    driver.recording = false;

    // Measured rather than assumed: a `Date` written by the caller reaches the
    // engine as a primitive, so its JS equality IS its SQL equality and the fold
    // is safe. This is the reading the `isComparableKeyValue` clause depends on
    // — if a scalar ever started handing an OBJECT through, this test would keep
    // passing and the unit test below is what would catch the difference.
    expect(link).toHaveLength(2);
    expect(link[0]).toContain(" IN (");
    expect(await authorOf(client, 10)).toBe(1);
    expect(await authorOf(client, 11)).toBe(1);
  });
});

/**
 * The two clauses of the fold's precondition, exercised on the rule itself.
 *
 * Neither is reachable through the client today, and that is a fact about a
 * DIFFERENT layer: nested `connect`/`disconnect` take the STRICT `whereUnique`
 * at the parse boundary (`Unknown key: archived`), and no scalar that admits
 * `.unique()` validates to an object — `blob` refuses `.unique()` outright, and
 * `dateTime` arrives as a primitive, as the behavior test above measures. The
 * clauses are therefore the fold's stated PRECONDITION rather than a guard
 * against observed input, and the parse boundary is free to widen. Testing them
 * where they live is what keeps them from being an unfalsifiable branch.
 */
describe("the link IN-list fold — the grouping rule itself", () => {
  const childScope = createQueryScope(new PGliteDriver().adapter, post);

  test("targets of one shape and primitive values become ONE group", () => {
    expect(
      groupLinkTargets(childScope, [{ id: 10 }, { id: 11 }, { id: 12 }])
    ).toEqual([[{ id: 10 }, { id: 11 }, { id: 12 }]]);
  });

  test("a selector carrying a PREDICATE half is not an IN list", () => {
    // `archived` is not a unique discriminator, so `partitionWhereUnique` hands
    // it back as the filter half. Two targets' predicates need not agree, and an
    // IN list over their identities would apply one target's predicate to the
    // other's row — so a filtered target keeps its own group, and with it the
    // statements the per-target path sent.
    expect(
      groupLinkTargets(childScope, [
        { id: 10 },
        { archived: false, id: 11 },
        { id: 12 },
      ])
    ).toEqual([[{ id: 10 }, { id: 12 }], [{ archived: false, id: 11 }]]);
  });

  test("an OBJECT-valued key is not folded", () => {
    // Two objects SQL calls equal are distinct in JS, so `countDistinctTargets`
    // would count a repeated target twice and report a present row missing.
    const first = { id: new Date(0) };
    const second = { id: new Date(1000) };
    expect(groupLinkTargets(childScope, [first, second])).toEqual([
      [first],
      [second],
    ]);
  });

  test("a repeated target counts once, a distinct one counts twice", () => {
    expect(countDistinctTargets(childScope, [{ id: 10 }, { id: 10 }])).toBe(1);
    expect(countDistinctTargets(childScope, [{ id: 10 }, { id: 11 }])).toBe(2);
    // The canonical form carries the JS type, so a string and a number that
    // print the same are not conflated into one row.
    expect(countDistinctTargets(childScope, [{ slug: "10" }, { id: 10 }])).toBe(
      2
    );
  });

  test("the group selector is an IN list for one column and an OR for a compound", () => {
    expect(linkGroupSelector(childScope, [{ id: 10 }, { id: 11 }])).toEqual({
      id: { in: [10, 11] },
    });
    const noteScope = createQueryScope(new PGliteDriver().adapter, note);
    expect(
      linkGroupSelector(noteScope, [
        { org_ref: { org: "acme", ref: "r20" } },
        { org_ref: { org: "acme", ref: "r21" } },
      ])
    ).toEqual({
      OR: [
        { AND: [{ org: { equals: "acme" } }, { ref: { equals: "r20" } }] },
        { AND: [{ org: { equals: "acme" } }, { ref: { equals: "r21" } }] },
      ],
    });
  });
});

describe("the link IN-list fold — the missing-target error", () => {
  /** The rejection the per-target path raised, taken from the arity-1 path that
   *  the fold leaves untouched. Every grouped rejection below is compared
   *  against THIS string, not against a literal copied from the source. */
  function perTargetRejection(client: any): Promise<unknown> {
    return client.author
      .update({
        where: { id: 1 },
        data: { posts: { connect: [{ id: 999 }] } },
      })
      .catch((caught: unknown) => caught);
  }

  test("a grouped rejection is BYTE-IDENTICAL to the per-target one", async () => {
    const driver = new RecordingPGliteDriver();
    const client = await boot(driver);
    const perTarget = await perTargetRejection(client);
    expect(perTarget).toBeInstanceOf(NestedWriteError);
    const baseline = (perTarget as Error).message;

    const grouped = await client.author
      .update({
        where: { id: 1 },
        data: {
          posts: { connect: [{ id: 10 }, { id: 999 }, { id: 12 }] },
        },
      })
      .catch((error: unknown) => error);

    expect(grouped).toBeInstanceOf(NestedWriteError);
    expect((grouped as Error).message).toBe(baseline);
    expect((grouped as NestedWriteError).message).toBe(
      "Cannot connect relation 'posts': target record was not found."
    );
    // And it is a REJECTION, not a partial application: the two present targets
    // in the same group are untouched.
    expect(await authorOf(client, 10)).toBeNull();
    expect(await authorOf(client, 12)).toBeNull();
  });

  test("the rejection names the RELATION whose target is missing, not the other one", async () => {
    const driver = new RecordingPGliteDriver();
    const client = await boot(driver);

    // Two relations in one update. `posts` is entirely satisfiable; `notes`
    // carries the absent target. The message must name `notes` — a fold that
    // merged verdicts, or reported the first group it built, would name
    // `posts`, and the caller would look in the wrong place.
    const error = await client.author
      .update({
        where: { id: 1 },
        data: {
          posts: { connect: [{ id: 10 }, { id: 11 }] },
          notes: {
            connect: [
              { org_ref: { org: "acme", ref: "r20" } },
              { org_ref: { org: "acme", ref: "nope" } },
            ],
          },
        },
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NestedWriteError);
    expect((error as Error).message).toBe(
      "Cannot connect relation 'notes': target record was not found."
    );
    expect((error as NestedWriteError).meta.relation).toBe("notes");
    expect(await authorOf(client, 10)).toBeNull();
  });

  test("the missing target is caught wherever it sits in the list", async () => {
    const driver = new RecordingPGliteDriver();
    const client = await boot(driver);

    for (const connect of [
      [{ id: 999 }, { id: 10 }, { id: 11 }],
      [{ id: 10 }, { id: 999 }, { id: 11 }],
      [{ id: 10 }, { id: 11 }, { id: 999 }],
    ]) {
      const error = await client.author
        .update({ where: { id: 1 }, data: { posts: { connect } } })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(NestedWriteError);
      expect((error as Error).message).toBe(
        "Cannot connect relation 'posts': target record was not found."
      );
    }
    // Nothing was written by any of the three attempts.
    expect(await authorOf(client, 10)).toBeNull();
    expect(await authorOf(client, 11)).toBeNull();
  });

  test("a disconnect target belonging to ANOTHER parent is rejected, not nulled", async () => {
    const driver = new RecordingPGliteDriver();
    const client = await boot(driver);
    await client.author.update({
      where: { id: 1 },
      data: { posts: { connect: [{ id: 10 }, { id: 11 }] } },
    });
    await client.author.update({
      where: { id: 2 },
      data: { posts: { connect: [{ id: 12 }] } },
    });

    // Post 12 exists and is connected — to author 2. The grouped probe's
    // correlation half is the only thing that can tell that apart from a
    // legitimate disconnect, and the count must see the shortfall.
    const error = await client.author
      .update({
        where: { id: 1 },
        data: { posts: { disconnect: [{ id: 10 }, { id: 12 }] } },
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NestedWriteError);
    expect((error as Error).message).toBe(
      "Cannot disconnect relation 'posts': target record was not found for this parent."
    );
    expect(await authorOf(client, 10)).toBe(1);
    expect(await authorOf(client, 12)).toBe(2);
  });

  test("batch mode rejects a missing target at the same phase, before any write", async () => {
    const driver = new BatchOnlyRecordingDriver();
    const client = await boot(driver);

    driver.recording = true;
    const error = await client.author
      .update({
        where: { id: 1 },
        data: { posts: { connect: [{ id: 10 }, { id: 999 }] } },
      })
      .catch((caught: unknown) => caught);
    const statements = drain(driver);
    driver.recording = false;

    expect(error).toBeInstanceOf(NestedWriteError);
    expect((error as Error).message).toBe(
      "Cannot connect relation 'posts': target record was not found."
    );
    // The verdict is reached at compile, so the atomic unit is never assembled:
    // no guard and no UPDATE was sent at all.
    expect(statements.some((sql) => sql.includes("UPDATE"))).toBe(false);
    expect(statements.some((sql) => sql.includes("__viborm_assert__"))).toBe(
      false
    );
    expect(await authorOf(client, 10)).toBeNull();
  });
});
