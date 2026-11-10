import { MemoryCache } from "@cache/drivers/memory";
import { cache } from "@cache/extension";
import { createClient } from "@src/drivers/sqlite3";
import type {
  ClientTypeState,
  ExtensionState,
  VibORMClient,
  VibORMConfig,
} from "@src/index";
import {
  type ExtendedClient,
  type ExtendedOperationResult,
  s,
} from "@src/index";
import { type PolicyModel, permissions } from "@src/permissions";
import { softDelete } from "@src/soft-delete";
import { v } from "@src/validation";
import { expectTypeOf } from "vitest";

export function checkPermissionsExtensionTypes() {
  const user = s.model({ id: s.string().id(), name: s.string() });
  const post = s.model({
    id: s.string().id(),
    ownerId: s.string(),
    deletedAt: s.dateTime().nullable(),
    owner: s
      .toOne(() => user)
      .fields("ownerId")
      .references("id"),
  });
  const actor = v.object({ userId: v.string(), organizationId: v.string() });
  const base = createClient({ schema: { user, post }, dataDir: ":memory:" });
  const handwritten: VibORMClient<
    VibORMConfig<{ user: typeof user; post: typeof post }>
  > = base;
  const cached: typeof base = base.$extends(
    cache({ driver: new MemoryCache() })
  );
  expectTypeOf(handwritten.$schema).toEqualTypeOf<typeof base.$schema>();
  expectTypeOf(cached.$driver).toEqualTypeOf<typeof base.$driver>();
  const db = base.$extends(
    permissions({
      actor,
      models: {
        user: { read: {} },
        post: {
          actions: { read: [], update: [] },
          read: { owner: { is: { id: { actor: "userId" } } } },
          update: {
            AND: [{ ownerId: { actor: "userId" } }, { id: { not: "" } }],
          },
        },
      },
    })
  );

  expectTypeOf(db.$driver).toEqualTypeOf<typeof base.$driver>();
  const grouped = base.$extends(
    permissions({
      actor,
      levels: ["read", "update", "full"],
      models: {
        post: {
          "read, update": (action, model) => {
            expectTypeOf(action).toEqualTypeOf<string>();
            expectTypeOf(model).toEqualTypeOf<PolicyModel>();
            expectTypeOf<keyof PolicyModel>().toEqualTypeOf<
              "name" | "actions"
            >();
            // @ts-expect-error - implication helpers are not public policy vocabulary
            model.above(action);
            // @ts-expect-error - relation callbacks receive their own model metadata
            model.related("owner");
            // @ts-expect-error - inheritance configuration is not callback metadata
            model.levels;
            // @ts-expect-error - no implicit level-versus-graph flag
            model.leveled;
            return { ownerId: { actor: "userId" } };
          },
        },
      },
    })
  );
  expectTypeOf(grouped.post.can("update", { id: "p" })).toEqualTypeOf<
    Promise<boolean>
  >();
  grouped.post.findMany({ as: "read", select: { $access: true } });
  // @ts-expect-error - a group is declaration syntax, not an action
  grouped.post.can("read, update", { id: "p" });
  // @ts-expect-error - modes also name individual actions
  grouped.post.findMany({ as: "read, update" });
  base.$extends(
    // @ts-expect-error - grouped callbacks preserve declaration admission
    permissions({
      actor,
      models: { post: { "read, arms": (action) => ({ id: action }) } },
    })
  );
  const dynamic = base.$extends(
    permissions({
      actor,
      levels: ["read", "update"],
      models: {
        post: {
          update: (action, model) => {
            expectTypeOf(action).toEqualTypeOf<string>();
            expectTypeOf(model).toEqualTypeOf<PolicyModel>();
            return {
              OR: [
                (requested, current) => {
                  expectTypeOf(requested).toEqualTypeOf<string>();
                  expectTypeOf(current).toEqualTypeOf<PolicyModel>();
                  return { ownerId: { actor: "userId" } };
                },
                {
                  owner: {
                    is: (_requested, related) => ({ name: related.name }),
                  },
                },
              ],
            };
          },
        },
      },
    })
  );
  expectTypeOf(dynamic.post.can("update", { id: "p" })).toEqualTypeOf<
    Promise<boolean>
  >();
  base.$extends(
    // @ts-expect-error - the contextual factory also rejects the retired grant key
    permissions({ actor, models: { post: { arms: {}, read: {} } } })
  );
  // @ts-expect-error - dynamic rules do not erase the declared action names
  dynamic.post.can("publish", { id: "p" });
  base.$extends(
    // @ts-expect-error - a wrong model is rejected beside a real dynamic model
    permissions({
      actor,
      models: {
        post: { update: (action) => ({ id: action }) },
        ghost: { read: {} },
      },
    })
  );
  base.$extends(
    // @ts-expect-error - field admission survives context-sensitive callbacks
    permissions({
      actor,
      models: {
        post: {
          update: (action) => ({ id: action }),
          fields: { ownerId: { write: "update" }, wrong: { write: "update" } },
        },
      },
    })
  );
  base.$extends(
    // @ts-expect-error - create admission survives context-sensitive callbacks
    permissions({
      actor,
      models: {
        post: {
          update: (action) => ({ id: action }),
          create: { ownerId: { actor: "userId" }, wrong: 1 },
        },
      },
    })
  );
  const nonClient = {};
  expectTypeOf<ExtendedClient<typeof nonClient, []>>().toEqualTypeOf<never>();
  expectTypeOf<
    ExtendedOperationResult<
      typeof nonClient,
      "post",
      "findMany",
      typeof nonClient
    >
  >().toEqualTypeOf<never>();

  const held = permissions({ actor, models: { post: { read: {} } } });
  const tombstones = softDelete({
    models: { post: { deletedAt: "deletedAt" } },
  });
  const combined = base
    .$extends(tombstones.rows)
    .$extends(held)
    .$extends(tombstones.methods);
  const boundCombined = combined.$as({ userId: "u", organizationId: "o" });
  boundCombined.post.can("read", { id: "p" });
  boundCombined.post.restore({ where: { id: "p" } });
  const continued = combined.$extends({ name: "after-composition" });
  continued.post.can("read", { id: "p" });
  continued.post.restore({ where: { id: "p" } });
  expectTypeOf(combined.post.can("read", { id: "p" })).toEqualTypeOf<
    Promise<boolean>
  >();
  const restoration = combined.post.restore({
    where: { id: "p" },
    select: { id: true },
  });
  expectTypeOf<Awaited<typeof restoration>>().toEqualTypeOf<{ id: string }>();
  // @ts-expect-error - composition retains the policy's action vocabulary
  combined.post.can("publish", { id: "p" });

  const tenantBase = base.$extends({
    name: "tenant",
    controls: { tenant: { schema: v.string(), required: true, on: "reads" } },
  });
  const directSoft = tombstones(tenantBase);
  directSoft.post.findMany({ tenant: "acme" });
  expectTypeOf(directSoft.$driver).toEqualTypeOf<typeof base.$driver>();
  const softOnly = tenantBase.$extends(tombstones);
  softOnly.post.findMany({ tenant: "acme" });
  softOnly.post.restore({ where: { id: "p" } });
  expectTypeOf(softOnly.$driver).toEqualTypeOf<typeof base.$driver>();
  // @ts-expect-error - whole-extension factories preserve prior controls
  softOnly.post.findMany({ tenant: 1 });
  const tenantCombined = tenantBase
    .$extends(tombstones.rows)
    .$extends(held)
    .$extends(tombstones.methods);
  expectTypeOf(tenantCombined.$driver).toEqualTypeOf<typeof base.$driver>();
  const continuedTenant = tenantCombined.$extends({
    name: "after-tenant-composition",
  });
  continuedTenant.post.can("read", { id: "p" });
  continuedTenant.post.restore({ where: { id: "p" } });
  continuedTenant.post.findMany({ tenant: "acme" });
  // @ts-expect-error - subsequent views keep the control value type
  continuedTenant.post.findMany({ tenant: 1 });
  // @ts-expect-error - subsequent views keep the control placement
  continuedTenant.post.deleteMany({ tenant: "acme" });
  tenantCombined.post.findMany({ tenant: "acme" });
  // @ts-expect-error - composed factories preserve the prior control value type
  tenantCombined.post.findMany({ tenant: 1 });
  // @ts-expect-error - composed factories preserve prior control placement
  tenantCombined.post.deleteMany({ tenant: "acme" });
  const governed = tenantBase.$extends(held);
  const legacy = held(tenantBase);
  const splitPolicy = tenantBase.$extends(held.rows).$extends(held.methods);
  splitPolicy.post.findMany({ tenant: "acme" });
  splitPolicy.post.can("read", { id: "p" });
  // @ts-expect-error - split policy factories retain the prior control schema
  splitPolicy.post.findMany({ tenant: 1 });
  type Hint<T> =
    T extends ClientTypeState<infer C, infer X> ? ClientTypeState<C, X> : never;
  const withTag = base.$extends({
    name: "tag",
    client: () => ({ $tag: () => "tag" }),
  });
  const fake: Hint<typeof withTag> & Pick<typeof base, "$schema" | "$extends"> =
    base;
  expectTypeOf(held(fake)).toEqualTypeOf<never>();
  expectTypeOf<ExtendedClient<typeof fake, []>>().toEqualTypeOf<never>();
  expectTypeOf<
    ExtendedOperationResult<typeof fake, "post", "findMany", typeof nonClient>
  >().toEqualTypeOf<never>();
  expectTypeOf(tombstones(fake)).toEqualTypeOf<never>();
  expectTypeOf(governed.$driver).toEqualTypeOf<typeof tenantBase.$driver>();
  expectTypeOf(governed).toEqualTypeOf<typeof legacy>();
  governed.post.findMany({ tenant: "acme" });
  // @ts-expect-error - a read-only control remains unavailable on writes
  governed.post.deleteMany({ tenant: "acme" });
  // @ts-expect-error - a prior control retains its schema
  governed.post.findMany({ tenant: 123 });
  // @ts-expect-error - a policy requires a real root client
  held({});
  base.$transaction(async (tx) => {
    // @ts-expect-error - a transaction cannot extend its already-fixed chain
    held(tx);
  });
  const foreign = permissions({ actor, models: { ghost: { read: {} } } });
  // @ts-expect-error - held factories cannot apply to a missing model
  base.$extends(foreign);
  // @ts-expect-error - legacy factory calls enforce the same schema contract
  foreign(base);
  type HeldTuple = ExtendedClient<typeof tenantBase, [typeof held]>;
  expectTypeOf<HeldTuple>().toEqualTypeOf<never>();

  expectTypeOf<keyof typeof db.$schema>().toEqualTypeOf<"user" | "post">();
  db.$as({ userId: "u", organizationId: "o" });
  expectTypeOf(db.post.can("update", { id: "p" })).toEqualTypeOf<
    Promise<boolean>
  >();
  // @ts-expect-error - exact declared actions survive contextual factory inference
  db.post.can("publish", { id: "p" });
  // @ts-expect-error - every required actor field is retained
  db.$as({ userId: "u" });
  // @ts-expect-error - a model outside the receiving schema is refused
  base.$extends(permissions({ actor, models: { ghost: { read: {} } } }));
  base.$extends(
    // @ts-expect-error - actor references name the actor schema's paths
    permissions({
      actor,
      models: { post: { read: { ownerId: { actor: "usrId" } } } },
    })
  );
  base.$extends(
    // @ts-expect-error - an operation cannot name an undeclared action
    permissions({
      actor,
      models: { post: { read: {}, operations: { delete: "remove" } } },
    })
  );
}

