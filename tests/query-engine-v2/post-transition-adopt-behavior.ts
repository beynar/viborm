import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { push } from "@migrations";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import type { Model } from "@schema/model";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";
import { OperationExecutor } from "../../src/query-engine-v2/OperationExecutor";
import { UpdateOperation } from "../../src/query-engine-v2/UpdateOperation";

/**
 * N5-U1 — the ADOPT family under a non-cascade referenced-primary-key transition,
 * across the whole driver matrix and both substrates.
 *
 * `list.update({ where: { id: 1 }, data: { id: 5, posts: { connect } } })` raised
 * `does not support a nested adopt (connect / connectOrCreate / set / to-many upsert)
 * … while the root update transitions its non-cascade referenced primary key` until
 * this wave. The refusal's stated cause — "an adopt writes a fresh FK on the
 * PRE-transition value, orphaned by the referential action" — was a true statement
 * about the ORDER the parts were emitted in, and about nothing else. Two facts already
 * in hand make the shape ordinary:
 *
 *   1. the OLD slot is proven EMPTY, by the occupied guard the same relation emits
 *      (CLASS IV / T4c) — so no edge is being written onto a value the transition is
 *      about to vacate; and
 *   2. the POST-transition value is a compile-time literal — `getUpdatedPrimaryKeyValue`
 *      over the where-pinned pre-value and the root SET's operand, the same derivation
 *      the T4b transitioned-PK create leaf and the to-one upsert create-arm reroute
 *      have trusted since T4c.
 *
 * So the edge is written against that value, AFTER the root UPDATE that creates it.
 * ORDERING was the whole fix; no expressiveness was added, and the FK never points at
 * the dead id for one statement.
 *
 * What these witnesses check is the FINAL STATE — the parent at its new key, the
 * children attached to that key, and, on every rejection, that NOTHING was written
 * (no orphan on the dead id, no half-applied root). The claim only a statement stream
 * can carry — that the reparent UPDATE literally follows the root UPDATE and binds the
 * post-transition value — is pinned in `post-transition-adopt.test.ts`.
 */
export const postTransitionAdoptSchema = (() => {
  // NULLABLE child FK + setNull: the mainstream non-cascade shape.
  const list = s
    .model({
      id: s.int().id(),
      name: s.string().unique(),
      items: s.oneToMany(() => item),
    })
    .map("n5_pta_lists");
  const item = s
    .model({
      id: s.int().id(),
      label: s.string(),
      listId: s.int().nullable(),
      list: s
        .manyToOne(() => list)
        .fields("listId")
        .references("id")
        .optional()
        .onUpdate("setNull"),
    })
    .map("n5_pta_items");
  // REQUIRED child FK + restrict: `set`'s departing half is a CORRELATED PLANNING READ
  // here (the orphan check), so this pair is what proves the departing half still reads
  // the PRE-transition value while the target half writes the post-transition one.
  const crate = s
    .model({
      id: s.int().id(),
      name: s.string(),
      boxes: s.oneToMany(() => box),
    })
    .map("n5_pta_crates");
  const box = s
    .model({
      id: s.int().id(),
      tag: s.string(),
      crateId: s.int(),
      crate: s
        .manyToOne(() => crate)
        .fields("crateId")
        .references("id")
        .onUpdate("restrict"),
    })
    .map("n5_pta_boxes");
  // The inverse-side one-to-one: the arity-1 case of the same adopt ordering.
  const owner = s
    .model({
      id: s.int().id(),
      name: s.string(),
      badge: s.oneToOne(() => badge).optional(),
    })
    .map("n5_pta_owners");
  const badge = s
    .model({
      id: s.int().id(),
      code: s.string(),
      ownerId: s.int().unique().nullable(),
      owner: s
        .oneToOne(() => owner)
        .fields("ownerId")
        .references("id")
        .optional()
        .onUpdate("setNull"),
    })
    .map("n5_pta_badges");
  return { list, item, crate, box, owner, badge };
})();

hydrateSchemaNames(postTransitionAdoptSchema);

/**
 * Run through the OPERATION rather than the routed client — the seam every update-family
 * behavior suite uses, because a batch-only non-returning driver refuses single-row
 * mutations at the client seam and would make that leg vacuous while looking green.
 */
function makeRunner(driver: AnyDriver, modelName: "list" | "crate" | "owner") {
  const schemas = createSchemaRegistry(postTransitionAdoptSchema);
  const engine = new QueryEngine(
    driver,
    createModelRegistry(postTransitionAdoptSchema, schemas)
  );
  const executor = new OperationExecutor(engine);
  return (args: Record<string, unknown>): Promise<unknown> =>
    executor.execute(
      new UpdateOperation(
        engine,
        postTransitionAdoptSchema[modelName] as unknown as Model<any>,
        args
      ),
      createOperationExecutionContext(
        modelName,
        "update",
        engine.instrumentation
      )
    );
}

function makeStateClient(driver: AnyDriver) {
  return createClient({ schema: postTransitionAdoptSchema, driver });
}
type StateClient = ReturnType<typeof makeStateClient>;

