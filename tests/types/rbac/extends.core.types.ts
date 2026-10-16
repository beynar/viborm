import { MemoryCache } from "@cache/drivers/memory";
import { cache } from "@cache/extension";
import { createClient } from "@src/drivers/sqlite3";
import type { ClientTypeState, VibORMClient, VibORMConfig } from "@src/index";
import {
  type ExtendedClient,
  type ExtendedOperationResult,
  s,
} from "@src/index";
import { owner, rbac } from "@src/rbac";
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
          edit: { AND: [owner("ownerId"), { ownerId: { actor: "userId" } }] },
        },
      },
    })
  );

  expectTypeOf(db.$driver).toEqualTypeOf<typeof base.$driver>();
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
