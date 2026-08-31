import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { observeClientOperations } from "@tests/contracts/engine/write/operation-observer";
import { compoundKeyBehaviorSchema } from "@tests/fixtures/compound-key-behavior-schema";
import {
  BatchOnlyPGliteDriver,
  type PGliteSchemaFamily,
  usePGliteSchemaFamily,
} from "@tests/fixtures/drivers/pglite";
import { describe, expect, test } from "vitest";

type RoutedModel = Record<string, (args: Record<string, unknown>) => unknown>;

interface ErrorShape {
  name: string;
  code?: string | number;
  message: string;
}

interface Scenario {
  name: string;
  seed?: (client: ReturnType<typeof makeClient>) => PromiseLike<unknown>;
  act: (client: Record<string, RoutedModel>) => unknown;
  expectReject?: boolean;
}

function makeClient(db: PGlite) {
  return createClient({
    schema: compoundKeyBehaviorSchema,
    driver: new PGliteDriver({ client: db }),
  });
}

function normalizeError(error: unknown): ErrorShape {
  if (!(error instanceof Error)) throw error;
  const code = "code" in error ? (error as { code?: unknown }).code : undefined;
  const stable =
    typeof code === "string" || typeof code === "number" ? code : undefined;
  return stable === undefined
    ? { name: error.name, message: error.message }
    : { name: error.name, code: stable, message: error.message };
}

async function dump(client: ReturnType<typeof makeClient>) {
  const [authors, posts, accounts, memberships] = await Promise.all([
    client.author.findMany({ orderBy: [{ tenantId: "asc" }, { id: "asc" }] }),
    client.post.findMany({ orderBy: { id: "asc" } }),
    client.account.findMany({ orderBy: { id: "asc" } }),
    client.membership.findMany({ orderBy: { id: "asc" } }),
  ]);
  return { authors, posts, accounts, memberships };
}

type ArmKind = "direct" | "observed-tx" | "observed-batch";

async function runArm(
  family: PGliteSchemaFamily<typeof compoundKeyBehaviorSchema>,
  kind: ArmKind,
  scenario: Scenario
) {
  await family.reset();
  const client = makeClient(family.database);
  await scenario.seed?.(client);

  let result: unknown;
  let error: ErrorShape | undefined;
  let operations: { boundary: "direct" | "production" }[] = [];
  try {
    if (kind === "direct") {
      result = await scenario.act(
        client as unknown as Record<string, RoutedModel>
      );
    } else {
      const driver =
        kind === "observed-tx"
          ? new PGliteDriver({ client: family.database })
          : new BatchOnlyPGliteDriver({ client: family.database });
      const observed = observeClientOperations({
        schema: compoundKeyBehaviorSchema,
        driver,
      });
      operations = observed.operations;
      result = await scenario.act(observed.client);
    }
  } catch (thrown) {
    error = normalizeError(thrown);
  }
  const routedToObserved =
    operations.length > 0 &&
    operations.every((r) => r.boundary === "production");
  const state = await dump(client);
  return { result, error, state, routedToObserved };
}

const twoTenants = async (client: ReturnType<typeof makeClient>) => {
  await client.author.create({
    data: { tenantId: "t1", id: "a1", name: "Alice" },
  });
  await client.author.create({
    data: { tenantId: "t2", id: "a1", name: "Alicia" },
  });
};

// Two authors sharing id "a1" across tenants, each with posts. Post p3 belongs
// to tenant t2 so a t1-scoped nested write must never reach it (the per-field
// correlation pin).
const compoundAuthorPosts = async (client: ReturnType<typeof makeClient>) => {
  await client.author.create({
    data: {
      tenantId: "t1",
      id: "a1",
      name: "Alice",
      posts: {
        create: [
          { id: "p1", title: "P1" },
          { id: "p2", title: "P2" },
        ],
      },
    },
  });
  await client.author.create({
    data: {
      tenantId: "t2",
      id: "a1",
      name: "Alicia",
      posts: { create: { id: "p3", title: "Other tenant" } },
    },
  });
};

