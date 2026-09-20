/**
 * FC-02C — **a concrete reference that becomes a relation must be
 * representable.**
 *
 * A parent-held edge may reference a NULLABLE unique, and the payload may
 * address its target by a DIFFERENT unique. The value the holder then writes
 * for the edge is the one the located row holds for the referenced column, and
 * that column can read NULL: writing it does not connect the relation, it
 * DISCONNECTS the holder from whatever it pointed at. The requirement is the
 * relation's — it belongs to every choice that supplies a located row's
 * referenced value — and the retired engine stated it exactly there, for a
 * plain `connect` and for a `connectOrCreate`'s FOUND arm alike
 * (`RecordUpdateCompiler.assertLookupKeyPresent`, `messages.lookupKeyIsNull`).
 *
 * Raptor 3 had narrowed it to the one arm it FOLDS — the parent-held `connect`
 * whose value the parent's own SET spends — so a found `connectOrCreate` wrote
 * the NULL and silently disconnected the holder (N5's recorded residual). The
 * requirement now stands at `CommandExecution.supplied`, outside the fold's
 * verb gate: every demanded field a choice supplies from its located row is
 * asked, and the sentence is the inherited one, fixed at `connect`, because
 * what is refused is the CONNECTION and not the verb that spelled it.
 *
 * The refusal is raised where the choice binds what the holder will spend —
 * ahead of every write of the unit, the sibling scalars of the same SET
 * included — so on the interactive route nothing of the operation stands
 * committed, and on the segmented route the operation's own segment was never
 * dispatched (D-51's succession: what stands committed behind a refusal is
 * whatever an earlier flush already carried, and a parent-held arm is placed
 * BEFORE its holder's write, so there is nothing).
 *
 * Out of scope here, measured and recorded in the unit's note: the create arm
 * of a `connectOrCreate` (its producer is the CHOICE, so
 * `Commands.assignMembership`'s "cannot resolve the parent id" rule never sees
 * the create's own payload) and the CHILD-held direction (the reference is the
 * holder's parent's own value, spent by the member's statement, not by a
 * choice's supply).
 */

import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { NestedWriteError } from "@errors";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, describe, it } from "vitest";
import { RecordingSQLiteDriver } from "../unit02/world";
import { BatchOnlyDriver } from "./batch-only-drivers";

/** The single-member bed: `code` is a NULLABLE unique the payload does not address. */
const badge = s
  .model({
    id: s.string().id(),
    slug: s.string().unique(),
    code: s.string().nullable().unique(),
    /** A nullable scalar NOTHING consumes as a reference: it must stay legal. */
    note: s.string().nullable(),
    holders: s.toMany(() => holder),
  })
  .map("fc02c_badges");
const holder = s
  .model({
    id: s.string().id(),
    name: s.string(),
    badgeCode: s.string().nullable(),
    badge: s
      .toOne(() => badge)
      .fields("badgeCode")
      .references("code"),
  })
  .map("fc02c_holders");
/** The COMPOUND bed: one member of the referenced pair is nullable. */
const pass = s
  .model({
    id: s.string().id(),
    zone: s.string(),
    serial: s.string().nullable(),
    gates: s.toMany(() => gate),
  })
  .unique(["zone", "serial"])
  .map("fc02c_passes");
const gate = s
  .model({
    id: s.string().id(),
    label: s.string(),
    passZone: s.string().nullable(),
    passSerial: s.string().nullable(),
    pass: s
      .toOne(() => pass)
      .fields("passZone", "passSerial")
      .references("zone", "serial"),
  })
  .map("fc02c_gates");
/** The JUNCTION placement: a captured pair addresses the target's own row key. */
const tag = s
  .model({
    id: s.string().id(),
    slug: s.string().unique(),
    code: s.string().nullable().unique(),
    posts: s.toMany(() => post),
  })
  .map("fc02c_tags");
const post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    tags: s.toMany(() => tag).through("fc02c_post_tags"),
  })
  .map("fc02c_posts");
const schema = { badge, gate, holder, pass, post, tag };

