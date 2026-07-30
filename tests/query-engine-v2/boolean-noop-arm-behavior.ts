import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { push } from "@migrations";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";
import { OperationExecutor } from "../../src/query-engine-v2/OperationExecutor";
import { UpdateOperation } from "../../src/query-engine-v2/UpdateOperation";

/**
 * N7-U-B — **the arms that ask for nothing.**
 *
 * Two shapes the engine used to refuse (and, worse, two it silently mis-executed),
 * both measured against Prisma 7.9.1 live (`@prisma/adapter-pg` on Postgres) before a
 * line was changed:
 *
 * 1. **The boolean no-op arm.** A to-one `disconnect` / `delete` is typed
 *    `v.boolean()` at viborm's parse boundary, so the ONLY value other than `true`
 *    that can reach the engine is the literal `false`. Prisma treats `false` as DO
 *    NOTHING — `user.update({ data: { profile: { disconnect: false } } })` returns the
 *    parent unchanged with the child row and its foreign key untouched, on the
 *    inverse side and the parent-held side alike, while the same payload spelled
 *    `true` nulls the key. viborm did three different things instead:
 *
 *      · inverse-side `disconnect: false` / `delete: false` at the root → REFUSED
 *        (`UnsupportedOperationError`), and the same `delete: false` one level deeper;
 *      · parent-held `delete: false` → REFUSED;
 *      · parent-held `disconnect: false`, and inverse-side `disconnect: false` ONE
 *        LEVEL DEEPER → **silently disconnected**. The depth path coerced the arm to
 *        `true` outright (`nested-target-parts.ts`), so `false` did the opposite of
 *        what it asked.
 *
 *    Four census sites and two silent wrong-behavior paths, one cause: the boolean was
 *    re-read at each arm instead of being resolved once. It is now resolved once, in
 *    `getRelationMutationKinds` — a kind that asks for nothing is not a kind.
 *
 * 2. **The empty nested update.** `posts: { update: { where, data: {} } }` and the
 *    `updateMany` spelling are accepted by Prisma and write nothing; a `where` that
 *    matches NO row raises nothing either (unlike a non-empty nested update, which
 *    raises P2025) — the arm is skipped whole, never located. viborm's ROOT already
 *    accepted `update({ where, data: {} })`; only the NESTED spelling refused, with no
 *    reason recorded anywhere. It now agrees with both.
 *
 * Every case below asserts STATE, not just the absence of a throw: the point of a
 * no-op is that nothing moved. The `true` controls sit beside them so a plan that
 * no-ops everything cannot pass.
 */
export const booleanNoOpSchema = (() => {
  const holder = s
    .model({
      id: s.int().id(),
      name: s.string(),
      // PARENT-held to-one: the holder row carries the FK.
      cardId: s.int().nullable().unique(),
      card: s
        .oneToOne(() => card)
        .fields("cardId")
        .references("id")
        .optional(),
      // INVERSE-side to-one: the target carries the FK.
      tag: s.oneToOne(() => tag).optional(),
      // Depth: a to-many whose target carries its own inverse-side to-one.
      items: s.oneToMany(() => item),
    })
    .map("ubn_holders");

  const card = s
    .model({
      id: s.int().id(),
      face: s.string(),
      holder: s.oneToOne(() => holder).optional(),
    })
    .map("ubn_cards");

  const tag = s
    .model({
      id: s.int().id(),
      label: s.string(),
      holderId: s.int().nullable().unique(),
      holder: s
        .oneToOne(() => holder)
        .fields("holderId")
        .references("id")
        .optional(),
    })
    .map("ubn_tags");

  const item = s
    .model({
      id: s.int().id(),
      title: s.string(),
      holderId: s.int().nullable(),
      holder: s
        .manyToOne(() => holder)
        .fields("holderId")
        .references("id")
        .optional(),
      label: s.oneToOne(() => label).optional(),
    })
    .map("ubn_items");

  const label = s
    .model({
      id: s.int().id(),
      text: s.string(),
      itemId: s.int().nullable().unique(),
      item: s
        .oneToOne(() => item)
        .fields("itemId")
        .references("id")
        .optional(),
    })
    .map("ubn_labels");

  return { holder, card, tag, item, label };
})();