// D4: two accounts, each with a membership whose FK references the parent's
// non-PK `[provider, providerId]` unique; plus an orphan membership. m2 belongs
// to acc-2, so an acc-1-scoped nested write must never reach it.
const d4AccountMemberships = async (client: ReturnType<typeof makeClient>) => {
  await client.account.create({
    data: { id: "acc-1", provider: "github", providerId: "u1" },
  });
  await client.account.create({
    data: { id: "acc-2", provider: "gitlab", providerId: "u2" },
  });
  await client.membership.create({
    data: {
      id: "m1",
      role: "member",
      accProvider: "github",
      accProviderId: "u1",
    },
  });
  await client.membership.create({
    data: {
      id: "m2",
      role: "member",
      accProvider: "gitlab",
      accProviderId: "u2",
    },
  });
  await client.membership.create({
    data: {
      id: "m-orphan",
      role: "member",
      accProvider: null,
      accProviderId: null,
    },
  });
};

// Per-field correlation is two-dimensional: to prove BOTH compound FK columns
// are load-bearing in the reject direction, each column needs a reject where it
// is the SOLE distinguisher. `compoundAuthorPosts`/`d4AccountMemberships` differ
// on the FIRST referenced column (tenantId / provider), so their reject
// scenarios catch a probe that drops the first column — but a probe that keeps
// the first and DROPS the second (`fkFields.slice(0, 1)`) stays invisible to
// them (the foreign child already differs on the surviving first column). The
// seeds below make the SECOND referenced column the sole distinguisher, so
// dropping it is caught.

// Two authors sharing tenant "t1" but differing on the SECOND referenced column
// (author id a1 vs a2). Post p2 belongs to a2, so a nested write correlated to
// a1 rejects ONLY because the authorId→id column is correlated; a probe that
// kept tenantId alone would wrongly reach p2 (both share tenantId="t1").
const sameTenantTwoAuthors = async (client: ReturnType<typeof makeClient>) => {
  await client.author.create({
    data: {
      tenantId: "t1",
      id: "a1",
      name: "Alice",
      posts: { create: { id: "p1", title: "Hers" } },
    },
  });
  await client.author.create({
    data: {
      tenantId: "t1",
      id: "a2",
      name: "Amy",
      posts: { create: { id: "p2", title: "His" } },
    },
  });
};

// D4 counterpart to `sameTenantTwoAuthors`: two accounts sharing provider
// "github" but differing on the SECOND referenced column (providerId u1 vs u2).
// m2 references u2, so a nested write correlated to acc-1 (github/u1) rejects
// ONLY because the accProviderId→providerId column is correlated; a probe that
// kept provider alone would wrongly reach m2 (both share provider="github").
const sameProviderTwoAccounts = async (
  client: ReturnType<typeof makeClient>
) => {
  await client.account.create({
    data: { id: "acc-1", provider: "github", providerId: "u1" },
  });
  await client.account.create({
    data: { id: "acc-2", provider: "github", providerId: "u2" },
  });
  await client.membership.create({
    data: {
      id: "m1",
      role: "member",
      accProvider: "github",
      accProviderId: "u1",
    },
  });
  await client.membership.create({
    data: {
      id: "m2",
      role: "member",
      accProvider: "github",
      accProviderId: "u2",
    },
  });
};

// D4 mirror: two accounts sharing providerId "u1" but differing on the FIRST
// referenced column (provider github vs gitlab). m2 references gitlab, so a
// nested write correlated to acc-1 (github/u1) rejects ONLY because the
// accProvider→provider column is correlated; a probe that kept providerId alone
// would wrongly reach m2 (both share providerId="u1"). Together with
// `sameProviderTwoAccounts` this proves BOTH D4 columns per-field (the compound
// FK's first column is already pinned by `compoundAuthorPosts`).
const sameProviderIdTwoAccounts = async (
  client: ReturnType<typeof makeClient>
) => {
  await client.account.create({
    data: { id: "acc-1", provider: "github", providerId: "u1" },
  });
  await client.account.create({
    data: { id: "acc-2", provider: "gitlab", providerId: "u1" },
  });
  await client.membership.create({
    data: {
      id: "m1",
      role: "member",
      accProvider: "github",
      accProviderId: "u1",
    },
  });
  await client.membership.create({
    data: {
      id: "m2",
      role: "member",
      accProvider: "gitlab",
      accProviderId: "u1",
    },
  });
};

