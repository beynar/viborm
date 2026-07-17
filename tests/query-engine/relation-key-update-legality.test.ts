// biome-ignore-all lint/suspicious/noMisplacedAssertion: expectParity is invoked only from test cases.
import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import type { BatchQuery, QueryResult } from "@drivers/types";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { s } from "@schema";
import { describe, expect, test } from "vitest";

const AUTHOR_ID_RELATION_KEY_ERROR = /relation key field 'authorId'/;
const CODE_RELATION_KEY_ERROR = /relation key field 'code'/;
const ID_RELATION_KEY_ERROR = /relation key field 'id'/;
const OCCUPIED_RELATION_ERROR = /current relation is occupied/;
const SET_NULL_OCCUPIED_ERROR =
  /onUpdate\('setNull'\).*current relation is occupied/;

class BatchOnlyPGliteDriver extends PGliteDriver {
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

class MissingSlotRaceBatchDriver extends BatchOnlyPGliteDriver {
  private isArmed = false;
  private hasPlanted = false;
  private readonly plant: (client: PGlite) => Promise<void>;

  constructor(client: PGlite, plant: (client: PGlite) => Promise<void>) {
    super({ client });
    this.plant = plant;
  }

  arm(): void {
    this.isArmed = true;
  }

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    if (this.isArmed && !this.hasPlanted) {
      if (!(client instanceof PGlite)) {
        throw new Error(
          "Missing-slot planting requires the base PGlite client."
        );
      }
      this.hasPlanted = true;
      await this.plant(client);
    }
    return super.executeBatch<T>(client, queries);
  }
}

const author = s
  .model({
    id: s.int().id(),
    name: s.string(),
    posts: s.oneToMany(() => post),
  })
  .map("relation_key_authors");

const post = s
  .model({
    id: s.int().id(),
    title: s.string(),
    score: s.int(),
    authorId: s.int().nullable(),
    author: s
      .manyToOne(() => author)
      .fields("authorId")
      .references("id")
      .optional()
      .onUpdate("cascade"),
  })
  .map("relation_key_posts");

const organization = s
  .model({
    id: s.int().id(),
    code: s.int().unique(),
    members: s.oneToMany(() => member),
  })
  .map("relation_key_organizations");

const member = s
  .model({
    id: s.int().id(),
    name: s.string(),
    organizationCode: s.int().nullable(),
    organization: s
      .manyToOne(() => organization)
      .fields("organizationCode")
      .references("code")
      .optional()
      .onUpdate("cascade"),
  })
  .map("relation_key_members");

const setNullParent = s
  .model({
    id: s.int().id(),
    name: s.string(),
    child: s.oneToOne(() => setNullChild).optional(),
  })
  .map("relation_key_set_null_parents");

const setNullChild = s
  .model({
    id: s.int().id(),
    label: s.string(),
    parentId: s.int().unique().nullable(),
    parent: s
      .oneToOne(() => setNullParent)
      .fields("parentId")
      .references("id")
      .optional()
      .onUpdate("setNull"),
  })
  .map("relation_key_set_null_children");

const restrictParent = s
  .model({
    id: s.int().id(),
    name: s.string(),
    child: s.oneToOne(() => restrictChild).optional(),
  })
  .map("relation_key_restrict_parents");

const restrictChild = s
  .model({
    id: s.int().id(),
    label: s.string(),
    parentId: s.int().unique().nullable(),
    parent: s
      .oneToOne(() => restrictParent)
      .fields("parentId")
      .references("id")
      .optional()
      .onUpdate("restrict"),
  })
  .map("relation_key_restrict_children");

const cascadeParent = s
  .model({
    id: s.int().id(),
    name: s.string(),
    child: s.oneToOne(() => cascadeChild).optional(),
  })
  .map("relation_key_cascade_parents");