const NULL_CODE =
  "Cannot connect relation 'badge': the located target's referenced field 'code' is null.";
const NULL_SERIAL =
  "Cannot connect relation 'pass': the located target's referenced field 'serial' is null.";

/**
 * Both routes the refusal has to answer on: an interactive local transaction
 * and the segmented (batch-only) transport, whose progress contract is the
 * approved one — nothing of this operation was dispatched, because a
 * parent-held arm stands BEFORE the holder's own write.
 */
const ROUTES = [
  ["interactive", false],
  ["segmented", true],
] as const;

for (const [route, batch] of ROUTES) {
  describe(`FC-02C: reference representability on the ${route} route`, () => {
    let driver: RecordingSQLiteDriver;
    afterEach(async () => {
      await driver?.disconnect();
    });

    async function world() {
      driver = batch ? new BatchOnlyDriver() : new RecordingSQLiteDriver();
      const client = createClient({ schema, driver });
      await syncLiveSchema(client);
      // `codeless` MATCHES the payload's selector and holds NULL for the
      // referenced column; `gold` is the representable neighbour and the
      // member the holder starts on, so a silent disconnect is VISIBLE.
      await client.badge.create({
        data: { id: "b1", slug: "codeless", code: null, note: null },
      });
      await client.badge.create({
        data: { id: "b2", slug: "gold", code: "GOLD", note: null },
      });
      await client.holder.create({
        data: { id: "h1", name: "one", badgeCode: "GOLD" },
      });
      await client.pass.create({
        data: { id: "p1", zone: "north", serial: null },
      });
      await client.pass.create({
        data: { id: "p2", zone: "south", serial: "S2" },
      });
      await client.gate.create({
        data: {
          id: "g1",
          label: "gate-1",
          passZone: "south",
          passSerial: "S2",
        },
      });
      await client.tag.create({
        data: { id: "t1", slug: "codeless", code: null },
      });
      await client.post.create({ data: { id: "po1", title: "post-1" } });
      driver.reset();
      return client;
    }

    it("connects a representable target through both verbs", async () => {
      const client = await world();
      assert.deepEqual(
        await client.holder.update({
          where: { id: "h1" },
          data: { badgeCode: null, name: "cleared" },
        }),
        { id: "h1", name: "cleared", badgeCode: null }
      );
      assert.deepEqual(
        await client.holder.update({
          where: { id: "h1" },
          data: { name: "connected", badge: { connect: { slug: "gold" } } },
        }),
        { id: "h1", name: "connected", badgeCode: "GOLD" }
      );
      assert.deepEqual(
        await client.holder.update({
          where: { id: "h1" },
          data: { badgeCode: null },
        }),
        { id: "h1", name: "connected", badgeCode: null }
      );
      assert.deepEqual(
        await client.holder.update({
          where: { id: "h1" },
          data: {
            name: "adopted",
            badge: {
              connectOrCreate: {
                where: { slug: "gold" },
                create: { id: "b9", slug: "gold", code: "NEVER", note: null },
              },
            },
          },
        }),
        { id: "h1", name: "adopted", badgeCode: "GOLD" }
      );
      // The create arm was not taken.
      assert.deepEqual(
        (await client.badge.findMany({ orderBy: { id: "asc" } })).map(
          (row) => row.id
        ),
        ["b1", "b2"]
      );
    });

    it("refuses a FOUND connectOrCreate whose reference is unrepresentable, and disconnects nothing", async () => {
      // THE WITNESS. At the base this resolved, wrote NULL into `badgeCode`
      // and left the holder a member of nothing, with `name` renamed beside
      // it — the pre-N5 behaviour the `folded` narrowing had restored.
      const client = await world();
      await assert.rejects(
        async () => {
          await client.holder.update({
            where: { id: "h1" },
            data: {
              name: "renamed",
              badge: {
                connectOrCreate: {
                  where: { slug: "codeless" },
                  create: {
                    id: "b9",
                    slug: "codeless",
                    code: "NEW",
                    note: null,
                  },
                },
              },
            },
          });
        },
        (error: unknown) =>
          error instanceof NestedWriteError && error.message === NULL_CODE
      );
      // The holder keeps its member AND its sibling scalar: the refusal stands
      // ahead of the SET that carries both.
      assert.deepEqual(await client.holder.findMany(), [
        { id: "h1", name: "one", badgeCode: "GOLD" },
      ]);
      // The create arm never ran either.
      assert.deepEqual(
        (await client.badge.findMany({ orderBy: { id: "asc" } })).map(
          (row) => row.id
        ),
        ["b1", "b2"]
      );
    });

    it("keeps the plain connect's own sentence and its written state", async () => {
      // The inherited sentence is fixed at `connect` for every verb, so the
      // arm that already refused answers exactly what it answered before.
      const client = await world();
      await assert.rejects(
        async () => {
          await client.holder.update({
            where: { id: "h1" },
            data: { name: "renamed", badge: { connect: { slug: "codeless" } } },
          });
        },
        (error: unknown) =>
          error instanceof NestedWriteError && error.message === NULL_CODE
      );
      assert.deepEqual(await client.holder.findMany(), [
        { id: "h1", name: "one", badgeCode: "GOLD" },
      ]);
    });

    it("refuses on a COMPOUND edge when one member of the pair is unrepresentable", async () => {
      const client = await world();
      await assert.rejects(
        async () => {
          await client.gate.update({
            where: { id: "g1" },
            data: {
              label: "renamed",
              pass: {
                connectOrCreate: {
                  where: { id: "p1" },
                  create: { id: "p9", zone: "north", serial: "S9" },
                },
              },
            },
          });
        },
        (error: unknown) =>
          error instanceof NestedWriteError && error.message === NULL_SERIAL
      );
      assert.deepEqual(await client.gate.findMany(), [
        { id: "g1", label: "gate-1", passZone: "south", passSerial: "S2" },
      ]);
      // The representable compound target still connects, both members of it.
      assert.deepEqual(
        await client.gate.update({
          where: { id: "g1" },
          data: {
            label: "moved",
            pass: {
              connectOrCreate: {
                where: { id: "p2" },
                create: { id: "p9", zone: "south", serial: "S2" },
              },
            },
          },
        }),
        {
          id: "g1",
          label: "moved",
          passZone: "south",
          passSerial: "S2",
        }
      );
    });

    it("leaves a nullable scalar that is never consumed as a reference alone", async () => {
      // `note` is nullable and NULL on the target; `code` is nullable and NULL
      // on `b1`, which is legal for every use but becoming this relation. A
      // schema is not rejected for owning one, and a row is not rejected for
      // holding one.
      const client = await world();
      assert.deepEqual(
        await client.badge.update({
          where: { id: "b1" },
          data: { slug: "still-codeless" },
        }),
        { id: "b1", slug: "still-codeless", code: null, note: null }
      );
      assert.deepEqual(
        await client.holder.update({
          where: { id: "h1" },
          data: { name: "kept", badge: { connect: { slug: "gold" } } },
        }),
        { id: "h1", name: "kept", badgeCode: "GOLD" }
      );
      assert.deepEqual(
        await client.holder.create({
          data: { id: "h2", name: "two", badgeCode: null },
        }),
        { id: "h2", name: "two", badgeCode: null }
      );
    });

    it("asks nothing of a JUNCTION choice, whose captured pair is the target's row key", async () => {
      // The junction placement runs through the same supply: its demanded
      // fields are the endpoints' ROW KEYS, which no schema can make nullable,
      // so a target holding NULL in an unrelated nullable unique connects.
      const client = await world();
      assert.deepEqual(
        await client.post.update({
          where: { id: "po1" },
          data: {
            title: "linked",
            tags: {
              connectOrCreate: {
                where: { slug: "codeless" },
                create: { id: "t9", slug: "codeless", code: "NEW" },
              },
            },
          },
          include: { tags: true },
        }),
        {
          id: "po1",
          title: "linked",
          tags: [{ id: "t1", slug: "codeless", code: null }],
        }
      );
    });
  });
}