hydrateSchemaNames(booleanNoOpSchema);

/** The P2025-equivalent a NON-empty nested update still raises for a missing target. */
const TARGET_NOT_FOUND = /not found/i;

/**
 * The subject under test, driven at the operation seam rather than through the client
 * proxy — the same runner shape `own-write-linearization-behavior.ts` uses, and for the
 * same reason: the MySQL2 batch-forced driver refuses a plain `update` through the public
 * surface (*"public result parsing cannot be rolled back"*), so a client call cannot reach
 * the atomic-batch substrate there at all. This is the identical `UpdateOperation` the
 * client builds, executed by the identical `OperationExecutor`; what it skips is the
 * terminal read. `boolean-noop-arm.test.ts` keeps public-client witnesses for the same
 * shapes so the client path is not left unwitnessed.
 */
function makeRunner(driver: AnyDriver) {
  const schemas = createSchemaRegistry(booleanNoOpSchema);
  const engine = new QueryEngine(
    driver,
    createModelRegistry(booleanNoOpSchema, schemas)
  );
  const executor = new OperationExecutor(engine);
  return {
    async update(args: Record<string, unknown>) {
      return await executor.execute(
        new UpdateOperation(engine, booleanNoOpSchema.holder as any, args),
        createOperationExecutionContext(
          "holder",
          "update",
          engine.instrumentation
        )
      );
    },
  };
}