const cascadeChild = s
  .model({
    id: s.int().id(),
    label: s.string(),
    parentId: s.int().unique().nullable(),
    parent: s
      .oneToOne(() => cascadeParent)
      .fields("parentId")
      .references("id")
      .optional()
      .onUpdate("cascade"),
  })
  .map("relation_key_cascade_children");

const sharedAccount = s
  .model({
    id: s.int().id(),
    name: s.string(),
    profile: s.oneToOne(() => sharedProfile).optional(),
  })
  .map("relation_key_shared_accounts");

const sharedProfile = s
  .model({
    id: s.int().id(),
    label: s.string(),
    account: s
      .oneToOne(() => sharedAccount)
      .fields("id")
      .references("id")
      .onUpdate("cascade"),
  })
  .map("relation_key_shared_profiles");

const schema = {
  author,
  post,
  organization,
  member,
  setNullParent,
  setNullChild,
  restrictParent,
  restrictChild,
  cascadeParent,
  cascadeChild,
  sharedAccount,
  sharedProfile,
};

type LegalityClient = ReturnType<typeof createLegalityClient>;

interface Scenario {
  seed: (client: LegalityClient) => Promise<unknown>;
  act: (client: LegalityClient) => PromiseLike<unknown>;
  snapshot: (client: LegalityClient) => Promise<unknown>;
  expectedState: unknown;
}

interface Outcome {
  error: { name: string; message: string } | undefined;
  state: unknown;
}

function createLegalityClient(driver: PGliteDriver) {
  return createClient({ schema, driver });
}

async function runScenario(
  mode: "batch" | "live",
  scenario: Scenario
): Promise<Outcome> {
  const database = new PGlite();
  const driver =
    mode === "live"
      ? new PGliteDriver({ client: database })
      : new BatchOnlyPGliteDriver({ client: database });
  const client = createLegalityClient(driver);
  try {
    await push(client, { force: true });
    await scenario.seed(client);
    let error: Outcome["error"];
    try {
      await scenario.act(client);
    } catch (failure) {
      error =
        failure instanceof Error
          ? { name: failure.name, message: failure.message }
          : { name: typeof failure, message: String(failure) };
    }
    return { error, state: await scenario.snapshot(client) };
  } finally {
    await client.$disconnect();
  }
}

async function expectParity(
  scenario: Scenario,
  expectedError: RegExp | undefined
): Promise<void> {
  const live = await runScenario("live", scenario);
  const batch = await runScenario("batch", scenario);

  expect(batch.error).toEqual(live.error);
  if (expectedError) {
    expect(live.error?.name).toBe("NestedWriteError");
    expect(live.error?.message).toMatch(expectedError);
  } else {
    expect(live.error).toBeUndefined();
  }
  expect(live.state).toEqual(scenario.expectedState);
  expect(batch.state).toEqual(scenario.expectedState);
}

async function seedAuthorsAndPost(client: LegalityClient): Promise<void> {
  await client.author.create({ data: { id: 1, name: "Original" } });
  await client.author.create({ data: { id: 2, name: "Final" } });
  await client.post.create({
    data: { id: 10, title: "Post", score: 0, authorId: 1 },
  });
}

async function authorPostState(client: LegalityClient): Promise<unknown> {
  return {
    authors: await client.author.findMany({ orderBy: { id: "asc" } }),
    posts: await client.post.findMany({ orderBy: { id: "asc" } }),
  };
}

const originalAuthorPostState = {
  authors: [
    { id: 1, name: "Original" },
    { id: 2, name: "Final" },
  ],
  posts: [{ id: 10, title: "Post", score: 0, authorId: 1 }],
};

