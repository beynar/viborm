/**
 * The shared FOUND-consumption rule, credential-free.
 *
 * A probe whose other arm inserts the key it looked for reads without locking
 * (`Selection.insertsWhenAbsent`), so the row it FINDS is not held by that
 * probe for the arm that follows. The usual rule is one read taken between the
 * observation and the arm (`CommandExecution.confirmFound` →
 * `Selection.confirm`). A child-free UPDATE addressed only by the complete row
 * key may instead consume the same premise through `UPDATE … RETURNING`: its
 * returned row supplies every binding, and no returned row raises the arm's
 * existing failure. The repair prompt §1 states the general rule; the native
 * measurements are `tests/providers/docker/mysql2-found-consumption.test.ts`.
 *
 * This file is the part of that rule which needs no credentials, and it is
 * deliberately NOT a concurrency suite. SQLite's select assembly omits
 * `FOR UPDATE` (`sqlite-adapter.ts`), so there is no lock here to prove and no
 * second writer to prove it against; what IS expressible — and what these cells
 * pin — is that either the confirmation precedes the effect or the returned
 * update is itself the exact consumer, that its answer replaces the probe's
 * bytes as the binding, and that each lost requirement raises the failure its
 * own arm already owns. The drift is applied on the operation's own connection
 * from a statement hook, exactly where the selected consumer must discover it.
 */

import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { QueryExecutionContext } from "@drivers/driver";
import { SQLite3Driver } from "@drivers/sqlite3";
import type { QueryResult } from "@drivers/types";
import {
  NestedWriteError,
  NotFoundError,
  TransactionError,
  VibORMErrorCode,
} from "@errors";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import type Database from "better-sqlite3";
import { beforeEach, describe, expect, test } from "vitest";

const schema = (() => {
  const badge = s
    .model({
      id: s.string().id(),
      slug: s.string().unique(),
      code: s.string().unique(),
      holders: s.toMany(() => holder),
    })
    .map("sfc_badges");

  const holder = s
    .model({
      id: s.string().id(),
      badgeCode: s.string(),
      badge: s
        .toOne(() => badge)
        .fields("badgeCode")
        .references("code"),
    })
    .map("sfc_holders");

  const tag = s
    .model({
      id: s.string().id(),
      name: s.string().unique(),
      count: s.int().default(0),
    })
    .map("sfc_tags");

  const owner = s
    .model({
      id: s.string().id(),
      name: s.string(),
      profile: s.toOne(() => profile),
    })
    .map("sfc_owners");

  const profile = s
    .model({
      id: s.string().id(),
      bio: s.string().nullable(),
      ownerId: s.string().unique().nullable(),
      owner: s
        .toOne(() => owner)
        .fields("ownerId")
        .references("id"),
    })
    .map("sfc_profiles");

  const generatedParent = s
    .model({
      id: s.int().id().increment(),
      label: s.string(),
      children: s.toMany(() => generatedChild),
      compoundChildren: s.toMany(() => compoundGeneratedChild),
    })
    .map("sfc_generated_parents");

  const generatedChild = s
    .model({
      id: s.string().id(),
      parentId: s.int(),
      label: s.string().unique(),
      parent: s
        .toOne(() => generatedParent)
        .fields("parentId")
        .references("id"),
    })
    .map("sfc_generated_children");

  const compoundGeneratedChild = s
    .model({
      tenant: s.string().map("tenant_key"),
      localId: s.string().map("local_key"),
      parentId: s.int().map("parent_key"),
      label: s.string().unique(),
      parent: s
        .toOne(() => generatedParent)
        .fields("parentId")
        .references("id"),
    })
    .id(["tenant", "localId"])
    .map("sfc_compound_generated_children");

  return {
    badge,
    holder,
    tag,
    owner,
    profile,
    generatedParent,
    generatedChild,
    compoundGeneratedChild,
  };
})();

type FoundConfig = VibORMConfig<typeof schema>;
type FoundClient = VibORMClient<FoundConfig>;

const READ = /^SELECT\b/;
const MUTATION = /^(?:INSERT|UPDATE|DELETE)\b/i;