export function runBooleanNoOpArmBehavior(options: {
  readonly name: string;
  readonly createDriver: () => AnyDriver;
  /** A second driver for SETUP and STATE reads, where the driver under test cannot
   *  serve them — the MySQL2 batch-forced driver refuses a plain `update` because its
   *  public result parsing cannot be rolled back. Same database either way, so the
   *  reads still observe what the subject wrote. */
  readonly createStateDriver?: () => AnyDriver;
}): void {
  describe(`${options.name} boolean no-op arm + empty nested update`, () => {
    // ONE driver for the whole suite, not one per test. On the Docker legs a fresh
    // driver is a fresh connection pool, and thirty of them starve the server for
    // every suite that runs after this one — measured: with per-test drivers the pg
    // and MySQL legs failed suites this file never touches. Isolation is preserved by
    // emptying the tables at the head of each test instead.
    const driver = options.createDriver();
    const stateDriver = options.createStateDriver?.() ?? driver;
    const client: any = createClient({
      schema: booleanNoOpSchema,
      driver: stateDriver,
    });
    const run = makeRunner(driver);

    let suffix = 0;

    // Each test gets its OWN five rows, at ids derived from a counter. Nothing has to
    // be torn down between tests, so the suite pushes once and never depends on a
    // reset behaving the same way on five dialects — a leftover row from the previous
    // test simply is not addressed by this one. (The alternatives were measured and
    // both failed somewhere: a fresh driver per test starves the Docker legs of
    // connections, and re-pushing per test re-runs DDL a SQLite-family driver rejects.)
    const setup = async () => {
      // Push WHEN THE TABLES ARE NOT THERE, which is neither "once" nor "every time".
      // Measured, both failing: pushing once is not enough on the Docker legs, where a
      // sibling suite's `force` push drops these tables between two of these tests
      // (MySQL errno 1146); pushing every time is too much on the SQLite family, where
      // re-running the DDL against existing tables errors. The probe read is the
      // question actually being asked.
      const present = await client.card
        .findMany({ take: 1 })
        .then(() => true)
        .catch(() => false);
      if (!present) await push(client, { force: true });
      suffix += 1;
      const ids = {
        holder: suffix * 100 + 1,
        card: suffix * 100 + 10,
        tag: suffix * 100 + 20,
        item: suffix * 100 + 30,
        label: suffix * 100 + 40,
        missing: suffix * 100 + 99,
      };
      await client.card.create({ data: { id: ids.card, face: "face-a" } });
      await client.holder.create({
        data: { id: ids.holder, name: "holder-a", cardId: ids.card },
      });
      await client.tag.create({
        data: { id: ids.tag, label: "tag-a", holderId: ids.holder },
      });
      await client.item.create({
        data: { id: ids.item, title: "item-a", holderId: ids.holder },
      });
      await client.label.create({
        data: { id: ids.label, text: "label-a", itemId: ids.item },
      });
      return { client, run, ids };
    };

    // ---------------------------------------------------------------------
    // 1 — the boolean no-op arm, all four positions.
    // ---------------------------------------------------------------------

    test("inverse-side to-one `disconnect: false` moves nothing", async () => {
      const { client, run, ids } = await setup();
      await run.update({
        where: { id: ids.holder },
        data: { tag: { disconnect: false } },
      });
      expect(
        await client.tag.findUnique({ where: { id: ids.tag } })
      ).toMatchObject({
        holderId: ids.holder,
      });
    });

    test("inverse-side to-one `delete: false` moves nothing", async () => {
      const { client, run, ids } = await setup();
      await run.update({
        where: { id: ids.holder },
        data: { tag: { delete: false } },
      });
      expect(
        await client.tag.findUnique({ where: { id: ids.tag } })
      ).toMatchObject({
        holderId: ids.holder,
      });
    });

    test("parent-held to-one `disconnect: false` moves nothing", async () => {
      const { client, run, ids } = await setup();
      await run.update({
        where: { id: ids.holder },
        data: { card: { disconnect: false } },
      });
      expect(
        await client.holder.findUnique({ where: { id: ids.holder } })
      ).toMatchObject({ cardId: ids.card });
    });

    test("parent-held to-one `delete: false` moves nothing", async () => {
      const { client, run, ids } = await setup();
      await run.update({
        where: { id: ids.holder },
        data: { card: { delete: false } },
      });
      expect(
        await client.holder.findUnique({ where: { id: ids.holder } })
      ).toMatchObject({ cardId: ids.card });
      expect(
        await client.card.findUnique({ where: { id: ids.card } })
      ).not.toBeNull();
    });

    test("`disconnect: false` ONE LEVEL DEEPER moves nothing (was a silent disconnect)", async () => {
      const { client, run, ids } = await setup();
      await run.update({
        where: { id: ids.holder },
        data: {
          items: {
            update: {
              where: { id: ids.item },
              data: { label: { disconnect: false } },
            },
          },
        },
      });
      expect(
        await client.label.findUnique({ where: { id: ids.label } })
      ).toMatchObject({ itemId: ids.item });
    });

    test("`delete: false` ONE LEVEL DEEPER moves nothing", async () => {
      const { client, run, ids } = await setup();
      await run.update({
        where: { id: ids.holder },
        data: {
          items: {
            update: {
              where: { id: ids.item },
              data: { label: { delete: false } },
            },
          },
        },
      });
      expect(
        await client.label.findUnique({ where: { id: ids.label } })
      ).not.toBeNull();
    });

    // The controls: `true` still acts, in every one of those positions. Without
    // these, a plan that dropped every to-one arm would pass the six above.

    test("`disconnect: true` still disconnects (inverse side, parent-held, and at depth)", async () => {
      const { client, run, ids } = await setup();
      await run.update({
        where: { id: ids.holder },
        data: { tag: { disconnect: true } },
      });
      expect(
        await client.tag.findUnique({ where: { id: ids.tag } })
      ).toMatchObject({
        holderId: null,
      });
      await run.update({
        where: { id: ids.holder },
        data: { card: { disconnect: true } },
      });
      expect(
        await client.holder.findUnique({ where: { id: ids.holder } })
      ).toMatchObject({ cardId: null });
      await run.update({
        where: { id: ids.holder },
        data: {
          items: {
            update: {
              where: { id: ids.item },
              data: { label: { disconnect: true } },
            },
          },
        },
      });
      expect(
        await client.label.findUnique({ where: { id: ids.label } })
      ).toMatchObject({ itemId: null });
    });

    test("`delete: true` still deletes (inverse side and parent-held)", async () => {
      const { client, run, ids } = await setup();
      await run.update({
        where: { id: ids.holder },
        data: { tag: { delete: true } },
      });
      expect(
        await client.tag.findUnique({ where: { id: ids.tag } })
      ).toBeNull();
      await run.update({
        where: { id: ids.holder },
        data: { card: { delete: true } },
      });
      expect(
        await client.card.findUnique({ where: { id: ids.card } })
      ).toBeNull();
      expect(
        await client.holder.findUnique({ where: { id: ids.holder } })
      ).toMatchObject({ cardId: null });
    });

    test("a relation payload with only no-op arms leaves its siblings alone", async () => {
      const { client, run, ids } = await setup();
      await run.update({
        where: { id: ids.holder },
        data: {
          name: "renamed",
          card: { disconnect: false },
          tag: { delete: false },
        },
      });
      const holder = await client.holder.findUnique({
        where: { id: ids.holder },
      });
      expect(holder).toMatchObject({ name: "renamed", cardId: ids.card });
      expect(
        await client.tag.findUnique({ where: { id: ids.tag } })
      ).toMatchObject({
        holderId: ids.holder,
      });
    });

    // ---------------------------------------------------------------------
    // 2 — the empty nested update.
    // ---------------------------------------------------------------------

    test("nested `update` with empty data writes nothing", async () => {
      const { client, run, ids } = await setup();
      await run.update({
        where: { id: ids.holder },
        data: { items: { update: { where: { id: ids.item }, data: {} } } },
      });
      expect(
        await client.item.findUnique({ where: { id: ids.item } })
      ).toMatchObject({
        title: "item-a",
        holderId: ids.holder,
      });
    });

    test("nested `updateMany` with empty data writes nothing", async () => {
      const { client, run, ids } = await setup();
      await run.update({
        where: { id: ids.holder },
        data: { items: { updateMany: { where: { id: ids.item }, data: {} } } },
      });
      expect(
        await client.item.findUnique({ where: { id: ids.item } })
      ).toMatchObject({
        title: "item-a",
      });
    });

    test("an empty nested `update` does NOT require the target to exist", async () => {
      const { client, run, ids } = await setup();
      // Prisma, measured: with `data: {}` a `where` matching no row raises nothing —
      // the arm is skipped, never located. With NON-empty data the same `where`
      // raises P2025, which is the control immediately below.
      await run.update({
        where: { id: ids.holder },
        data: { items: { update: { where: { id: ids.missing }, data: {} } } },
      });
      expect(
        await client.item.findUnique({ where: { id: ids.item } })
      ).toMatchObject({
        title: "item-a",
      });
    });

    test("a NON-empty nested `update` still requires the target to exist", async () => {
      const { run, ids } = await setup();
      await expect(
        run.update({
          where: { id: ids.holder },
          data: {
            items: {
              update: { where: { id: ids.missing }, data: { title: "x" } },
            },
          },
        })
      ).rejects.toThrow(TARGET_NOT_FOUND);
    });

    test("an empty to-one nested `update` writes nothing, on both directions", async () => {
      const { client, run, ids } = await setup();
      await run.update({
        where: { id: ids.holder },
        data: { tag: { update: {} }, card: { update: {} } },
      });
      expect(
        await client.tag.findUnique({ where: { id: ids.tag } })
      ).toMatchObject({
        label: "tag-a",
        holderId: ids.holder,
      });
      expect(
        await client.card.findUnique({ where: { id: ids.card } })
      ).toMatchObject({
        face: "face-a",
      });
    });

    test("an empty nested update alongside a non-empty sibling leaves the sibling working", async () => {
      const { client, run, ids } = await setup();
      await run.update({
        where: { id: ids.holder },
        data: {
          items: { update: { where: { id: ids.item }, data: {} } },
          tag: { update: { label: "tag-b" } },
        },
      });
      expect(
        await client.item.findUnique({ where: { id: ids.item } })
      ).toMatchObject({
        title: "item-a",
      });
      expect(
        await client.tag.findUnique({ where: { id: ids.tag } })
      ).toMatchObject({
        label: "tag-b",
      });
    });
  });
}