describe("relation-key update legality", () => {
  test("rejects parent local-FK arithmetic before effects in both modes", async () => {
    await expectParity(
      {
        seed: seedAuthorsAndPost,
        act: (client) =>
          client.post.update({
            where: { id: 10 },
            data: {
              authorId: { increment: 1 },
              author: { update: { name: "must not change" } },
            },
          }),
        snapshot: authorPostState,
        expectedState: originalAuthorPostState,
      },
      AUTHOR_ID_RELATION_KEY_ERROR
    );
  });

  test("rejects computed shared primary/local-FK transitions", async () => {
    await expectParity(
      {
        seed: async (client) => {
          await client.sharedAccount.create({
            data: { id: 1, name: "Original" },
          });
          await client.sharedAccount.create({ data: { id: 2, name: "Final" } });
          await client.sharedProfile.create({
            data: { id: 1, label: "Profile" },
          });
        },
        act: (client) =>
          client.sharedProfile.update({
            where: { id: 1 },
            data: {
              id: { increment: 1 },
              account: { update: { name: "must not change" } },
            },
          }),
        snapshot: async (client) => ({
          accounts: await client.sharedAccount.findMany({
            orderBy: { id: "asc" },
          }),
          profiles: await client.sharedProfile.findMany(),
        }),
        expectedState: {
          accounts: [
            { id: 1, name: "Original" },
            { id: 2, name: "Final" },
          ],
          profiles: [{ id: 1, label: "Profile" }],
        },
      },
      ID_RELATION_KEY_ERROR
    );
  });

  test("recurses into nested update data before outer effects", async () => {
    await expectParity(
      {
        seed: seedAuthorsAndPost,
        act: (client) =>
          client.author.update({
            where: { id: 1 },
            data: {
              posts: {
                update: {
                  where: { id: 10 },
                  data: {
                    authorId: { increment: 1 },
                    author: { update: { name: "must not change" } },
                  },
                },
              },
            },
          }),
        snapshot: authorPostState,
        expectedState: originalAuthorPostState,
      },
      AUTHOR_ID_RELATION_KEY_ERROR
    );
  });

  test("validates the taken top-level upsert update branch", async () => {
    await expectParity(
      {
        seed: seedAuthorsAndPost,
        act: (client) =>
          client.post.upsert({
            where: { id: 10 },
            create: { id: 10, title: "Create", score: 0, authorId: 1 },
            update: {
              authorId: { increment: 1 },
              author: { update: { name: "must not change" } },
            },
          }),
        snapshot: authorPostState,
        expectedState: originalAuthorPostState,
      },
      AUTHOR_ID_RELATION_KEY_ERROR
    );
  });

  test("does not validate an untaken top-level upsert update branch", async () => {
    await expectParity(
      {
        seed: async (client) => {
          await client.author.create({ data: { id: 1, name: "Author" } });
        },
        act: (client) =>
          client.post.upsert({
            where: { id: 99 },
            create: { id: 99, title: "Created", score: 0, authorId: 1 },
            update: {
              authorId: { increment: 1 },
              author: { update: { name: "untaken" } },
            },
          }),
        snapshot: authorPostState,
        expectedState: {
          authors: [{ id: 1, name: "Author" }],
          posts: [{ id: 99, title: "Created", score: 0, authorId: 1 }],
        },
      },
      undefined
    );
  });

  test("rejects non-PK referenced arithmetic before effects", async () => {
    await expectParity(
      {
        seed: async (client) => {
          await client.organization.create({ data: { id: 1, code: 10 } });
          await client.member.create({
            data: { id: 1, name: "Member", organizationCode: 10 },
          });
        },
        act: (client) =>
          client.organization.update({
            where: { id: 1 },
            data: {
              code: { increment: 1 },
              members: {
                update: { where: { id: 1 }, data: { name: "changed" } },
              },
            },
          }),
        snapshot: async (client) => ({
          organizations: await client.organization.findMany(),
          members: await client.member.findMany(),
        }),
        expectedState: {
          organizations: [{ id: 1, code: 10 }],
          members: [{ id: 1, name: "Member", organizationCode: 10 }],
        },
      },
      CODE_RELATION_KEY_ERROR
    );
  });

  test("rejects non-cascade child-holds key transition with nested upsert", async () => {
    await expectParity(
      {
        seed: async (client) => {
          await client.setNullParent.create({
            data: { id: 1, name: "Parent" },
          });
          await client.setNullChild.create({
            data: { id: 1, label: "Child", parentId: 1 },
          });
        },
        act: (client) =>
          client.setNullParent.update({
            where: { id: 1 },
            data: {
              id: { increment: 1 },
              child: {
                upsert: {
                  create: { id: 2, label: "Created" },
                  update: { label: "Updated" },
                },
              },
            },
          }),
        snapshot: async (client) => ({
          parents: await client.setNullParent.findMany(),
          children: await client.setNullChild.findMany(),
        }),
        expectedState: {
          parents: [{ id: 1, name: "Parent" }],
          children: [{ id: 1, label: "Child", parentId: 1 }],
        },
      },
      SET_NULL_OCCUPIED_ERROR
    );
  });

  test("allows same-value set on an occupied setNull relation", async () => {
    await expectParity(
      {
        seed: async (client) => {
          await client.setNullParent.create({
            data: { id: 1, name: "Parent" },
          });
          await client.setNullChild.create({
            data: { id: 1, label: "Child", parentId: 1 },
          });
        },
        act: (client) =>
          client.setNullParent.update({
            where: { id: 1 },
            data: {
              id: { set: 1 },
              child: {
                upsert: {
                  create: { id: 2, label: "Created" },
                  update: { label: "Updated" },
                },
              },
            },
          }),
        snapshot: async (client) => ({
          parents: await client.setNullParent.findMany(),
          children: await client.setNullChild.findMany(),
        }),
        expectedState: {
          parents: [{ id: 1, name: "Parent" }],
          children: [{ id: 1, label: "Updated", parentId: 1 }],
        },
      },
      undefined
    );
  });

  test("allows increment zero on an occupied setNull relation", async () => {
    await expectParity(
      {
        seed: async (client) => {
          await client.setNullParent.create({
            data: { id: 1, name: "Parent" },
          });
          await client.setNullChild.create({
            data: { id: 1, label: "Child", parentId: 1 },
          });
        },
        act: (client) =>
          client.setNullParent.update({
            where: { id: 1 },
            data: {
              id: { increment: 0 },
              child: {
                upsert: {
                  create: { id: 2, label: "Created" },
                  update: { label: "Updated zero" },
                },
              },
            },
          }),
        snapshot: async (client) => ({
          parents: await client.setNullParent.findMany(),
          children: await client.setNullChild.findMany(),
        }),
        expectedState: {
          parents: [{ id: 1, name: "Parent" }],
          children: [{ id: 1, label: "Updated zero", parentId: 1 }],
        },
      },
      undefined
    );
  });

  test("allows a setNull key transition when the old slot is empty", async () => {
    await expectParity(
      {
        seed: async (client) => {
          await client.setNullParent.create({
            data: { id: 1, name: "Parent" },
          });
        },
        act: (client) =>
          client.setNullParent.update({
            where: { id: 1 },
            data: {
              id: 2,
              child: {
                upsert: {
                  create: { id: 2, label: "Created" },
                  update: { label: "Untaken" },
                },
              },
            },
          }),
        snapshot: async (client) => ({
          parents: await client.setNullParent.findMany(),
          children: await client.setNullChild.findMany(),
        }),
        expectedState: {
          parents: [{ id: 2, name: "Parent" }],
          children: [{ id: 2, label: "Created", parentId: 2 }],
        },
      },
      undefined
    );
  });

  test("allows a restrict key transition when the old slot is empty", async () => {
    await expectParity(
      {
        seed: async (client) => {
          await client.restrictParent.create({
            data: { id: 1, name: "Parent" },
          });
        },
        act: (client) =>
          client.restrictParent.update({
            where: { id: 1 },
            data: {
              id: 2,
              child: {
                upsert: {
                  create: { id: 2, label: "Created" },
                  update: { label: "Untaken" },
                },
              },
            },
          }),
        snapshot: async (client) => ({
          parents: await client.restrictParent.findMany(),
          children: await client.restrictChild.findMany(),
        }),
        expectedState: {
          parents: [{ id: 2, name: "Parent" }],
          children: [{ id: 2, label: "Created", parentId: 2 }],
        },
      },
      undefined
    );
  });

  test("pins an empty setNull slot until the parent update executes", async () => {
    const database = new PGlite();
    const driver = new MissingSlotRaceBatchDriver(
      database,
      async (plantingClient) => {
        await plantingClient.query(
          'INSERT INTO "relation_key_set_null_children" ("id", "label", "parentId") VALUES ($1, $2, $3)',
          [1, "Concurrent", 1]
        );
      }
    );
    const client = createLegalityClient(driver);
    try {
      await push(client, { force: true });
      await client.setNullParent.create({ data: { id: 1, name: "Parent" } });
      driver.arm();

      await expect(
        client.setNullParent.update({
          where: { id: 1 },
          data: {
            id: 2,
            child: {
              upsert: {
                create: { id: 2, label: "Created" },
                update: { label: "Updated" },
              },
            },
          },
        })
      ).rejects.toThrow(OCCUPIED_RELATION_ERROR);

      await expect(client.setNullParent.findMany()).resolves.toEqual([
        { id: 1, name: "Parent" },
      ]);
      await expect(client.setNullChild.findMany()).resolves.toEqual([
        { id: 1, label: "Concurrent", parentId: 1 },
      ]);
    } finally {
      await client.$disconnect();
    }
  });

  test("allows literal local-FK rebind and non-referenced arithmetic", async () => {
    await expectParity(
      {
        seed: seedAuthorsAndPost,
        act: (client) =>
          client.post.update({
            where: { id: 10 },
            data: {
              score: { increment: 1 },
              authorId: { set: 2 },
              author: { update: { name: "Updated final" } },
            },
          }),
        snapshot: authorPostState,
        expectedState: {
          authors: [
            { id: 1, name: "Original" },
            { id: 2, name: "Updated final" },
          ],
          posts: [{ id: 10, title: "Post", score: 1, authorId: 2 }],
        },
      },
      undefined
    );
  });

  test("allows literal non-PK referenced transition with cascade", async () => {
    await expectParity(
      {
        seed: async (client) => {
          await client.organization.create({ data: { id: 1, code: 10 } });
          await client.member.create({
            data: { id: 1, name: "Member", organizationCode: 10 },
          });
        },
        act: (client) =>
          client.organization.update({
            where: { id: 1 },
            data: {
              code: { set: 11 },
              members: {
                update: { where: { id: 1 }, data: { name: "Updated" } },
              },
            },
          }),
        snapshot: async (client) => ({
          organizations: await client.organization.findMany(),
          members: await client.member.findMany(),
        }),
        expectedState: {
          organizations: [{ id: 1, code: 11 }],
          members: [{ id: 1, name: "Updated", organizationCode: 11 }],
        },
      },
      undefined
    );
  });

  test("allows primary-key arithmetic transition with cascade upsert", async () => {
    await expectParity(
      {
        seed: async (client) => {
          await client.cascadeParent.create({
            data: { id: 1, name: "Parent" },
          });
          await client.cascadeChild.create({
            data: { id: 1, label: "Child", parentId: 1 },
          });
        },
        act: (client) =>
          client.cascadeParent.update({
            where: { id: 1 },
            data: {
              id: { increment: 1 },
              child: {
                upsert: {
                  create: { id: 2, label: "Created" },
                  update: { label: "Updated" },
                },
              },
            },
          }),
        snapshot: async (client) => ({
          parents: await client.cascadeParent.findMany(),
          children: await client.cascadeChild.findMany(),
        }),
        expectedState: {
          parents: [{ id: 2, name: "Parent" }],
          children: [{ id: 1, label: "Updated", parentId: 2 }],
        },
      },
      undefined
    );
  });
});
