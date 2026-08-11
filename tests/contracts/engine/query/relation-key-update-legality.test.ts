// biome-ignore-all lint/suspicious/noMisplacedAssertion: expectParity is invoked only from test cases.
import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import type { BatchQuery, QueryResult } from "@drivers/types";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { s } from "@schema";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { describe, expect, test } from "vitest";

const AUTHOR_ID_RELATION_KEY_ERROR = /relation key field 'authorId'/;
// M12: the general owned-foreign-key refusal, which precedes this file's rule wherever
// the rewritten relation key is the key the ENCLOSING relation owns.
/** N1 — the parse boundary omits the enclosing relation's own foreign key from nested
 *  update data, so the payload's key is unknown before an operation is constructed. */
const POSTS_OWN_AUTHOR_ID_PARSE_ERROR = /Unknown key: authorId/;
const CODE_RELATION_KEY_ERROR = /relation key field 'code'/;
const ID_RELATION_KEY_ERROR = /relation key field 'id'/;
const OCCUPIED_RELATION_ERROR = /current relation is occupied/;
const SET_NULL_OCCUPIED_ERROR =
  /onUpdate\('setNull'\).*current relation is occupied/;
const RESTRICT_OCCUPIED_ERROR =
  /onUpdate\('restrict'\).*current relation is occupied/;
const TARGET_NOT_FOUND_ERROR = /target record was not found for this parent/;

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

// The NON-cascading sibling of organization/member: a rewritten non-PK referenced
// column whose nested create must take the post-SET value from the SET operand
// itself (UpdateOperation.resolveCreateParent's envelope unwrapping) — the cascade
// pair above never reaches that derivation (N5-U2: a cascading edge asks for no
// value at all).
const registry = s
  .model({
    id: s.int().id(),
    tag: s.int().unique(),
    entries: s.oneToMany(() => entry),
  })
  .map("relation_key_registries");

const entry = s
  .model({
    id: s.int().id(),
    name: s.string(),
    registryTag: s.int().nullable(),
    registry: s
      .manyToOne(() => registry)
      .fields("registryTag")
      .references("tag")
      .optional(),
  })
  .map("relation_key_entries");

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

// A NON-cascade ONE-TO-MANY: V1's occupied guard is cardinality-agnostic, so a
// child-held to-many under a referenced-PK transition rejects an occupied slot too.
const setNullList = s
  .model({
    id: s.int().id(),
    name: s.string(),
    items: s.oneToMany(() => setNullItem),
  })
  .map("relation_key_set_null_lists");

