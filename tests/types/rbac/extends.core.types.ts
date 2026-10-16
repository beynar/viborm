import { MemoryCache } from "@cache/drivers/memory";
import { cache } from "@cache/extension";
import { createClient } from "@src/drivers/sqlite3";
import type { ClientTypeState, VibORMClient, VibORMConfig } from "@src/index";
import {
  type ExtendedClient,
  type ExtendedOperationResult,
  s,
} from "@src/index";
import { type PolicyModel, rbac } from "@src/rbac";
import { softDelete } from "@src/soft-delete";
import { v } from "@src/validation";
import { expectTypeOf } from "vitest";

export function checkRbacExtensionTypes() {
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
    rbac({
      actor,
      models: {
        user: { view: {} },
        post: {
          actions: { view: [], edit: [] },
          view: { owner: { is: { id: { actor: "userId" } } } },
          edit: {
            AND: [{ ownerId: { actor: "userId" } }, { id: { not: "" } }],
          },
        },
      },
    })
  );

  expectTypeOf(db.$driver).toEqualTypeOf<typeof base.$driver>();
  const grouped = base.$extends(
    rbac({
      actor,
      levels: ["view", "edit", "full"],
      models: {
        post: {
          "view, edit": (action, model) => {
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
  expectTypeOf(grouped.post.can("edit", { id: "p" })).toEqualTypeOf<
    Promise<boolean>
  >();
  grouped.post.findMany({ as: "view", select: { $access: true } });
  // @ts-expect-error - a group is declaration syntax, not an action
  grouped.post.can("view, edit", { id: "p" });
  // @ts-expect-error - modes also name individual actions
  grouped.post.findMany({ as: "view, edit" });
  base.$extends(
    // @ts-expect-error - grouped callbacks preserve declaration admission
    rbac({
      actor,
      models: { post: { "view, arms": (action) => ({ id: action }) } },
    })
  );
  const dynamic = base.$extends(
    rbac({
      actor,
      levels: ["view", "edit"],
      models: {
        post: {
          edit: (action, model) => {
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
  expectTypeOf(dynamic.post.can("edit", { id: "p" })).toEqualTypeOf<
    Promise<boolean>
  >();
  base.$extends(
    // @ts-expect-error - the contextual factory also rejects the retired grant key
    rbac({ actor, models: { post: { arms: {}, view: {} } } })
  );
  // @ts-expect-error - dynamic rules do not erase the declared action names
  dynamic.post.can("publish", { id: "p" });
  base.$extends(
    // @ts-expect-error - a wrong model is rejected beside a real dynamic model
    rbac({
      actor,
      models: {
        post: { edit: (action) => ({ id: action }) },
        ghost: { view: {} },
      },
    })
  );
  base.$extends(
    // @ts-expect-error - field admission survives context-sensitive callbacks
    rbac({
      actor,
      models: {
        post: {
          edit: (action) => ({ id: action }),
          fields: { ownerId: { write: "edit" }, wrong: { write: "edit" } },
        },
      },
    })
  );
  base.$extends(
    // @ts-expect-error - create admission survives context-sensitive callbacks
    rbac({
      actor,
      models: {
        post: {
          edit: (action) => ({ id: action }),
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

  const held = rbac({ actor, models: { post: { view: {} } } });
  const tombstones = softDelete({
    models: { post: { deletedAt: "deletedAt" } },
  });
  const combined = base
    .$extends(tombstones.rows)
    .$extends(held)
    .$extends(tombstones.methods);
  const boundCombined = combined.$as({ userId: "u", organizationId: "o" });
  boundCombined.post.can("view", { id: "p" });
  boundCombined.post.restore({ where: { id: "p" } });
  const continued = combined.$extends({ name: "after-composition" });
  continued.post.can("view", { id: "p" });
  continued.post.restore({ where: { id: "p" } });
  expectTypeOf(combined.post.can("view", { id: "p" })).toEqualTypeOf<
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
  continuedTenant.post.can("view", { id: "p" });
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
  splitPolicy.post.can("view", { id: "p" });
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
  const foreign = rbac({ actor, models: { ghost: { view: {} } } });
  // @ts-expect-error - held factories cannot apply to a missing model
  base.$extends(foreign);
  // @ts-expect-error - legacy factory calls enforce the same schema contract
  foreign(base);
  type HeldTuple = ExtendedClient<typeof tenantBase, [typeof held]>;
  expectTypeOf<HeldTuple>().toEqualTypeOf<never>();

  expectTypeOf<keyof typeof db.$schema>().toEqualTypeOf<"user" | "post">();
  db.$as({ userId: "u", organizationId: "o" });
  expectTypeOf(db.post.can("edit", { id: "p" })).toEqualTypeOf<
    Promise<boolean>
  >();
  // @ts-expect-error - exact declared actions survive contextual factory inference
  db.post.can("publish", { id: "p" });
  // @ts-expect-error - every required actor field is retained
  db.$as({ userId: "u" });
  // @ts-expect-error - a model outside the receiving schema is refused
  base.$extends(rbac({ actor, models: { ghost: { view: {} } } }));
  base.$extends(
    // @ts-expect-error - actor references name the actor schema's paths
    rbac({ actor, models: { post: { view: { ownerId: { actor: "usrId" } } } } })
  );
  base.$extends(
    // @ts-expect-error - an operation cannot name an undeclared action
    rbac({
      actor,
      models: { post: { view: {}, operations: { delete: "remove" } } },
    })
  );
}