export function scopedPrincipalTypes() {
  const post = s.model({ id: s.string().id(), ownerId: s.string() });
  const base = createClient({ schema: { post }, dataDir: ":memory:" });
  const db = base.$extends(
    permissions({
      actor: v.object({
        principalId: v.string(),
        kind: v.union([v.literal("user"), v.literal("service")]),
      }),
      models: {
        post: {
          create: true,
          update: { ownerId: { actor: "principalId" } },
          delete: false,
        },
      },
    })
  );
  const actor = { principalId: "worker", kind: "service" as const };
  db.$as(actor);
  db.$as(actor, []);
  db.$as(actor, ["post.create", "post.read", "post.update", "post.delete"]);
  // @ts-expect-error - no wildcard scopes
  db.$as(actor, ["post.*"]);
  // @ts-expect-error - a scope names an existing model
  db.$as(actor, ["missing.read"]);
  // @ts-expect-error - no invented action
  db.$as(actor, ["post.publish"]);
  // @ts-expect-error - principal context remains validated
  db.$as({ principalId: "worker" }, ["post.read"]);
}

export function cacheAndPolicyComposition() {
  const post = s.model({ id: s.string().id(), ownerId: s.string() });
  const base = createClient({ schema: { post }, dataDir: ":memory:" });
  const cached = base.$extends(cache({ driver: new MemoryCache() }));
  // @ts-expect-error - plain cached models have no evidence projection
  cached.$withCache().post.findMany({ select: { $access: true } });
  // @ts-expect-error - cache views retain ordinary scalar-key admission
  cached.$withCache().post.findMany({ select: { missing: true } });
  const policy = permissions({
    actor: v.object({ userId: v.string() }),
    cache: "allow",
    models: { post: { read: { ownerId: { actor: "userId" } }, update: true } },
  });
  const inline = cached.$extends(
    permissions({
      actor: v.object({ userId: v.string() }),
      cache: "allow",
      models: {
        post: { read: { ownerId: { actor: "userId" } }, update: true },
      },
    })
  );
  const cachedView = inline
    .$as({ userId: "alice" }, ["post.read"])
    .$withCache();
  const evidence = cachedView.post.findMany({ include: { $access: true } });
  expectTypeOf(evidence).toEqualTypeOf<
    Promise<
      {
        id: string;
        ownerId: string;
        readonly $access: { readonly read: boolean; readonly update: boolean };
      }[]
    >
  >();
  // @ts-expect-error - cache reads return Promises, not batchable pending operations
  inline.$transaction([evidence]);
  // @ts-expect-error - a cached view does not publish mutation operations
  cachedView.post.update({ where: { id: "p" }, data: { ownerId: "bob" } });
  // @ts-expect-error - cached views do not publish arbitrary extension methods
  cachedView.post.can("read", { id: "p" });
  // @ts-expect-error - cached evidence retains exact declared permission names
  cachedView.post.findMany({ include: { $access: ["publish"] } });
  const direct = policy(cached);
  const held = cached.$extends(policy);
  const rows = policy.rows(cached);
  const cacheAfter = base
    .$extends(policy)
    .$extends(cache({ driver: new MemoryCache() }));
  direct
    .$as({ userId: "alice" }, ["post.read"])
    .$withCache()
    .post.findMany({ include: { $access: true } });
  held
    .$as({ userId: "alice" }, ["post.update"])
    .$withCache()
    .post.findMany({ include: { $access: true } });
  rows.$as({ userId: "alice" }, []).$withCache().post.findMany();
  cacheAfter
    .$as({ userId: "alice" }, ["post.read"])
    .$withCache()
    .post.findMany({ include: { $access: true } });
}

