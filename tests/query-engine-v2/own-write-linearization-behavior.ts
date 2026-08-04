import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { push } from "@migrations";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { s } from "@schema";
import type { Model } from "@schema/model";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";
import { OperationExecutor } from "../../src/query-engine/write-engine/OperationExecutor";
import { UpdateOperation } from "../../src/query-engine/write-engine/UpdateOperation";

/**
 * **N6-U3 — the own-write linearization (ATOM §4.1), state-visible.**
 *
 * Sibling mutation kinds on one relation compose in ONE fixed order, declared once as
 * `RELATION_MUTATION_KEYS` and used both to EMIT the parts and to DERIVE their
 * legality. Before the amendment there were two orders, disagreeing on `deleteMany` vs
 * `upsert`, so a shape's soundness was checked against a sequence that never ran — and
 * 92 of the same-relation sibling combinations were rejected, most of them by the
 * arbitrariness of the order rather than by anything about the payload.
 *
 * The order, and the stage boundary that is the whole invariant (every decision read
 * before every write it could not bound; the kinds that read nothing go last):
 *
 * ```
 * disconnect → delete → update → upsert → connectOrCreate   (named readers)
 *           → set → updateMany → deleteMany                 (unbounded writers)
 *           → connect → create → createMany                 (pure adders)
 * ```
 *
 * Every test below is an ADJACENT PAIR in that sequence, asserted on **state** rather
 * than on statement text, because the claim is about what the rows end up being. Swap
 * any two stages in the constant and the pairs that cross the swap fail — which is the
 * falsification this file exists to support.
 *
 * The witnesses run through the OPERATION rather than the routed client, the convention
 * every update-family behaviour suite uses: a batch-only non-returning driver refuses
 * single-row mutations at the client seam, which would make a whole Docker leg vacuous
 * while looking green.
 */
/**
 * The three own-write refusals these pairs assert, hoisted to module scope: the
 * `useTopLevelRegex` norm every behaviour suite in this directory follows.
 */
const DELETE_TARGET_OWN_WRITE = /depends on an earlier 'delete' target write/;
const CONNECT_OR_CREATE_TARGET_OWN_WRITE =
  /depends on an earlier 'connectOrCreate' target write/;
const SET_MEMBERSHIP_OWN_WRITE = /depends on an earlier 'set' membership write/;

export const linearizationSchema = (() => {
  const author = s
    .model({
      id: s.int().id(),
      // A second unique so the pairs also compose with N1's located-parent Ref.
      email: s.string().unique(),
      name: s.string(),
      // child-held to-many: the FK lives on `note`
      notes: s.oneToMany(() => note),
      // many-to-many: membership lives in the junction
      posts: s.manyToMany(() => post),
    })
    .map("n6u3_authors");
  const note = s
    .model({
      id: s.int().id(),
      body: s.string(),
      authorId: s.int().nullable(),
      author: s
        .manyToOne(() => author)
        .fields("authorId")
        .references("id"),
    })
    .map("n6u3_notes");
  const post = s
    .model({
      id: s.int().id(),
      slug: s.string().unique(),
      title: s.string(),
      authors: s.manyToMany(() => author),
    })
    .map("n6u3_posts");
  return { author, note, post };
})();

function makeClient(driver: AnyDriver) {
  return createClient({ schema: linearizationSchema, driver });
}
type LinearizationClient = ReturnType<typeof makeClient>;

interface Runner {
  update(
    modelName: string,
    model: Model<any>,
    args: Record<string, unknown>
  ): Promise<unknown>;
}

function makeRunner(driver: AnyDriver): Runner {
  const schemas = createSchemaRegistry(linearizationSchema);
  const engine = new QueryEngine(
    driver,
    createModelRegistry(linearizationSchema, schemas)
  );
  const executor = new OperationExecutor(engine);
  return {
    async update(modelName, model, args) {
      return await executor.execute(
        new UpdateOperation(engine, model, args),
        createOperationExecutionContext(
          modelName,
          "update",
          engine.instrumentation
        )
      );
    },
  };
}