const setNullItem = s
  .model({
    id: s.int().id(),
    label: s.string(),
    listId: s.int().nullable(),
    list: s
      .manyToOne(() => setNullList)
      .fields("listId")
      .references("id")
      .optional()
      .onUpdate("setNull"),
  })
  .map("relation_key_set_null_items");

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
  registry,
  entry,
  setNullParent,
  setNullChild,
  setNullList,
  setNullItem,
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
  expectedError: RegExp | undefined,
  // Which typed refusal answers. `NestedWriteError` is this file's rule (CLASS IV, the
  // relation-key legality walk); a scenario whose payload is refused by a STRICTLY MORE
  // GENERAL rule first names that rule's class instead — see the M12 note below.
  expectedName = "NestedWriteError"
): Promise<void> {
  const live = await runScenario("live", scenario);
  const batch = await runScenario("batch", scenario);

  expect(batch.error).toEqual(live.error);
  if (expectedError) {
    expect(live.error?.name).toBe(expectedName);
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

  // M12 — DELIBERATE CLASS CHANGE, the state contract unchanged. `authorId` is not just
  // a relation key of the target here: it is the foreign key the ENCLOSING `posts`
  // relation owns, so this payload is illegal on its own, with or without the sibling
  // `author: { update }` this file's rule needs. The general refusal answers first,
  // which is also where Prisma lands — its `PostUpdateWithoutAuthorInput` omits the key
  // outright, so the relation-key rule is never consulted for this shape. What the test
  // is FOR is unchanged and still asserted: the nested data is judged before any outer
  // effect, and the snapshot shows nothing written. CLASS IV keeps its own coverage —
  // any relation key of the target that the enclosing relation does NOT own (and the two
  // root-level scenarios above and below) still raise `NestedWriteError` here.
  //
  // PACKAGE N1 MOVED IT ONE LAYER FURTHER OUT, and Prisma's own reasoning is now the
  // MECHANISM rather than a coincidence: nested update data is built from the same
  // omitted-FK owner nested create data is, so `authorId` is not a key of this payload's
  // schema and the answer is `ValidationError: Unknown key: authorId` at the parse.
  // Previously it was the engine's `Relation 'posts' owns 'authorId'; omit it from
  // nested create and update data`, one construction step later — the same decision,
  // still before any statement, with a less specific sentence. That trade was already
  // made on the create side, and `nested-update-owned-fk.test.ts` owns the full account
  // including the one schema shape that still reaches the engine guard.
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
      POSTS_OWN_AUTHOR_ID_PARSE_ERROR,
      "ValidationError"
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

  test("the `{ set: v }` envelope on a rewritten NON-cascading referenced column feeds a nested CREATE the post-SET value", async () => {
    // N7-U-B's third absorption (UpdateOperation.resolveCreateParent): the envelope
    // spelling and the bare literal are ONE assignment. The edge must NOT cascade —
    // a cascading edge never consults this derivation (N5-U2) — which is why this
    // witness lives on registry/entry, not organization/member. Falsified:
    // reverting the envelope unwrapping to the bare
    // `input.rootScalarData[referencedField]` read fails this test with
    // "references a non-literal rewritten column 'tag'" while the bare-literal
    // sibling below still passes.
    await expectParity(
      {
        seed: async (client) => {
          await client.registry.create({ data: { id: 1, tag: 10 } });
        },
        act: (client) =>
          client.registry.update({
            where: { id: 1 },
            data: {
              tag: { set: 11 },
              entries: { create: { id: 2, name: "Fresh" } },
            },
          }),
        snapshot: async (client) => ({
          registries: await client.registry.findMany(),
          entries: await client.entry.findMany(),
        }),
        expectedState: {
          registries: [{ id: 1, tag: 11 }],
          entries: [{ id: 2, name: "Fresh", registryTag: 11 }],
        },
      },
      undefined
    );
  });

  test("the bare literal on a rewritten NON-cascading referenced column feeds a nested CREATE the same value", async () => {
    // The control beside the envelope witness: the two spellings must stay one
    // assignment. If the envelope test fails and this one passes, the envelope
    // unwrapping is what broke.
    await expectParity(
      {
        seed: async (client) => {
          await client.registry.create({ data: { id: 1, tag: 10 } });
        },
        act: (client) =>
          client.registry.update({
            where: { id: 1 },
            data: {
              tag: 12,
              entries: { create: { id: 3, name: "Bare" } },
            },
          }),
        snapshot: async (client) => ({
          registries: await client.registry.findMany(),
          entries: await client.entry.findMany(),
        }),
        expectedState: {
          registries: [{ id: 1, tag: 12 }],
          entries: [{ id: 3, name: "Bare", registryTag: 12 }],
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

  // T4c-fix — V1's occupied guard is kind- AND cardinality-agnostic: EVERY nested
  // mutation on a child-held, non-cascade relation whose referenced PK the SAME root
  // update transitions rejects an occupied OLD slot, not only the nested `upsert` the
  // original T4c wired. The finding: update / delete / disconnect / create (and the whole
  // to-many family) reached NO guard and diverged (accept-where-V1-rejects — corruption /
  // data-loss). These reproduce V1's verdict natively (byte-identical NestedWriteError,
  // both substrates); the empty-slot accept-shapes stay native.
  const seedOccupiedSetNullOneToOne = async (client: LegalityClient) => {
    await client.setNullParent.create({ data: { id: 1, name: "Parent" } });
    await client.setNullChild.create({
      data: { id: 1, label: "Child", parentId: 1 },
    });
  };
  const setNullOneToOneState = async (client: LegalityClient) => ({
    parents: await client.setNullParent.findMany(),
    children: await client.setNullChild.findMany(),
  });
  const occupiedSetNullOneToOneUnchanged = {
    parents: [{ id: 1, name: "Parent" }],
    children: [{ id: 1, label: "Child", parentId: 1 }],
  };

  test("rejects an occupied setNull child-held UPDATE under a PK transition", async () => {
    await expectParity(
      {
        seed: seedOccupiedSetNullOneToOne,
        act: (client) =>
          client.setNullParent.update({
            where: { id: 1 },
            data: {
              id: { increment: 1 },
              child: { update: { label: "must not change" } },
            },
          }),
        snapshot: setNullOneToOneState,
        expectedState: occupiedSetNullOneToOneUnchanged,
      },
      SET_NULL_OCCUPIED_ERROR
    );
  });

  test("rejects an occupied setNull child-held DELETE under a PK transition", async () => {
    await expectParity(
      {
        seed: seedOccupiedSetNullOneToOne,
        act: (client) =>
          client.setNullParent.update({
            where: { id: 1 },
            data: { id: { increment: 1 }, child: { delete: true } },
          }),
        snapshot: setNullOneToOneState,
        expectedState: occupiedSetNullOneToOneUnchanged,
      },
      SET_NULL_OCCUPIED_ERROR
    );
  });

  test("rejects an occupied setNull child-held DISCONNECT under a PK transition", async () => {
    await expectParity(
      {
        seed: seedOccupiedSetNullOneToOne,
        act: (client) =>
          client.setNullParent.update({
            where: { id: 1 },
            data: { id: { increment: 1 }, child: { disconnect: true } },
          }),
        snapshot: setNullOneToOneState,
        expectedState: occupiedSetNullOneToOneUnchanged,
      },
      SET_NULL_OCCUPIED_ERROR
    );
  });

  test("reports not-found for an empty setNull child-held UPDATE under a PK transition", async () => {
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
              id: { increment: 1 },
              child: { update: { label: "no target" } },
            },
          }),
        snapshot: setNullOneToOneState,
        expectedState: { parents: [{ id: 1, name: "Parent" }], children: [] },
      },
      TARGET_NOT_FOUND_ERROR
    );
  });

  test("allows an empty setNull child-held DELETE under a PK transition", async () => {
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
            data: { id: { increment: 1 }, child: { delete: true } },
          }),
        snapshot: setNullOneToOneState,
        expectedState: { parents: [{ id: 2, name: "Parent" }], children: [] },
      },
      undefined
    );
  });

  test("rejects an occupied restrict child-held UPDATE under a PK transition", async () => {
    await expectParity(
      {
        seed: async (client) => {
          await client.restrictParent.create({
            data: { id: 1, name: "Parent" },
          });
          await client.restrictChild.create({
            data: { id: 1, label: "Child", parentId: 1 },
          });
        },
        act: (client) =>
          client.restrictParent.update({
            where: { id: 1 },
            data: {
              id: { increment: 1 },
              child: { update: { label: "must not change" } },
            },
          }),
        snapshot: async (client) => ({
          parents: await client.restrictParent.findMany(),
          children: await client.restrictChild.findMany(),
        }),
        expectedState: {
          parents: [{ id: 1, name: "Parent" }],
          children: [{ id: 1, label: "Child", parentId: 1 }],
        },
      },
      RESTRICT_OCCUPIED_ERROR
    );
  });

  test("rejects an occupied restrict child-held DELETE under a PK transition", async () => {
    await expectParity(
      {
        seed: async (client) => {
          await client.restrictParent.create({
            data: { id: 1, name: "Parent" },
          });
          await client.restrictChild.create({
            data: { id: 1, label: "Child", parentId: 1 },
          });
        },
        act: (client) =>
          client.restrictParent.update({
            where: { id: 1 },
            data: { id: { increment: 1 }, child: { delete: true } },
          }),
        snapshot: async (client) => ({
          parents: await client.restrictParent.findMany(),
          children: await client.restrictChild.findMany(),
        }),
        expectedState: {
          parents: [{ id: 1, name: "Parent" }],
          children: [{ id: 1, label: "Child", parentId: 1 }],
        },
      },
      RESTRICT_OCCUPIED_ERROR
    );
  });

  const seedOccupiedSetNullToMany = async (client: LegalityClient) => {
    await client.setNullList.create({ data: { id: 1, name: "List" } });
    await client.setNullItem.create({
      data: { id: 10, label: "Item", listId: 1 },
    });
  };
  const setNullToManyState = async (client: LegalityClient) => ({
    lists: await client.setNullList.findMany({ orderBy: { id: "asc" } }),
    items: await client.setNullItem.findMany({ orderBy: { id: "asc" } }),
  });
  const occupiedSetNullToManyUnchanged = {
    lists: [{ id: 1, name: "List" }],
    items: [{ id: 10, label: "Item", listId: 1 }],
  };

  test("rejects an occupied setNull TO-MANY UPDATE under a PK transition", async () => {
    await expectParity(
      {
        seed: seedOccupiedSetNullToMany,
        act: (client) =>
          client.setNullList.update({
            where: { id: 1 },
            data: {
              id: { increment: 5 },
              items: { update: { where: { id: 10 }, data: { label: "X" } } },
            },
          }),
        snapshot: setNullToManyState,
        expectedState: occupiedSetNullToManyUnchanged,
      },
      SET_NULL_OCCUPIED_ERROR
    );
  });

  test("rejects an occupied setNull TO-MANY DELETE under a PK transition", async () => {
    await expectParity(
      {
        seed: seedOccupiedSetNullToMany,
        act: (client) =>
          client.setNullList.update({
            where: { id: 1 },
            data: { id: { increment: 5 }, items: { delete: { id: 10 } } },
          }),
        snapshot: setNullToManyState,
        expectedState: occupiedSetNullToManyUnchanged,
      },
      SET_NULL_OCCUPIED_ERROR
    );
  });

  test("rejects an occupied setNull TO-MANY CREATE under a PK transition", async () => {
    await expectParity(
      {
        seed: seedOccupiedSetNullToMany,
        act: (client) =>
          client.setNullList.update({
            where: { id: 1 },
            data: {
              id: { increment: 5 },
              items: { create: { id: 20, label: "New" } },
            },
          }),
        snapshot: setNullToManyState,
        expectedState: occupiedSetNullToManyUnchanged,
      },
      SET_NULL_OCCUPIED_ERROR
    );
  });

  test("allows an empty setNull TO-MANY CREATE under a PK transition", async () => {
    await expectParity(
      {
        seed: async (client) => {
          await client.setNullList.create({ data: { id: 1, name: "List" } });
        },
        act: (client) =>
          client.setNullList.update({
            where: { id: 1 },
            data: {
              id: { increment: 5 },
              items: { create: { id: 20, label: "New" } },
            },
          }),
        snapshot: setNullToManyState,
        expectedState: {
          lists: [{ id: 6, name: "List" }],
          items: [{ id: 20, label: "New", listId: 6 }],
        },
      },
      undefined
    );
  });

  // MULTI-PARENT WITNESS: the occupied guard correlates on THIS parent's pre-transition
  // value, not globally. An occupied SIBLING (list 2, its own item) must NOT false-reject
  // an EMPTY target's (list 1) transition — the create lands on list 1's post-transition
  // id, the sibling's item is untouched. (Falsifying the guard's `before` correlation to a
  // constant would reject here where V1 accepts.)
  test("correlates the occupied guard on THIS parent (occupied sibling does not false-reject an empty target)", async () => {
    await expectParity(
      {
        seed: async (client) => {
          await client.setNullList.create({ data: { id: 1, name: "Target" } });
          await client.setNullList.create({ data: { id: 2, name: "Sibling" } });
          await client.setNullItem.create({
            data: { id: 30, label: "SiblingItem", listId: 2 },
          });
        },
        act: (client) =>
          client.setNullList.update({
            where: { id: 1 },
            data: {
              id: { increment: 5 },
              items: { create: { id: 20, label: "New" } },
            },
          }),
        snapshot: setNullToManyState,
        expectedState: {
          lists: [
            { id: 2, name: "Sibling" },
            { id: 6, name: "Target" },
          ],
          items: [
            { id: 20, label: "New", listId: 6 },
            { id: 30, label: "SiblingItem", listId: 2 },
          ],
        },
      },
      undefined
    );
  });

  // MULTI-PARENT WITNESS (reject side): an occupied TARGET rejects even when a sibling is
  // also occupied — the guard finds the target's own child, and the sibling stays put.
  test("rejects an occupied target UPDATE while an occupied sibling is untouched", async () => {
    await expectParity(
      {
        seed: async (client) => {
          await client.setNullList.create({ data: { id: 1, name: "Target" } });
          await client.setNullItem.create({
            data: { id: 10, label: "TargetItem", listId: 1 },
          });
          await client.setNullList.create({ data: { id: 2, name: "Sibling" } });
          await client.setNullItem.create({
            data: { id: 30, label: "SiblingItem", listId: 2 },
          });
        },
        act: (client) =>
          client.setNullList.update({
            where: { id: 1 },
            data: {
              id: { increment: 5 },
              items: { update: { where: { id: 10 }, data: { label: "X" } } },
            },
          }),
        snapshot: setNullToManyState,
        expectedState: {
          lists: [
            { id: 1, name: "Target" },
            { id: 2, name: "Sibling" },
          ],
          items: [
            { id: 10, label: "TargetItem", listId: 1 },
            { id: 30, label: "SiblingItem", listId: 2 },
          ],
        },
      },
      SET_NULL_OCCUPIED_ERROR
    );
  });
});