/** One list at id 1 with an EMPTY slot, plus a free item and a decoy item that belongs
 *  to a DIFFERENT list. The decoy holds the lower item id, so any "first row" fallback
 *  or re-consulted selector lands on it and every assertion names ids. */
async function seedLists(client: StateClient): Promise<void> {
  await client.list.create({ data: { id: 1, name: "target" } });
  await client.list.create({ data: { id: 9, name: "decoy" } });
  await client.item.create({ data: { id: 10, label: "decoy", listId: 9 } });
  await client.item.create({ data: { id: 20, label: "free", listId: null } });
}

async function listState(client: StateClient): Promise<unknown> {
  return {
    lists: await client.list.findMany({ orderBy: { id: "asc" } }),
    items: await client.item.findMany({ orderBy: { id: "asc" } }),
  };
}

const UNCORRELATED_TARGET = /target record was not found for this parent/;
const OCCUPIED_SLOT = /current relation is occupied/;
const ABSENT_TARGET = /target record was not found/;

const SEEDED_LIST_STATE = {
  lists: [
    { id: 1, name: "target" },
    { id: 9, name: "decoy" },
  ],
  items: [
    { id: 10, label: "decoy", listId: 9 },
    { id: 20, label: "free", listId: null },
  ],
};

export function runPostTransitionAdoptBehavior(options: {
  readonly name: string;
  readonly createDriver: () => AnyDriver;
  readonly createStateDriver?: () => AnyDriver;
}): void {
  describe(`${options.name} post-transition adopt (N5-U1)`, () => {
    const setup = async (modelName: "list" | "crate" | "owner" = "list") => {
      const driver = options.createDriver();
      const stateDriver = options.createStateDriver?.() ?? driver;
      const client = makeStateClient(stateDriver);
      const update = makeRunner(driver, modelName);
      await push(client, { force: true });
      const dispose = async () => {
        await client.$disconnect();
        if (driver !== stateDriver) await driver.disconnect();
      };
      return { client, update, dispose };
    };

    test(
      "connect: the adopted child lands on the POST-transition key, not the dead one",
      { timeout: 30_000 },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedLists(client);
          await update({
            where: { id: 1 },
            data: { id: 5, items: { connect: { id: 20 } } },
          });
          await expect(listState(client)).resolves.toEqual({
            lists: [
              { id: 5, name: "target" },
              { id: 9, name: "decoy" },
            ],
            // The reparent bound 5, the id the root UPDATE had just written. Had it
            // bound the located id 1 (the pre-N5 order), the row would either carry a
            // vacated key or the foreign key would have refused it outright.
            items: [
              { id: 10, label: "decoy", listId: 9 },
              { id: 20, label: "free", listId: 5 },
            ],
          });
        } finally {
          await dispose();
        }
      }
    );

    test(
      "connect under an ARITHMETIC transition rides the same derivation",
      { timeout: 30_000 },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedLists(client);
          // `increment` is a portable primary-key op (`assertPortablePrimaryKeyUpdateInput`
          // gates the SET), so the post-transition key is derived, not spelled: 1 + 4.
          await update({
            where: { id: 1 },
            data: { id: { increment: 4 }, items: { connect: { id: 20 } } },
          });
          await expect(listState(client)).resolves.toEqual({
            lists: [
              { id: 5, name: "target" },
              { id: 9, name: "decoy" },
            ],
            items: [
              { id: 10, label: "decoy", listId: 9 },
              { id: 20, label: "free", listId: 5 },
            ],
          });
        } finally {
          await dispose();
        }
      }
    );

    test(
      "connectOrCreate: the found arm reparents onto the new key, the absent arm creates on it",
      { timeout: 30_000 },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedLists(client);
          await update({
            where: { id: 1 },
            data: {
              id: 5,
              items: {
                connectOrCreate: [
                  { where: { id: 20 }, create: { id: 20, label: "unused" } },
                  { where: { id: 30 }, create: { id: 30, label: "fresh" } },
                ],
              },
            },
          });
          await expect(listState(client)).resolves.toEqual({
            lists: [
              { id: 5, name: "target" },
              { id: 9, name: "decoy" },
            ],
            items: [
              { id: 10, label: "decoy", listId: 9 },
              { id: 20, label: "free", listId: 5 },
              { id: 30, label: "fresh", listId: 5 },
            ],
          });
        } finally {
          await dispose();
        }
      }
    );

    test(
      "set on a NULLABLE child foreign key adopts onto the new key",
      { timeout: 30_000 },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedLists(client);
          await update({
            where: { id: 1 },
            data: { id: 5, items: { set: [{ id: 20 }] } },
          });
          await expect(listState(client)).resolves.toEqual({
            lists: [
              { id: 5, name: "target" },
              { id: 9, name: "decoy" },
            ],
            items: [
              { id: 10, label: "decoy", listId: 9 },
              { id: 20, label: "free", listId: 5 },
            ],
          });
        } finally {
          await dispose();
        }
      }
    );

    test(
      "set on a REQUIRED child foreign key: departing reads the OLD key, targets take the NEW one",
      { timeout: 30_000 },
      async () => {
        const { client, update, dispose } = await setup("crate");
        try {
          // Crate 1's slot is empty (the guard's premise); box 100 belongs to crate 9.
          await client.crate.create({ data: { id: 1, name: "target" } });
          await client.crate.create({ data: { id: 9, name: "decoy" } });
          await client.box.create({ data: { id: 100, tag: "b", crateId: 9 } });
          await update({
            where: { id: 1 },
            data: { id: 5, boxes: { set: [{ id: 100 }] } },
          });
          // The departing half is a correlated PLANNING read: it asks which rows carry
          // THIS crate's current key (none — the guard proved it), and a required
          // foreign key makes a non-empty answer the orphan rejection. It must not ask
          // about the post-transition key instead, which is why the part carries two
          // parent sources.
          await expect(
            client.crate.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([
            { id: 5, name: "target" },
            { id: 9, name: "decoy" },
          ]);
          await expect(
            client.box.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([{ id: 100, tag: "b", crateId: 5 }]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "to-many upsert: an absent target is created on the new key",
      { timeout: 30_000 },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedLists(client);
          await update({
            where: { id: 1 },
            data: {
              id: 5,
              items: {
                upsert: {
                  where: { id: 30 },
                  create: { id: 30, label: "fresh" },
                  update: { label: "unused" },
                },
              },
            },
          });
          await expect(listState(client)).resolves.toEqual({
            lists: [
              { id: 5, name: "target" },
              { id: 9, name: "decoy" },
            ],
            items: [
              { id: 10, label: "decoy", listId: 9 },
              { id: 20, label: "free", listId: null },
              { id: 30, label: "fresh", listId: 5 },
            ],
          });
        } finally {
          await dispose();
        }
      }
    );

    test(
      "to-many upsert: a target belonging to someone else is the ordinary uncorrelated rejection",
      { timeout: 30_000 },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedLists(client);
          // Item 10 is the decoy's. The correlated upsert's verdict here is the SAME one
          // it gives with no transition in the payload at all (measured, not assumed —
          // the transition-free spelling is the next assertion), and nothing is written.
          await expect(
            update({
              where: { id: 1 },
              data: {
                id: 5,
                items: {
                  upsert: {
                    where: { id: 10 },
                    create: { id: 10, label: "unused" },
                    update: { label: "stolen" },
                  },
                },
              },
            })
          ).rejects.toThrow(UNCORRELATED_TARGET);
          await expect(listState(client)).resolves.toEqual(SEEDED_LIST_STATE);

          await expect(
            update({
              where: { id: 1 },
              data: {
                name: "renamed",
                items: {
                  upsert: {
                    where: { id: 10 },
                    create: { id: 10, label: "unused" },
                    update: { label: "stolen" },
                  },
                },
              },
            })
          ).rejects.toThrow(UNCORRELATED_TARGET);
          await expect(listState(client)).resolves.toEqual(SEEDED_LIST_STATE);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "an OCCUPIED old slot still rejects, with the adopt in the payload",
      { timeout: 30_000 },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedLists(client);
          // Give the target list a child: the referential action would strand it, and
          // the relation-level occupied guard rejects before any write. N5-U1 changed
          // the ORDER of the accept-shape, never the guard.
          await client.item.update({
            where: { id: 20 },
            data: { listId: 1 },
          });
          await expect(
            update({
              where: { id: 1 },
              data: { id: 5, items: { connect: { id: 10 } } },
            })
          ).rejects.toThrow(OCCUPIED_SLOT);
          await expect(listState(client)).resolves.toEqual({
            lists: [
              { id: 1, name: "target" },
              { id: 9, name: "decoy" },
            ],
            items: [
              { id: 10, label: "decoy", listId: 9 },
              { id: 20, label: "free", listId: 1 },
            ],
          });
        } finally {
          await dispose();
        }
      }
    );

    test(
      "an absent connect target aborts the whole tree — no transition, no orphan",
      { timeout: 30_000 },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedLists(client);
          await expect(
            update({
              where: { id: 1 },
              data: { id: 5, items: { connect: { id: 777 } } },
            })
          ).rejects.toThrow(ABSENT_TARGET);
          await expect(listState(client)).resolves.toEqual(SEEDED_LIST_STATE);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "the inverse-side one-to-one is the arity-1 case of the same ordering",
      { timeout: 30_000 },
      async () => {
        const { client, update, dispose } = await setup("owner");
        try {
          await client.owner.create({ data: { id: 1, name: "target" } });
          await client.badge.create({
            data: { id: 10, code: "free", ownerId: null },
          });
          await update({
            where: { id: 1 },
            data: { id: 5, badge: { connect: { id: 10 } } },
          });
          await expect(
            client.owner.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([{ id: 5, name: "target" }]);
          await expect(
            client.badge.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([{ id: 10, code: "free", ownerId: 5 }]);
        } finally {
          await dispose();
        }
      }
    );
  });
}