/** `id:body:authorId` for every note, ordered — the membership AND the row contents. */
async function noteState(client: LinearizationClient): Promise<string[]> {
  const rows = await client.note.findMany({ orderBy: { id: "asc" } });
  return rows.map((row) => `${row.id}:${row.body}:${row.authorId ?? "-"}`);
}

/** The posts joined to one author, ordered — the junction membership. */
async function postsOf(
  client: LinearizationClient,
  authorId: number
): Promise<string[]> {
  const rows = await client.post.findMany({
    where: { authors: { some: { id: authorId } } },
    orderBy: { id: "asc" },
  });
  return rows.map((row) => `${row.id}:${row.title}`);
}

/** Every post row that exists, ordered — so a `deleteMany` that removed a ROW shows. */
async function allPosts(client: LinearizationClient): Promise<string[]> {
  const rows = await client.post.findMany({ orderBy: { id: "asc" } });
  return rows.map((row) => `${row.id}:${row.title}`);
}

export function runOwnWriteLinearizationBehavior(options: {
  readonly name: string;
  readonly createDriver: () => AnyDriver;
  readonly createStateDriver?: () => AnyDriver;
}): void {
  describe(`${options.name} own-write linearization (N6-U3)`, () => {
    const setup = async () => {
      const driver = options.createDriver();
      const stateDriver = options.createStateDriver?.() ?? driver;
      const client = makeClient(stateDriver);
      const run = makeRunner(driver);
      const dispose = async () => {
        await client.$disconnect();
        if (driver !== stateDriver) await driver.disconnect();
      };
      // The fixture work runs BEFORE any test body, so no test's `finally` covers it.
      // A `push` or seed write that throws here would otherwise strand the driver — a
      // connection pool per failed setup on the Docker legs.
      try {
        await push(client, { force: true });
        // Author 1 is the subject; author 2 is the DECOY — every membership assertion
        // below would also pass if a write landed on author 2, so each test that can
        // reach the decoy asserts its membership stayed empty.
        await client.author.create({
          data: { id: 1, email: "one@x", name: "one" },
        });
        await client.author.create({
          data: { id: 2, email: "two@x", name: "two" },
        });
        await client.note.createMany({
          data: [
            { id: 801, body: "member-801", authorId: 1 },
            { id: 802, body: "member-802", authorId: 1 },
            { id: 803, body: "free-803", authorId: null },
            { id: 804, body: "bulk-804", authorId: 1 },
          ],
        });
        for (const id of [811, 812, 813, 814]) {
          await client.post.create({
            data: {
              id,
              slug: `s${id}`,
              title: id === 814 ? "bulk-814" : `p${id}`,
            },
          });
        }
        await client.author.update({
          where: { id: 1 },
          data: { posts: { connect: [{ id: 811 }, { id: 812 }, { id: 814 }] } },
        });
      } catch (error) {
        await dispose();
        throw error;
      }
      return { client, run, dispose };
    };

    // ------------------------------------------------------- stage 1 → stage 1

    test("delete then update: the update cannot address the row delete removed", async () => {
      const { client, run, dispose } = await setup();
      try {
        // The one class of rejection linearization CANNOT dissolve: two kinds naming
        // the SAME row with contradictory intents. Ordering cannot make an update find
        // a row that the same payload deletes first, and the preflight says so before
        // any I/O — this is the surviving refusal, re-justified, not an artefact.
        await expect(
          run.update("author", linearizationSchema.author, {
            where: { id: 1 },
            data: {
              notes: {
                delete: [{ id: 801 }],
                update: [{ where: { id: 801 }, data: { body: "never" } }],
              },
            },
          })
        ).rejects.toThrow(DELETE_TARGET_OWN_WRITE);
        expect(await noteState(client)).toEqual([
          "801:member-801:1",
          "802:member-802:1",
          "803:free-803:-",
          "804:bulk-804:1",
        ]);
      } finally {
        await dispose();
      }
    });

    test("disconnect then update on DISTINCT rows both land", async () => {
      const { client, run, dispose } = await setup();
      try {
        await run.update("author", linearizationSchema.author, {
          where: { id: 1 },
          data: {
            notes: {
              disconnect: [{ id: 801 }],
              update: [{ where: { id: 802 }, data: { body: "updated-802" } }],
            },
          },
        });
        expect(await noteState(client)).toEqual([
          "801:member-801:-",
          "802:updated-802:1",
          "803:free-803:-",
          "804:bulk-804:1",
        ]);
      } finally {
        await dispose();
      }
    });

    test("update then upsert: the upsert's UPDATE arm sees the row update just wrote", async () => {
      const { client, run, dispose } = await setup();
      try {
        // Adjacent in stage 1. Both address rows they NAME, so both writes are bounded
        // and the pair composes as written: 801 takes the targeted value, then 802's
        // upsert takes the update arm because its probe found a member.
        await run.update("author", linearizationSchema.author, {
          where: { id: 1 },
          data: {
            notes: {
              update: [{ where: { id: 801 }, data: { body: "updated-801" } }],
              upsert: [
                {
                  where: { id: 802 },
                  create: { id: 802, body: "never-created" },
                  update: { body: "upserted-802" },
                },
              ],
            },
          },
        });
        expect(await noteState(client)).toEqual([
          "801:updated-801:1",
          "802:upserted-802:1",
          "803:free-803:-",
          "804:bulk-804:1",
        ]);
      } finally {
        await dispose();
      }
    });

    test("upsert then connectOrCreate: both arms decide from committed state", async () => {
      const { client, run, dispose } = await setup();
      try {
        await run.update("author", linearizationSchema.author, {
          where: { id: 1 },
          data: {
            notes: {
              upsert: [
                {
                  where: { id: 802 },
                  create: { id: 802, body: "never-created" },
                  update: { body: "upserted-802" },
                },
              ],
              connectOrCreate: [
                {
                  where: { id: 803 },
                  create: { id: 803, body: "never-created" },
                },
              ],
            },
          },
        });
        // 803 existed, so connectOrCreate ADOPTED it rather than inserting: its body is
        // the seeded one, and it is now a member.
        expect(await noteState(client)).toEqual([
          "801:member-801:1",
          "802:upserted-802:1",
          "803:free-803:1",
          "804:bulk-804:1",
        ]);
      } finally {
        await dispose();
      }
    });

    // ------------------------------------------------------- stage 1 → stage 2

    test("connectOrCreate then set: the adopt lands first and set has the last word", async () => {
      const { client, run, dispose } = await setup();
      try {
        // The stage boundary itself: connectOrCreate READS (to choose its arm) and must
        // therefore precede `set`, whose membership write is unbounded.
        //
        // The two kinds name DIFFERENT rows on purpose. Naming the same one is the
        // surviving case-(i) rejection — `set`'s existence read of the row the adopt
        // just wrote — and it is asserted directly two tests below.
        //
        // 905 does not exist, so the adopt takes its CREATE arm and attaches the fresh
        // row; `set` then declares the membership to be exactly 801, which detaches it.
        // That final null FK on 905 is what makes the pair discriminate: had `set` run
        // first, the row created after it would still be attached.
        await run.update("author", linearizationSchema.author, {
          where: { id: 1 },
          data: {
            notes: {
              connectOrCreate: [
                {
                  where: { id: 905 },
                  create: { id: 905, body: "adopted-905" },
                },
              ],
              set: [{ id: 801 }],
            },
          },
        });
        expect(await noteState(client)).toEqual([
          "801:member-801:1",
          "802:member-802:-",
          "803:free-803:-",
          "804:bulk-804:-",
          "905:adopted-905:-",
        ]);
      } finally {
        await dispose();
      }
    });

    test("connectOrCreate and set on the SAME row stay refused", async () => {
      const { client, run, dispose } = await setup();
      try {
        // Case (i), re-justified: `set` must read whether the row it lists exists, and
        // the sibling adopt writes that very existence. No ordering dissolves it — put
        // `set` first and the adopt's own probe reads a membership `set` has rewritten.
        await expect(
          run.update("author", linearizationSchema.author, {
            where: { id: 1 },
            data: {
              notes: {
                connectOrCreate: [
                  {
                    where: { id: 905 },
                    create: { id: 905, body: "adopted-905" },
                  },
                ],
                set: [{ id: 905 }],
              },
            },
          })
        ).rejects.toThrow(CONNECT_OR_CREATE_TARGET_OWN_WRITE);
        expect(await noteState(client)).toEqual([
          "801:member-801:1",
          "802:member-802:1",
          "803:free-803:-",
          "804:bulk-804:1",
        ]);
      } finally {
        await dispose();
      }
    });

    test("set then updateMany: the bulk update acts on the membership set declared", async () => {
      const { client, run, dispose } = await setup();
      try {
        await run.update("author", linearizationSchema.author, {
          where: { id: 1 },
          data: {
            notes: {
              set: [{ id: 801 }, { id: 804 }],
              updateMany: [
                {
                  where: { body: { contains: "bulk" } },
                  data: { body: "swept" },
                },
              ],
            },
          },
        });
        // 804 is still a member after `set`, so the sweep reaches it. 802 was detached
        // by `set` and does not match anyway; 803 was never a member.
        expect(await noteState(client)).toEqual([
          "801:member-801:1",
          "802:member-802:-",
          "803:free-803:-",
          "804:swept:1",
        ]);
      } finally {
        await dispose();
      }
    });

    test("updateMany then deleteMany: the sweep runs before the filtered removal", async () => {
      const { client, run, dispose } = await setup();
      try {
        await run.update("author", linearizationSchema.author, {
          where: { id: 1 },
          data: {
            notes: {
              updateMany: [
                {
                  where: { body: { contains: "member" } },
                  data: { body: "swept" },
                },
              ],
              deleteMany: [{ body: { contains: "bulk" } }],
            },
          },
        });
        // The sweep renamed 801/802 out of the way FIRST, so the removal's filter
        // ("bulk") reaches only 804. Reverse the two and the sweep would find nothing
        // left to rename.
        expect(await noteState(client)).toEqual([
          "801:swept:1",
          "802:swept:1",
          "803:free-803:-",
        ]);
      } finally {
        await dispose();
      }
    });

    // ------------------------------------------------------- stage 2 → stage 3

    test("deleteMany then create: a filtered removal never consumes the row this call adds", async () => {
      const { client, run, dispose } = await setup();
      try {
        // The headline divergence from Prisma. Prisma executes sibling kinds in the JS
        // object's key order, so `{ create, deleteMany }` there DELETES the row it just
        // inserted (measured on Prisma 7.9.1; prisma/prisma#16606, open, bug/2-confirmed).
        // Here the order is fixed, the removal is resolved against committed state, and
        // the fresh row survives no matter which key the caller wrote first.
        await run.update("author", linearizationSchema.author, {
          where: { id: 1 },
          data: {
            notes: {
              create: [{ id: 901, body: "bulk-901" }],
              deleteMany: [{ body: { contains: "bulk" } }],
            },
          },
        });
        expect(await noteState(client)).toEqual([
          "801:member-801:1",
          "802:member-802:1",
          "803:free-803:-",
          "901:bulk-901:1",
        ]);
      } finally {
        await dispose();
      }
    });

    test("set then create: final membership is exactly set ∪ created", async () => {
      const { client, run, dispose } = await setup();
      try {
        // Before the amendment `create` ran FIRST and `set` then orphaned the row the
        // same payload had just inserted (measured: 901 landed with a null FK). `set`
        // declares the base membership; the pure adders add to it.
        await run.update("author", linearizationSchema.author, {
          where: { id: 1 },
          data: {
            notes: {
              set: [{ id: 803 }],
              create: [{ id: 901, body: "fresh-901" }],
            },
          },
        });
        expect(await noteState(client)).toEqual([
          "801:member-801:-",
          "802:member-802:-",
          "803:free-803:1",
          "804:bulk-804:-",
          "901:fresh-901:1",
        ]);
        // The decoy: no membership leaked onto author 2.
        expect(await client.note.findMany({ where: { authorId: 2 } })).toEqual(
          []
        );
      } finally {
        await dispose();
      }
    });

    test("connect then create: the adopted row and the fresh row both land", async () => {
      const { client, run, dispose } = await setup();
      try {
        // The shape the plan called A14's headline. It never actually refused — the
        // measurement said so before anything was touched — and it still executes; it
        // is here so the pair is pinned in the same file as the ones that changed.
        await run.update("author", linearizationSchema.author, {
          where: { id: 1 },
          data: {
            notes: {
              connect: [{ id: 803 }],
              create: [{ id: 901, body: "fresh-901" }],
            },
          },
        });
        expect(await noteState(client)).toEqual([
          "801:member-801:1",
          "802:member-802:1",
          "803:free-803:1",
          "804:bulk-804:1",
          "901:fresh-901:1",
        ]);
      } finally {
        await dispose();
      }
    });

    test("delete then create of the SAME identity: the row that remains is the fresh one", async () => {
      const { client, run, dispose } = await setup();
      try {
        // Rejected outright before the amendment, in BOTH spellings. Prisma accepts it
        // only when the caller happens to write `delete` first; `{ create, delete }`
        // there raises a unique violation. Fixing the order makes "replace this child"
        // a payload with one meaning.
        await run.update("author", linearizationSchema.author, {
          where: { id: 1 },
          data: {
            notes: {
              delete: [{ id: 801 }],
              create: [{ id: 801, body: "reborn-801" }],
            },
          },
        });
        expect(await noteState(client)).toEqual([
          "801:reborn-801:1",
          "802:member-802:1",
          "803:free-803:-",
          "804:bulk-804:1",
        ]);
      } finally {
        await dispose();
      }
    });

    test("disconnect and connect on distinct targets compose", async () => {
      const { client, run, dispose } = await setup();
      try {
        await run.update("author", linearizationSchema.author, {
          where: { id: 1 },
          data: {
            notes: { disconnect: [{ id: 801 }], connect: [{ id: 803 }] },
          },
        });
        expect(await noteState(client)).toEqual([
          "801:member-801:-",
          "802:member-802:1",
          "803:free-803:1",
          "804:bulk-804:1",
        ]);
      } finally {
        await dispose();
      }
    });

    test("create then createMany: both adders land under the located parent", async () => {
      const { client, run, dispose } = await setup();
      try {
        // The last adjacent pair, and the one that also exercises the located-parent Ref
        // (the root is addressed by its non-PK `email` unique, so neither fresh row's FK
        // is pinned by the `where`). The decoy author must stay empty.
        await run.update("author", linearizationSchema.author, {
          where: { email: "one@x" },
          data: {
            notes: {
              create: [{ id: 901, body: "fresh-901" }],
              createMany: { data: [{ id: 902, body: "fresh-902" }] },
            },
          },
        });
        expect(await noteState(client)).toEqual([
          "801:member-801:1",
          "802:member-802:1",
          "803:free-803:-",
          "804:bulk-804:1",
          "901:fresh-901:1",
          "902:fresh-902:1",
        ]);
        expect(await client.note.findMany({ where: { authorId: 2 } })).toEqual(
          []
        );
      } finally {
        await dispose();
      }
    });

    // ------------------------------------------------------- all eleven at once

    test("all eleven kinds on one child-held relation execute in the fixed order", async () => {
      const { client, run, dispose } = await setup();
      try {
        // Rejected before the amendment (`update` was said to depend on `set`). The
        // whole surface now composes, and every kind names a DIFFERENT row, so nothing
        // here is a case-(i) contradiction — the only thing deciding the final state is
        // the order. Read it off the sequence:
        //
        //   disconnect 802 → delete 804 → update 801 → upsert 905 (create arm)
        //   → connectOrCreate 906 (create arm) → set [803] → updateMany "free" → …
        //   → deleteMany "swept" → connect 802 → create 901 → createMany 902
        //
        // `set` detaches everything it does not list, which is why 801, 905 and 906 —
        // all attached by stage 1 — end with a null FK, while 802 comes back because
        // `connect` is a stage-3 adder that runs after it. 803 is the sole member `set`
        // declares, so it is the only row `updateMany` can rename and therefore the only
        // row `deleteMany` can then remove. 901 and 902 are added last and survive.
        await run.update("author", linearizationSchema.author, {
          where: { id: 1 },
          data: {
            notes: {
              disconnect: [{ id: 802 }],
              delete: [{ id: 804 }],
              update: [{ where: { id: 801 }, data: { body: "updated-801" } }],
              upsert: [
                {
                  where: { id: 905 },
                  create: { id: 905, body: "upsert-created" },
                  update: { body: "never" },
                },
              ],
              connectOrCreate: [
                {
                  where: { id: 906 },
                  create: { id: 906, body: "adopt-created" },
                },
              ],
              set: [{ id: 803 }],
              updateMany: [
                {
                  where: { body: { contains: "free" } },
                  data: { body: "swept" },
                },
              ],
              deleteMany: [{ body: { contains: "swept" } }],
              connect: [{ id: 802 }],
              create: [{ id: 901, body: "fresh-901" }],
              createMany: { data: [{ id: 902, body: "fresh-902" }] },
            },
          },
        });
        expect(await noteState(client)).toEqual([
          "801:updated-801:-",
          "802:member-802:1",
          "901:fresh-901:1",
          "902:fresh-902:1",
          "905:upsert-created:-",
          "906:adopt-created:-",
        ]);
      } finally {
        await dispose();
      }
    });

    // ------------------------------------------------------- many-to-many

    test("m2m set then create: membership is exactly set ∪ created", async () => {
      const { client, run, dispose } = await setup();
      try {
        await run.update("author", linearizationSchema.author, {
          where: { id: 1 },
          data: {
            posts: {
              set: [{ id: 813 }],
              create: [{ id: 901, slug: "s901", title: "fresh-901" }],
            },
          },
        });
        expect(await postsOf(client, 1)).toEqual(["813:p813", "901:fresh-901"]);
        expect(await postsOf(client, 2)).toEqual([]);
      } finally {
        await dispose();
      }
    });

    test("m2m deleteMany then connect: the removal is resolved against committed membership", async () => {
      const { client, run, dispose } = await setup();
      try {
        // `deleteMany` on a junction reads membership, so it is ordered before the pure
        // adders: post 813 is not a member when the removal resolves, so the removal
        // leaves it alone and the sibling `connect` then attaches it. 814 IS a member
        // and matches, so its ROW is deleted.
        await run.update("author", linearizationSchema.author, {
          where: { id: 1 },
          data: {
            posts: {
              deleteMany: [{ title: { contains: "bulk" } }],
              connect: [{ id: 813 }],
            },
          },
        });
        expect(await postsOf(client, 1)).toEqual([
          "811:p811",
          "812:p812",
          "813:p813",
        ]);
        expect(await allPosts(client)).toEqual([
          "811:p811",
          "812:p812",
          "813:p813",
        ]);
      } finally {
        await dispose();
      }
    });

    test("m2m set then deleteMany stays refused: the removal's filter cannot be bounded", async () => {
      const { client, run, dispose } = await setup();
      try {
        // The second surviving class, re-justified: a junction `deleteMany` must resolve
        // its filter against membership, and `set` rewrites the whole membership. No
        // ordering fixes this — the removal's result set is not knowable at compile, so
        // it cannot be widened to an unconditional read either (ATOM §4.1, case ii).
        // The escape is the one the message names: two calls.
        await expect(
          run.update("author", linearizationSchema.author, {
            where: { id: 1 },
            data: {
              posts: {
                set: [{ id: 813 }],
                deleteMany: [{ title: { contains: "bulk" } }],
              },
            },
          })
        ).rejects.toThrow(SET_MEMBERSHIP_OWN_WRITE);
        expect(await postsOf(client, 1)).toEqual([
          "811:p811",
          "812:p812",
          "814:bulk-814",
        ]);
      } finally {
        await dispose();
      }
    });
  });
}
