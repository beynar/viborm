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

const TAG_TABLE = /sfc_tags/;
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
    expect(
      matching(driver, "UPDATE", COMPOUND_GENERATED_CHILD_TABLE)
    ).toHaveLength(1);
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
    // No more statements than the read, the confirmation and the writes took.
    expect(driver.statements.length).toBeLessThanOrEqual(5);
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
    // No more statements than the read, the confirmation and the writes took.
    expect(driver.statements.length).toBeLessThanOrEqual(5);
  });

  test("an uncontended pair of conditions commits its ordinary result", async () => {
    await client.tag.create({ data: { id: "t1", name: "chosen", count: 7 } });
    driver.statements.length = 0;

    const upserted = await conjoinedUpsert(client);

    // No blanket refusal: the conjunction is a premise, not a prohibition.
    expect(upserted).toMatchObject({ id: "t1", name: "chosen", count: 42 });
    expect(planTimeReads(driver, TAG_TABLE).length).toBeLessThanOrEqual(4);
    expect(matching(driver, "UPDATE", TAG_TABLE)).toHaveLength(1);
    expect(matching(driver, "INSERT", TAG_TABLE)).toEqual([]);
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
    expect(planTimeReads(missDriver, TAG_TABLE).length).toBeLessThanOrEqual(2);
    expect(matching(missDriver, "INSERT", TAG_TABLE)).toHaveLength(1);
  });
});