const scenarios: Scenario[] = [
  {
    name: "update by compound id targets only that tenant's row",
    seed: twoTenants,
    act: (c) =>
      c.author!.update!({
        where: { tenantId_id: { tenantId: "t1", id: "a1" } },
        data: { name: "Alice Updated" },
      }),
  },
  {
    name: "delete by compound id targets only that tenant's row",
    seed: twoTenants,
    act: (c) =>
      c.author!.delete!({
        where: { tenantId_id: { tenantId: "t1", id: "a1" } },
        select: { tenantId: true, id: true, name: true },
      }),
  },
  {
    name: "update of a missing compound id rejects",
    expectReject: true,
    seed: twoTenants,
    act: (c) =>
      c.author!.update!({
        where: { tenantId_id: { tenantId: "t3", id: "a1" } },
        data: { name: "nope" },
      }),
  },
  {
    name: "upsert by compound id creates the missing row",
    act: (c) =>
      c.author!.upsert!({
        where: { tenantId_id: { tenantId: "t1", id: "a1" } },
        create: { tenantId: "t1", id: "a1", name: "Created" },
        update: { name: "Updated" },
      }),
  },
  {
    name: "upsert by compound id updates the present row",
    seed: (c) =>
      c.author.create({ data: { tenantId: "t1", id: "a1", name: "Original" } }),
    act: (c) =>
      c.author!.upsert!({
        where: { tenantId_id: { tenantId: "t1", id: "a1" } },
        create: { tenantId: "t1", id: "a1", name: "Created" },
        update: { name: "Updated" },
      }),
  },
  {
    name: "nested connect writes every compound FK column from the compound parent",
    seed: async (c) => {
      await twoTenants(c);
      await c.post.create({
        data: { id: "p1", title: "Orphan", tenantId: null, authorId: null },
      });
    },
    act: (c) =>
      c.author!.update!({
        where: { tenantId_id: { tenantId: "t1", id: "a1" } },
        data: { posts: { connect: { id: "p1" } } },
      }),
  },
  {
    name: "nested connect from the other tenant writes that tenant's compound FK",
    seed: async (c) => {
      await twoTenants(c);
      await c.post.create({
        data: { id: "p1", title: "Orphan", tenantId: null, authorId: null },
      });
    },
    act: (c) =>
      c.author!.update!({
        where: { tenantId_id: { tenantId: "t2", id: "a1" } },
        data: { posts: { connect: { id: "p1" } } },
      }),
  },
  {
    name: "nested disconnect nulls every compound FK column, parent-correlated",
    seed: async (c) => {
      await c.author.create({
        data: {
          tenantId: "t1",
          id: "a1",
          name: "Alice",
          posts: { create: { id: "p1", title: "Hers" } },
        },
      });
    },
    act: (c) =>
      c.author!.update!({
        where: { tenantId_id: { tenantId: "t1", id: "a1" } },
        data: { posts: { disconnect: { id: "p1" } } },
      }),
  },
  {
    name: "account update by compound unique (non-PK) targets the right row",
    seed: async (c) => {
      await c.account.create({
        data: { id: "acc-1", provider: "github", providerId: "u1" },
      });
      await c.account.create({
        data: { id: "acc-2", provider: "gitlab", providerId: "u1" },
      });
    },
    act: (c) =>
      c.account!.update!({
        where: {
          provider_providerId: { provider: "github", providerId: "u1" },
        },
        data: { providerId: "u1-renamed" },
      }),
  },
  // --- P4.5: nested write family on a compound-FK child (post [tenantId,
  // authorId] → author [tenantId, id]). Each is a per-field generalization of a
  // shape P3 observed to Direct. The two-tenants seed is the correctness pin: a
  // single-column correlation would touch the other tenant's rows.
  {
    name: "nested update on a compound-FK child correlates per-field",
    seed: compoundAuthorPosts,
    act: (c) =>
      c.author!.update!({
        where: { tenantId_id: { tenantId: "t1", id: "a1" } },
        data: {
          posts: { update: { where: { id: "p1" }, data: { title: "P1 upd" } } },
        },
      }),
  },
  {
    // The two authors differ on the FIRST referenced column (tenantId); this
    // pins that column. The SECOND-column companion is below.
    name: "nested update of another tenant's post rejects (first FK column correlated)",
    expectReject: true,
    seed: compoundAuthorPosts,
    act: (c) =>
      c.author!.update!({
        where: { tenantId_id: { tenantId: "t1", id: "a1" } },
        data: {
          posts: { update: { where: { id: "p3" }, data: { title: "nope" } } },
        },
      }),
  },
  {
    // Companion pinning the SECOND FK column: both authors share tenantId="t1",
    // so a probe that dropped the authorId→id correlation (`fkFields.slice(0, 1)`)
    // would reach p2 (a2's post) and wrongly succeed. Full per-field rejects.
    name: "nested update of a same-tenant sibling's post rejects (second FK column correlated)",
    expectReject: true,
    seed: sameTenantTwoAuthors,
    act: (c) =>
      c.author!.update!({
        where: { tenantId_id: { tenantId: "t1", id: "a1" } },
        data: {
          posts: { update: { where: { id: "p2" }, data: { title: "nope" } } },
        },
      }),
  },
  {
    name: "nested delete on a compound-FK child correlates per-field",
    seed: compoundAuthorPosts,
    act: (c) =>
      c.author!.update!({
        where: { tenantId_id: { tenantId: "t1", id: "a1" } },
        data: { posts: { delete: { id: "p1" } } },
      }),
  },
  {
    name: "nested deleteMany on a compound-FK child, filter correlated",
    seed: compoundAuthorPosts,
    act: (c) =>
      c.author!.update!({
        where: { tenantId_id: { tenantId: "t1", id: "a1" } },
        data: { posts: { deleteMany: { title: { contains: "P" } } } },
      }),
  },
  {
    name: "nested updateMany on a compound-FK child, filter correlated",
    seed: compoundAuthorPosts,
    act: (c) =>
      c.author!.update!({
        where: { tenantId_id: { tenantId: "t1", id: "a1" } },
        data: { posts: { updateMany: { where: {}, data: { title: "bulk" } } } },
      }),
  },
  {
    name: "nested set on a compound-FK child (nullable) reparents per-field",
    seed: compoundAuthorPosts,
    act: (c) =>
      c.author!.update!({
        where: { tenantId_id: { tenantId: "t1", id: "a1" } },
        data: { posts: { set: { id: "p2" } } },
      }),
  },
  {
    // Claims a post owned by a *same-tenant sibling author*: the reparent write
    // must set every FK column — writing only tenantId (already "t1") would be
    // a silent no-op leaving the post with a2. This is the per-field WRITE-side
    // witness the no-op p2 scenario above cannot provide.
    name: "nested set claims a same-tenant post from another author per-field",
    seed: async (client) => {
      await compoundAuthorPosts(client);
      await client.author.create({
        data: {
          tenantId: "t1",
          id: "a2",
          name: "Bob",
          posts: { create: { id: "p9", title: "Bob's post" } },
        },
      });
    },
    act: (c) =>
      c.author!.update!({
        where: { tenantId_id: { tenantId: "t1", id: "a1" } },
        data: { posts: { set: [{ id: "p9" }] } },
      }),
  },
  {
    name: "nested upsert on a compound-FK child updates the correlated row",
    seed: compoundAuthorPosts,
    act: (c) =>
      c.author!.update!({
        where: { tenantId_id: { tenantId: "t1", id: "a1" } },
        data: {
          posts: {
            upsert: {
              where: { id: "p1" },
              create: { id: "p1", title: "created" },
              update: { title: "upserted" },
            },
          },
        },
      }),
  },
  {
    name: "nested upsert on a compound-FK child creates with the compound FK",
    seed: compoundAuthorPosts,
    act: (c) =>
      c.author!.update!({
        where: { tenantId_id: { tenantId: "t1", id: "a1" } },
        data: {
          posts: {
            upsert: {
              where: { id: "p9" },
              create: { id: "p9", title: "new" },
              update: { title: "nope" },
            },
          },
        },
      }),
  },
  {
    name: "nested connectOrCreate on a compound-FK child connects an orphan",
    seed: async (c) => {
      await compoundAuthorPosts(c);
      await c.post.create({
        data: { id: "p5", title: "Orphan", tenantId: null, authorId: null },
      });
    },
    act: (c) =>
      c.author!.update!({
        where: { tenantId_id: { tenantId: "t1", id: "a1" } },
        data: {
          posts: {
            connectOrCreate: {
              where: { id: "p5" },
              create: { id: "p5", title: "x" },
            },
          },
        },
      }),
  },
  {
    name: "nested connectOrCreate on a compound-FK child creates the missing row",
    seed: compoundAuthorPosts,
    act: (c) =>
      c.author!.update!({
        where: { tenantId_id: { tenantId: "t1", id: "a1" } },
        data: {
          posts: {
            connectOrCreate: {
              where: { id: "p9" },
              create: { id: "p9", title: "new" },
            },
          },
        },
      }),
  },
  // --- P4.5: D4-style — a child compound FK referencing a NON-PK unique of the
  // parent (membership [accProvider, accProviderId] → account [provider,
  // providerId]). The parent is located by its `id` PK, so its non-PK referenced
  // columns must be selected by the locate read for the per-field edge to resolve.
  {
    name: "nested connect on a D4 child writes the parent's non-PK unique",
    seed: d4AccountMemberships,
    act: (c) =>
      c.account!.update!({
        where: { id: "acc-1" },
        data: { memberships: { connect: { id: "m-orphan" } } },
      }),
  },
  {
    name: "nested disconnect on a D4 child nulls the FK, parent-correlated",
    seed: d4AccountMemberships,
    act: (c) =>
      c.account!.update!({
        where: { id: "acc-1" },
        data: { memberships: { disconnect: { id: "m1" } } },
      }),
  },
  {
    name: "nested update on a D4 child correlates by the non-PK referenced columns",
    seed: d4AccountMemberships,
    act: (c) =>
      c.account!.update!({
        where: { id: "acc-1" },
        data: {
          memberships: {
            update: { where: { id: "m1" }, data: { role: "admin" } },
          },
        },
      }),
  },
  {
    // acc-1 (github/u1) and acc-2 (gitlab/u2) differ on BOTH referenced columns,
    // so this is only a foreign-child smoke — it proves neither column is
    // individually load-bearing (either alone suffices to reject). The two
    // single-column companions below carry the per-field claim.
    name: "nested update of another account's D4 child rejects (foreign non-PK child)",
    expectReject: true,
    seed: d4AccountMemberships,
    act: (c) =>
      c.account!.update!({
        where: { id: "acc-1" },
        data: {
          memberships: {
            update: { where: { id: "m2" }, data: { role: "nope" } },
          },
        },
      }),
  },
  {
    // Pins the SECOND referenced column (providerId): both accounts share
    // provider="github", so a probe that dropped the accProviderId→providerId
    // correlation (`fkFields.slice(0, 1)`) would reach m2 (acc-2's member) and
    // wrongly succeed. Full per-field rejects.
    name: "nested update of a same-provider account's D4 child rejects (second referenced column correlated)",
    expectReject: true,
    seed: sameProviderTwoAccounts,
    act: (c) =>
      c.account!.update!({
        where: { id: "acc-1" },
        data: {
          memberships: {
            update: { where: { id: "m2" }, data: { role: "nope" } },
          },
        },
      }),
  },
  {
    // Pins the FIRST referenced column (provider): both accounts share
    // providerId="u1", so a probe that dropped the accProvider→provider
    // correlation would reach m2 (acc-2's member) and wrongly succeed.
    name: "nested update of a same-providerId account's D4 child rejects (first referenced column correlated)",
    expectReject: true,
    seed: sameProviderIdTwoAccounts,
    act: (c) =>
      c.account!.update!({
        where: { id: "acc-1" },
        data: {
          memberships: {
            update: { where: { id: "m2" }, data: { role: "nope" } },
          },
        },
      }),
  },
];

describe("write boundary compound-key dual-run oracle (Direct vs Observed)", () => {
  const getFamily = usePGliteSchemaFamily(compoundKeyBehaviorSchema);
  for (const scenario of scenarios) {
    test(scenario.name, { timeout: 30_000 }, async () => {
      const family = getFamily();
      const direct = await runArm(family, "direct", scenario);
      const tx = await runArm(family, "observed-tx", scenario);
      const batch = await runArm(family, "observed-batch", scenario);

      expect(tx.routedToObserved).toBe(true);
      expect(batch.routedToObserved).toBe(true);

      expect(tx.error).toEqual(direct.error);
      expect(batch.error).toEqual(direct.error);
      expect(Boolean(direct.error)).toBe(scenario.expectReject === true);

      if (!scenario.expectReject) {
        expect(tx.result).toEqual(direct.result);
        expect(batch.result).toEqual(direct.result);
      }

      expect(tx.state).toEqual(direct.state);
      expect(batch.state).toEqual(direct.state);
    });
  }
});