/**
 * Applies its drift immediately before the `ordinal`-th statement of `verb`
 * against `table`.
 *
 * The position is the schedule. Before a READ it names the confirmation: every
 * shape below reads its table once (twice for a conditioned upsert, whose
 * condition probe runs before either arm is chosen) and the NEXT read of it is
 * the confirmation, so a tree that has no confirmation never sends the
 * statement the drift plants in front of and the cell says so. Before the
 * first MUTATION it names the window the confirmation cannot close on this
 * substrate — the confirmation has already ANSWERED, and SQLite's select
 * assembly omits `FOR UPDATE`, so nothing holds the row between that answer
 * and the effect. That window is what the key demands and
 * `OperationContext.update`'s CURRENT stored-row read are the reader of LAST
 * resort for.
 */
class DriftingSQLite3Driver extends SQLite3Driver {
  readonly statements: string[] = [];
  drifted = false;
  private matches = 0;
  private drift:
    | {
        table: RegExp;
        verb: RegExp;
        ordinal: number;
        apply: (client: Database.Database) => void;
      }
    | undefined;

  constructor() {
    super({ dataDir: ":memory:" });
  }

  driftBefore(
    table: RegExp,
    ordinal: number,
    apply: (client: Database.Database) => void
  ): void {
    this.plant(table, READ, ordinal, apply);
  }

  /** After the confirmation has answered, before the effect it answered for. */
  driftBeforeMutation(
    table: RegExp,
    apply: (client: Database.Database) => void
  ): void {
    this.plant(table, MUTATION, 1, apply);
  }

  private plant(
    table: RegExp,
    verb: RegExp,
    ordinal: number,
    apply: (client: Database.Database) => void
  ): void {
    this.drift = { table, verb, ordinal, apply };
    this.matches = 0;
    this.drifted = false;
  }

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[],
    _context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.statements.push(statement);
    const plan = this.drift;
    if (
      plan &&
      !this.drifted &&
      plan.verb.test(statement) &&
      plan.table.test(statement)
    ) {
      this.matches += 1;
      if (this.matches === plan.ordinal) {
        this.drifted = true;
        plan.apply(client);
      }
    }
    return await super.execute<T>(client, statement, parameters);
  }
}

const BADGE_TABLE = /sfc_badges/;
const HOLDER_TABLE = /sfc_holders/;
const TAG_TABLE = /sfc_tags/;
const PROFILE_TABLE = /sfc_profiles/;
const GENERATED_CHILD_TABLE = /sfc_generated_children/;
const COMPOUND_GENERATED_CHILD_TABLE = /sfc_compound_generated_children/;

const matching = (
  driver: DriftingSQLite3Driver,
  verb: string,
  table: RegExp
): string[] =>
  driver.statements.filter(
    (statement) => statement.startsWith(verb) && table.test(statement)
  );

/** The reads of that table this operation took before it wrote to it. */
const planTimeReads = (
  driver: DriftingSQLite3Driver,
  table: RegExp
): string[] => {
  const write = driver.statements.findIndex(
    (statement) => MUTATION.test(statement) && table.test(statement)
  );
  return driver.statements
    .slice(0, write < 0 ? driver.statements.length : write)
    .filter(
      (statement) => statement.startsWith("SELECT") && table.test(statement)
    );
};

const outcomeOf = async <T>(
  work: PromiseLike<T>
): Promise<{ failure: unknown; value: T | undefined }> =>
  await Promise.resolve(work).then(
    (value) => ({ failure: undefined, value: value as T | undefined }),
    (failure: unknown) => ({ failure, value: undefined })
  );

/**
 * The sentence a lost CONJOINED premise raises (repair prompt 2 §2).
 *
 * Two matched conditions are ONE premise of one consumption, proved by ONE
 * confirmation (G1), so what a miss loses is that premise and not a term of
 * it: the sentence names the operation and the conditions as a SET. On the
 * reviewed source it was `targetWhere`'s own sentence whichever condition had
 * actually changed — a diagnosis the single statement never made.
 */
const CONJOINED_PREMISE =
  "query-engine-v2 top-level upsert matched premise (targetWhere, setWhere) changed before the atomic batch.";

