/**
 * `move`, `restore` and `purge` type a selected `$access` as the operation
 * they delegate to types it (1.10 review, Sol A F2): the runtime returned it
 * and the result type dropped it, whichever order the four extensions were
 * applied in.
 */
import { createClient } from "@src/drivers/sqlite3";
import { s } from "@src/index";
import { on } from "@src/on";
import { ordering } from "@src/ordering";
import { permissions } from "@src/permissions";
import { softDelete } from "@src/soft-delete";
import { v } from "@src/validation";
import { expectTypeOf } from "vitest";

const owner = s.model({ id: s.string().id(), name: s.string() });
const task = s.model({
  id: s.string().id(),
  tenant: s.string(),
  rank: s.string(),
  title: s.string(),
  deletedAt: s.dateTime().nullable(),
  ownerId: s.string(),
  owner: s
    .toOne(() => owner)
    .fields("ownerId")
    .references("id"),
});
const base = createClient({ schema: { owner, task }, dataDir: ":memory:" });
const policy = permissions({
  actor: v.object({ tenant: v.string() }),
  models: {
    owner: { read: true },
    task: {
      read: { tenant: { actor: "tenant" } },
      create: true,
      update: true,
      delete: true,
    },
  },
});
const tombstones = softDelete({ models: { task: { deletedAt: "deletedAt" } } });
const ranks = ordering({ models: { task: { key: "rank" } } });
const hooks = on({ task: { update: () => undefined } });

type TaskAccess = {
  readonly read: boolean;
  readonly create: boolean;
  readonly update: boolean;
  readonly delete: boolean;
};

// The policy before the methods' extensions, and after them: a method reads
// the key from the delegate it is called on, whichever step declared it.
const policyLast = base
  .$extends(hooks)
  .$extends(ranks)
  .$extends(tombstones)
  .$extends(policy)
  .$as({ tenant: "a" });
const policyFirst = base.$extends(policy).$extends(ranks).$as({ tenant: "a" });

// One call per client: a list of both would compare the two clients.
export async function methodsCarryEvidence() {
  const movedBefore = await policyFirst.task.move({
    where: { id: "a" },
    key: "15",
    select: { id: true, $access: true },
  });
  expectTypeOf(movedBefore).toEqualTypeOf<{
    id: string;
    readonly $access: TaskAccess;
  }>();
  const movedAfter = await policyLast.task.move({
    where: { id: "a" },
    after: { id: "b" },
    select: { id: true, $access: true },
  });
  expectTypeOf(movedAfter).toEqualTypeOf<{
    id: string;
    readonly $access: TaskAccess;
  }>();
  const restored = await policyLast.task.restore({
    where: { id: "a" },
    select: { id: true, $access: ["update"] },
  });
  expectTypeOf(restored.$access).toEqualTypeOf<{ readonly update: boolean }>();
  const purged = await policyLast.task.purge({
    where: { id: "a" },
    include: { $access: true, owner: { select: { $access: true } } },
  });
  expectTypeOf(purged.$access).toEqualTypeOf<TaskAccess>();
  expectTypeOf(purged.owner?.$access).toEqualTypeOf<
    { readonly read: boolean } | undefined
  >();
  expectTypeOf(purged.title).toEqualTypeOf<string>();
}

export async function methodsWithoutTheKeyAreUnchanged() {
  const moved = await policyFirst.task.move({
    where: { id: "a" },
    first: true,
    select: { id: true },
  });
  expectTypeOf(moved).toEqualTypeOf<{ id: string }>();
  const restored = await policyLast.task.restore({ where: { id: "a" } });
  // @ts-expect-error - a key the call did not spell is absent
  restored.$access;
  const many = await policyLast.task.restoreMany({ where: { title: "t" } });
  expectTypeOf(many).toEqualTypeOf<{ count: number }>();
}