export function rowDefinitionOrdering() {
  const post = s.model({ id: s.string().id() });
  const base = createClient({ schema: { post }, dataDir: ":memory:" });
  // A factory typed against the client it extends reads its results.
  const consumer = base.$extends({
    name: "consumer",
    client: (scope) => ({ $ready: () => scope.post !== undefined }),
  });
  const rowsOnly = {
    name: "visibility",
    rows: {
      control: "visibility",
      default: "all",
      models: { post: { all: {} } },
    },
  } as const;
  base.$extends(rowsOnly);
  // One that reads nothing typed is no result consumer.
  base
    .$extends({ name: "blind", client: () => ({ $ready: () => true }) })
    .$extends(rowsOnly);
  // @ts-expect-error - result consumers precede no later row-filter definition
  consumer.$extends(rowsOnly);
  consumer.$extends({
    name: "more-methods",
    client: () => ({ $stillReady: () => true }),
  });
  consumer.$extends({
    name: "control",
    controls: { tag: { schema: v.string() } },
  });
}

export function thirdPartyStepsOverFactories() {
  const user = s.model({ id: s.string().id(), name: s.string() });
  const page = s.model({
    id: s.string().id(),
    ownerId: s.string(),
    deletedAt: s.dateTime().nullable(),
    owner: s
      .toOne(() => user)
      .fields("ownerId")
      .references("id"),
  });
  const base = createClient({ schema: { user, page }, dataDir: ":memory:" });
  const held = permissions({
    actor: v.object({ userId: v.string() }),
    models: {
      user: { read: {} },
      page: { read: { ownerId: { actor: "userId" } } },
    },
  });
  const tombstones = softDelete({
    models: { page: { deletedAt: "deletedAt" } },
  });
  // A step generic over a whole client, as 1.2.4 documented it, infers C and
  // X from a step's result: each step returns the client type itself.
  const step = <C extends VibORMConfig, X extends ExtensionState>(
    client: VibORMClient<C, X>
  ) => client;
  step(held.methods(held.rows(base))).page.can("read", { id: "p" });
  step(tombstones(base)).page.restore({ where: { id: "p" } });
  step(
    held.methods(tombstones.methods(held.rows(tombstones.rows(base))))
  ).page.restore({ where: { id: "p" } });
  // @ts-expect-error - the step keeps the policy's action vocabulary
  step(held.methods(held.rows(base))).page.can("publish", { id: "p" });
}