/** The dual-condition shape: both conditions match `t1` as it stands. */
const conjoinedUpsert = async (subject: FoundClient) =>
  await subject.tag.upsert({
    where: { id: "t1" },
    targetWhere: { name: "chosen" },
    setWhere: { count: 7 },
    create: { id: "t1", name: "chosen", count: 0 },
    update: { count: 42 },
  });

describe("the shared FOUND-consumption rule on the recording SQLite transport", () => {
  let driver: DriftingSQLite3Driver;
  let client: FoundClient;

  beforeEach(async () => {
    driver = new DriftingSQLite3Driver();
    client = createClient({ schema, driver }) as FoundClient;
    await syncLiveSchema(client);
    driver.statements.length = 0;
  });

  test("returns a child-held found connection within four statements", async () => {
    await client.generatedParent.create({
      data: { id: 5000, label: "existing-parent" },
    });
    await client.generatedChild.create({
      data: {
        id: "conditional_found",
        parentId: 5000,
        label: "existing-child",
      },
    });
    driver.statements.length = 0;

    const created = await client.generatedParent.create({
      data: {
        label: "conditional-0",
        children: {
          connectOrCreate: {
            where: { id: "conditional_found" },
            create: {
              id: "unselected-0",
              label: "created-child",
            },
          },
        },
      },
      select: {
        id: true,
        label: true,
        children: { select: { id: true, parentId: true, label: true } },
      },
    });
    const operationStatements = driver.statements.length;

    expect(created).toEqual({
      id: 5001,
      label: "conditional-0",
      children: [
        {
          id: "conditional_found",
          parentId: 5001,
          label: "existing-child",
        },
      ],
    });
    expect(operationStatements).toBeLessThanOrEqual(4);
    expect(
      await client.generatedChild.findUnique({
        where: { id: "conditional_found" },
      })
    ).toMatchObject({ parentId: 5001, label: "existing-child" });
    expect(
      await client.generatedChild.findUnique({ where: { id: "unselected-0" } })
    ).toBeNull();
  });

  test("returns a mapped compound row key after an alternate unique within four statements", async () => {
    await client.generatedParent.create({
      data: { id: 5000, label: "existing-parent" },
    });
    await client.compoundGeneratedChild.create({
      data: {
        tenant: "tenant-0",
        localId: "child-0",
        parentId: 5000,
        label: "existing-compound-child",
      },
    });
    driver.statements.length = 0;

    const created = await client.generatedParent.create({
      data: {
        label: "conditional-0",
        compoundChildren: {
          connectOrCreate: {
            where: {
              tenant_localId: { tenant: "tenant-0", localId: "child-0" },
            },
            create: {
              tenant: "unselected",
              localId: "unselected",
              label: "created-compound-child",
            },
          },
        },
      },
      select: {
        id: true,
        compoundChildren: {
          select: {
            tenant: true,
            localId: true,
            parentId: true,
            label: true,
          },
        },
      },
    });

    expect(created).toEqual({
      id: 5001,
      compoundChildren: [
        {
          tenant: "tenant-0",
          localId: "child-0",
          parentId: 5001,
          label: "existing-compound-child",
        },
      ],
    });
    expect(driver.statements).toHaveLength(4);
    expect(matching(driver, "UPDATE", COMPOUND_GENERATED_CHILD_TABLE)).toHaveLength(
      1,
    );
  });

  test("keeps the confirmation for a child-held mutable unique selector", async () => {
    await client.generatedParent.create({
      data: { id: 5000, label: "existing-parent" },
    });
    await client.generatedChild.create({
      data: {
        id: "conditional_found",
        parentId: 5000,
        label: "existing-child",
      },
    });
    driver.statements.length = 0;

    const created = await client.generatedParent.create({
      data: {
        label: "conditional-0",
        children: {
          connectOrCreate: {
            where: { label: "existing-child" },
            create: { id: "unselected-0", label: "existing-child" },
          },
        },
      },
      select: {
        id: true,
        children: { select: { id: true, parentId: true, label: true } },
      },
    });

    expect(created.children).toEqual([
      {
        id: "conditional_found",
        parentId: 5001,
        label: "existing-child",
      },
    ]);
    expect(planTimeReads(driver, GENERATED_CHILD_TABLE)).toHaveLength(2);
    expect(driver.statements).toHaveLength(5);
  });

  test("keeps the confirmation for a row key with an extended predicate", async () => {
    await client.generatedParent.create({
      data: { id: 5000, label: "existing-parent" },
    });
    await client.generatedChild.create({
      data: {
        id: "conditional_found",
        parentId: 5000,
        label: "existing-child",
      },
    });
    driver.statements.length = 0;

    const created = await client.generatedParent.create({
      data: {
        label: "conditional-0",
        children: {
          connectOrCreate: {
            where: { id: "conditional_found", label: "existing-child" },
            create: { id: "unselected-0", label: "created-child" },
          },
        },
      },
      select: {
        id: true,
        children: { select: { id: true, parentId: true, label: true } },
      },
    });

    expect(created.children).toEqual([
      {
        id: "conditional_found",
        parentId: 5001,
        label: "existing-child",
      },
    ]);
    expect(planTimeReads(driver, GENERATED_CHILD_TABLE)).toHaveLength(2);
    expect(driver.statements).toHaveLength(5);
  });

  test("the returned child update keeps the found arm's missing failure", async () => {
    await client.generatedParent.create({
      data: { id: 5000, label: "existing-parent" },
    });
    await client.generatedChild.create({
      data: {
        id: "conditional_found",
        parentId: 5000,
        label: "existing-child",
      },
    });
    driver.statements.length = 0;
    driver.driftBeforeMutation(GENERATED_CHILD_TABLE, (database) => {
      database
        .prepare(
          "DELETE FROM sfc_generated_children WHERE id = 'conditional_found'",
        )
        .run();
    });

    const outcome = await outcomeOf(
      client.generatedParent.create({
        data: {
          label: "conditional-0",
          children: {
            connectOrCreate: {
              where: { id: "conditional_found" },
              create: { id: "unselected-0", label: "created-child" },
            },
          },
        },
      }),
    );

    expect(driver.drifted).toBe(true);
    expect(outcome.value).toBeUndefined();
    expect(outcome.failure).toBeInstanceOf(NestedWriteError);
    expect((outcome.failure as Error).message).toBe(
      "Record was replaced by another transaction during nested connectOrCreate",
    );
    expect(matching(driver, "UPDATE", GENERATED_CHILD_TABLE)).toHaveLength(1);
    expect(
      await client.generatedChild.findUnique({
        where: { id: "conditional_found" },
      }),
    ).toMatchObject({ parentId: 5000, label: "existing-child" });
  });

  test("the located row's reference is spent at the value the confirmation read", async () => {
    await client.badge.create({
      data: { id: "b1", slug: "chosen", code: "G" },
    });
    driver.statements.length = 0;
    driver.driftBefore(BADGE_TABLE, 2, (database) => {
      database
        .prepare("UPDATE sfc_badges SET code = 'M' WHERE id = 'b1'")
        .run();
      database
        .prepare(
          "INSERT INTO sfc_badges (id, slug, code) VALUES ('b2', 'unselected', 'G')"
        )
        .run();
    });

    await client.holder.create({
      data: {
        id: "h1",
        badge: {
          connectOrCreate: {
            where: { slug: "chosen" },
            create: { id: "never-created", slug: "chosen", code: "N" },
          },
        },
      },
    });

    // The confirmation was sent, and the value it answered is the one the
    // holder's own INSERT spent — not the byte the probe had read, which `b2`
    // now holds.
    expect(driver.drifted).toBe(true);
    expect(planTimeReads(driver, BADGE_TABLE)).toHaveLength(2);
    const stored = await client.holder.findUnique({
      where: { id: "h1" },
      include: { badge: true },
    });
    expect(stored?.badgeCode).toBe("M");
    expect(stored?.badge?.id).toBe("b1");
    expect(matching(driver, "INSERT", BADGE_TABLE)).toEqual([]);
    expect(matching(driver, "INSERT", HOLDER_TABLE)).toHaveLength(1);
  });

  test("a matched condition lost before the effect refuses with its own premise failure", async () => {
    await client.tag.create({ data: { id: "t1", name: "chosen", count: 7 } });
    driver.statements.length = 0;
    // The locator and the condition probe both read first; the third read is
    // the confirmation.
    driver.driftBefore(TAG_TABLE, 3, (database) => {
      database.prepare("UPDATE sfc_tags SET count = 8 WHERE id = 't1'").run();
    });

    const outcome = await outcomeOf(
      client.tag.upsert({
        where: { id: "t1" },
        setWhere: { count: 7 },
        create: { id: "t1", name: "chosen", count: 0 },
        update: { count: 42 },
      })
    );

    expect(driver.drifted).toBe(true);
    expect(outcome.value).toBeUndefined();
    expect(outcome.failure).toBeInstanceOf(TransactionError);
    expect((outcome.failure as Error).message).toBe(
      "query-engine-v2 top-level upsert setWhere match premise changed before the atomic batch."
    );
    // The arm's effect never went out and the create arm was not taken.
    expect(matching(driver, "UPDATE", TAG_TABLE)).toEqual([]);
    expect(matching(driver, "INSERT", TAG_TABLE)).toEqual([]);
    // The drift rode this operation's OWN transaction — one connection is all
    // SQLite has — so the rollback took it back with everything else. That is
    // the honest limit of a credential-free counterpart, and why the durable
    // state of a refused consumption is pinned natively, not here.
    expect(await client.tag.findUnique({ where: { id: "t1" } })).toMatchObject({
      count: 7,
    });
  });

  test("two matched conditions lost at the FIRST refuse as one premise", async () => {
    await client.tag.create({ data: { id: "t1", name: "chosen", count: 7 } });
    driver.statements.length = 0;
    // The locator and BOTH condition probes read first; the fourth read is the
    // one confirmation that carries their conjunction.
    driver.driftBefore(TAG_TABLE, 4, (database) => {
      database
        .prepare("UPDATE sfc_tags SET name = 'renamed' WHERE id = 't1'")
        .run();
    });

    const outcome = await outcomeOf(conjoinedUpsert(client));

    expect(driver.drifted).toBe(true);
    // One confirmation for the pair, and no second read to ask WHICH of them
    // went: the locator, the two probes, the confirmation.
    expect(planTimeReads(driver, TAG_TABLE)).toHaveLength(4);
    expect(outcome.value).toBeUndefined();
    expect(outcome.failure).toBeInstanceOf(TransactionError);
    expect((outcome.failure as TransactionError).code).toBe(
      VibORMErrorCode.TRANSACTION_FAILED
    );
    expect((outcome.failure as Error).message).toBe(CONJOINED_PREMISE);
    // A lost MATCH premise is not a race another arm may adopt.
    expect((outcome.failure as TransactionError).meta.raceable).not.toBe(true);
    expect(matching(driver, "UPDATE", TAG_TABLE)).toEqual([]);
    expect(matching(driver, "INSERT", TAG_TABLE)).toEqual([]);
    expect(await client.tag.findUnique({ where: { id: "t1" } })).toMatchObject({
      name: "chosen",
      count: 7,
    });
  });

  test("two matched conditions lost at the SECOND refuse with the same sentence", async () => {
    await client.tag.create({ data: { id: "t1", name: "chosen", count: 7 } });
    driver.statements.length = 0;
    driver.driftBefore(TAG_TABLE, 4, (database) => {
      database.prepare("UPDATE sfc_tags SET count = 8 WHERE id = 't1'").run();
    });

    const outcome = await outcomeOf(conjoinedUpsert(client));

    expect(driver.drifted).toBe(true);
    expect(planTimeReads(driver, TAG_TABLE)).toHaveLength(4);
    expect(outcome.value).toBeUndefined();
    expect(outcome.failure).toBeInstanceOf(TransactionError);
    // The condition the reviewed source named here was `targetWhere`, which
    // had not changed at all.
    expect((outcome.failure as Error).message).toBe(CONJOINED_PREMISE);
    expect(matching(driver, "UPDATE", TAG_TABLE)).toEqual([]);
    expect(matching(driver, "INSERT", TAG_TABLE)).toEqual([]);
    expect(await client.tag.findUnique({ where: { id: "t1" } })).toMatchObject({
      name: "chosen",
      count: 7,
    });
  });

  test("two matched conditions lost TOGETHER refuse with the same sentence", async () => {
    await client.tag.create({ data: { id: "t1", name: "chosen", count: 7 } });
    driver.statements.length = 0;
    driver.driftBefore(TAG_TABLE, 4, (database) => {
      database
        .prepare(
          "UPDATE sfc_tags SET name = 'renamed', count = 8 WHERE id = 't1'"
        )
        .run();
    });

    const outcome = await outcomeOf(conjoinedUpsert(client));

    expect(driver.drifted).toBe(true);
    expect(planTimeReads(driver, TAG_TABLE)).toHaveLength(4);
    expect(outcome.value).toBeUndefined();
    expect(outcome.failure).toBeInstanceOf(TransactionError);
    expect((outcome.failure as Error).message).toBe(CONJOINED_PREMISE);
    expect(matching(driver, "UPDATE", TAG_TABLE)).toEqual([]);
    expect(matching(driver, "INSERT", TAG_TABLE)).toEqual([]);
    expect(await client.tag.findUnique({ where: { id: "t1" } })).toMatchObject({
      name: "chosen",
      count: 7,
    });
  });

  test("one condition keeps its own precise sentence", async () => {
    await client.tag.create({ data: { id: "t1", name: "chosen", count: 7 } });
    driver.statements.length = 0;
    // One condition is no conjunction: the premise IS that condition, so the
    // sentence names it — the other spelling of the pair, beside the
    // `setWhere` control above.
    driver.driftBefore(TAG_TABLE, 3, (database) => {
      database
        .prepare("UPDATE sfc_tags SET name = 'renamed' WHERE id = 't1'")
        .run();
    });

    const outcome = await outcomeOf(
      client.tag.upsert({
        where: { id: "t1" },
        targetWhere: { name: "chosen" },
        create: { id: "t1", name: "chosen", count: 0 },
        update: { count: 42 },
      })
    );

    expect(driver.drifted).toBe(true);
    expect(planTimeReads(driver, TAG_TABLE)).toHaveLength(3);
    expect(outcome.value).toBeUndefined();
    expect(outcome.failure).toBeInstanceOf(TransactionError);
    expect((outcome.failure as Error).message).toBe(
      "query-engine-v2 top-level upsert targetWhere match premise changed before the atomic batch."
    );
    expect(matching(driver, "UPDATE", TAG_TABLE)).toEqual([]);
    expect(matching(driver, "INSERT", TAG_TABLE)).toEqual([]);
  });

  test("an uncontended pair of conditions commits its ordinary result", async () => {
    await client.tag.create({ data: { id: "t1", name: "chosen", count: 7 } });
    driver.statements.length = 0;

    const upserted = await conjoinedUpsert(client);

    // No blanket refusal: the conjunction is a premise, not a prohibition.
    expect(upserted).toMatchObject({ id: "t1", name: "chosen", count: 42 });
    expect(planTimeReads(driver, TAG_TABLE)).toHaveLength(4);
    expect(matching(driver, "UPDATE", TAG_TABLE)).toHaveLength(1);
    expect(matching(driver, "INSERT", TAG_TABLE)).toEqual([]);
  });

  test("a to-ONE nested upsert's membership is confirmed before the effect", async () => {
    await client.owner.create({
      data: {
        id: "o1",
        name: "one",
        profile: { create: { id: "pr1", bio: "original" } },
      },
    });
    await client.owner.create({ data: { id: "o2", name: "two" } });
    driver.statements.length = 0;
    driver.driftBefore(PROFILE_TABLE, 2, (database) => {
      database
        .prepare("UPDATE sfc_profiles SET ownerId = 'o2' WHERE id = 'pr1'")
        .run();
    });

    const outcome = await outcomeOf(
      client.owner.update({
        where: { id: "o1" },
        data: {
          name: "renamed",
          profile: {
            upsert: {
              create: { id: "pr-new", bio: "created" },
              update: { bio: "written-by-o1" },
            },
          },
        },
      })
    );

    expect(driver.drifted).toBe(true);
    expect(outcome.value).toBeUndefined();
    expect(outcome.failure).toBeInstanceOf(NotFoundError);
    expect((outcome.failure as Error).message).toBe(
      "No profile record found for update"
    );
    expect(matching(driver, "UPDATE", PROFILE_TABLE)).toEqual([]);
    expect(matching(driver, "INSERT", PROFILE_TABLE)).toEqual([]);
    // As above, the drift rolled back with the operation it rode. What is
    // durable here is that NOTHING of the operation committed: no member
    // write, and the parent's own rename in the same operation is gone too.
    expect(
      await client.profile.findUnique({ where: { id: "pr1" } })
    ).toMatchObject({ bio: "original" });
    expect(
      await client.owner.findUnique({ where: { id: "o1" } })
    ).toMatchObject({ name: "one" });
  });

  test("a target lost AFTER the confirmation is caught by the reader of last resort", async () => {
    await client.owner.create({
      data: {
        id: "o1",
        name: "one",
        profile: { create: { id: "pr1", bio: "original" } },
      },
    });
    driver.statements.length = 0;
    // The window the confirmation cannot close here: it has already answered,
    // and SQLite's select assembly omits `FOR UPDATE`
    // (`sqlite-adapter.ts:702–707`), so the row is held by nothing between that
    // answer and the effect. What answers is the key demand this arm's binding
    // makes (`relation-body.ts:962–970`) and the stored-row read it makes
    // `OperationContext.update` issue — the reader of LAST resort. Delete
    // either of those two and this cell goes green-by-silence: the UPDATE
    // writes no row and the operation resolves.
    driver.driftBeforeMutation(PROFILE_TABLE, (database) => {
      database.prepare("DELETE FROM sfc_profiles WHERE id = 'pr1'").run();
    });

    const outcome = await outcomeOf(
      client.owner.update({
        where: { id: "o1" },
        data: {
          name: "renamed",
          profile: {
            upsert: {
              create: { id: "pr-new", bio: "created" },
              update: { bio: "written-by-o1" },
            },
          },
        },
      })
    );

    expect(driver.drifted).toBe(true);
    expect(outcome.value).toBeUndefined();
    expect((outcome.failure as Error).message).toBe(
      "UPDATE RETURNING did not produce the required record"
    );
    // The effect DID go out — that is the point of this window — and the reader
    // is what learns it wrote nothing. No create-arm recovery either.
    expect(matching(driver, "UPDATE", PROFILE_TABLE)).toHaveLength(1);
    expect(matching(driver, "INSERT", PROFILE_TABLE)).toEqual([]);
    // Nothing of the operation committed: no member write, and the parent's own
    // rename in the same operation is gone with it (the drift rode this
    // operation's transaction, so the deleted row came back with the rollback).
    expect(
      await client.profile.findUnique({ where: { id: "pr1" } })
    ).toMatchObject({ bio: "original" });
    expect(
      await client.owner.findUnique({ where: { id: "o1" } })
    ).toMatchObject({ name: "one" });
  });

  test("an uncontended found consumption commits its ordinary result", async () => {
    await client.tag.create({ data: { id: "t1", name: "chosen", count: 7 } });
    await client.badge.create({
      data: { id: "b1", slug: "chosen", code: "G" },
    });
    driver.statements.length = 0;

    const upserted = await client.tag.upsert({
      where: { id: "t1" },
      setWhere: { count: 7 },
      create: { id: "t1", name: "chosen", count: 0 },
      update: { count: 42 },
    });
    await client.holder.create({
      data: {
        id: "h1",
        badge: {
          connectOrCreate: {
            where: { slug: "chosen" },
            create: { id: "never-created", slug: "chosen", code: "N" },
          },
        },
      },
    });

    expect(upserted).toMatchObject({ id: "t1", count: 42 });
    expect(
      await client.holder.findUnique({ where: { id: "h1" } })
    ).toMatchObject({ badgeCode: "G" });
    // A miss takes no confirmation at all: the arm that INSERTS the key it
    // looked for has no found row to confirm.
    const missDriver = new DriftingSQLite3Driver();
    const missClient = createClient({
      schema,
      driver: missDriver,
    }) as FoundClient;
    await syncLiveSchema(missClient);
    missDriver.statements.length = 0;
    await missClient.tag.upsert({
      where: { id: "absent" },
      setWhere: { count: 7 },
      create: { id: "absent", name: "absent", count: 1 },
      update: { count: 42 },
    });
    expect(planTimeReads(missDriver, TAG_TABLE)).toHaveLength(2);
    expect(matching(missDriver, "INSERT", TAG_TABLE)).toHaveLength(1);
  });
});
