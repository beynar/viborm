/**
 * FC-02C — **a concrete reference that becomes a relation must be
 * representable.**
 *
 * A parent-held edge may reference a NULLABLE unique, and the payload may
 * address its target by a DIFFERENT unique. The value the holder then writes
 * for the edge is the one the located row holds for the referenced column, and
 * that column can read NULL: writing it does not connect the relation, it
 * DISCONNECTS the holder from whatever it pointed at. The requirement is the
 * relation's — not a verb's, not an arm's, not a direction's — and the retired
 * engine stated it for a plain `connect` and for a `connectOrCreate`'s FOUND
 * arm alike (`RecordUpdateCompiler.assertLookupKeyPresent`,
 * `messages.lookupKeyIsNull`).
 *
 * Raptor 3 had narrowed it to the one arm it FOLDS — the parent-held `connect`
 * whose value the parent's own SET spends — so a found `connectOrCreate` wrote
 * the NULL and silently disconnected the holder (N5's recorded residual).
 *
 * The requirement's owner is now `CommandExecution.stored`, which asks it over
 * the write values of EVERY record statement, outside the fold's verb gate;
 * `CommandExecution.requireRepresentable` is its one sentence. Only the
 * components the RESOLVED EDGE named are asked — not every field the row
 * happens to demand — and each is asked at its ACTUAL value, whatever supplied
 * it: a located row's bytes, an arm this operation itself created (asked once
 * the boundary has read it back and not before, D-58), or the parent's own
 * current value (`CommandAttempt.read`, FC-02A). `CommandExecution.folded`
 * states the same requirement a SECOND time, for the one arm only the fold can
 * ask about: once a parent-held `connect`'s value is folded into the holder's
 * SET it IS a sub-select, so the literal the probe read exists there and
 * nowhere after. The sentence is the inherited one, fixed at `connect`,
 * because what is refused is the CONNECTION and not the verb that spelled it.
 *
 * The refusal stands ahead of the holder's own SET and the sibling scalars of
 * that same statement, so nothing the holder would have written stands
 * committed. It does NOT stand ahead of every write of the unit: a
 * record-owned placement is asked after this record's `before` children have
 * run, so a refused `connectOrCreate`'s CREATE arm may already have INSERTed
 * its own row — and that row is taken back by the OPERATION's own rollback,
 * which is the native witness's first fact
 * (`tests/providers/docker/pg-reference-representability.test.ts`). On the
 * segmented transports the answer measured on both batch-only fixtures is that
 * nothing had been dispatched at all, so the failure claims no progress and no
 * rollback of a prefix it never made (D-51's succession: what stands committed
 * behind a planning refusal is whatever an earlier flush already carried).
 *
 * Out of scope here, recorded unchanged: FC-02C's R3, the nested
 * `update`/`upsert` FOUND arm that nulls the referenced column under a live
 * member (`badge: { update: { code: null } }`). The user explicitly asked for
 * that NULL and the provider's own constraint is a defensible answer, so it
 * keeps its provider `ForeignKeyError`. The two placements FC-02C listed as
 * out of scope — a `connectOrCreate`'s CREATE arm and the CHILD-held direction
 * — are IN scope here and are this file's own cells ("refuses a
 * connectOrCreate whose CREATE arm produces an unrepresentable reference",
 * "refuses the CHILD-held direction when the parent's own reference reads
 * null").
 */

import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { NestedWriteError, UnsupportedOperationError } from "@errors";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, describe, it } from "vitest";
import { RecordingSQLiteDriver } from "../unit02/world";
import {
  BatchOnlyDriver,
  SessionlessBatchOnlyDriver,
} from "./batch-only-drivers";

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
 * The CHILD-held direction names the edge the payload spelled — the to-many
 * side — and the same referenced field, because the fact is the relation's and
 * the sentence is the one the retired engine already spells for it.
 */
const NULL_CODE_HOLDERS =
  "Cannot connect relation 'holders': the located target's referenced field 'code' is null.";
const NULL_SERIAL_GATES =
  "Cannot connect relation 'gates': the located target's referenced field 'serial' is null.";

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

    // ------------------------------------------------------------ R1 (new)
    // The two residuals FC-02C measured, recorded and could not reach from the
    // choice's own supply. Both are the SAME fact; neither is a new sentence.

    it("refuses a connectOrCreate whose CREATE arm produces an unrepresentable reference", async () => {
      // FC-02C residual R1, measured on the repaired tree
      // (`closure/fc02c/receipts/residual-probe.log`): the create arm's own
      // payload spells the referenced column NULL, so the row the choice
      // PRODUCES cannot represent the relation either — the holder was
      // disconnected and `b9` stood created beside it.
      const client = await world();
      await assert.rejects(
        async () => {
          await client.holder.update({
            where: { id: "h1" },
            data: {
              name: "renamed",
              badge: {
                connectOrCreate: {
                  where: { slug: "fresh" },
                  create: { id: "b9", slug: "fresh", code: null, note: null },
                },
              },
            },
          });
        },
        (error: unknown) =>
          error instanceof NestedWriteError && error.message === NULL_CODE
      );
      assert.deepEqual(await client.holder.findMany(), [
        { id: "h1", name: "one", badgeCode: "GOLD" },
      ]);
      // The arm's own INSERT is the operation's, so the operation owns its
      // undoing: the interactive route rolls it back and the segmented route
      // never dispatched the unit that holds it.
      assert.deepEqual(
        (await client.badge.findMany({ orderBy: { id: "asc" } })).map(
          (row) => row.id
        ),
        ["b1", "b2"]
      );
    });

    it("refuses the CHILD-held direction when the parent's own reference reads null", async () => {
      // FC-02C residual R2. Here the concrete reference is the PARENT's own
      // current value and the member's statement spends it: `h1` is not made a
      // member of `b1` — it is disconnected from `b2` — and the parent's
      // sibling scalar was written beside it.
      const client = await world();
      await assert.rejects(
        async () => {
          await client.badge.update({
            where: { id: "b1" },
            data: { note: "touched", holders: { connect: { id: "h1" } } },
          });
        },
        (error: unknown) =>
          error instanceof NestedWriteError &&
          error.message === NULL_CODE_HOLDERS
      );
      assert.deepEqual(await client.holder.findMany(), [
        { id: "h1", name: "one", badgeCode: "GOLD" },
      ]);
      // The parent's own SET is the sibling write the refusal stands ahead of.
      assert.deepEqual(await client.badge.findMany({ where: { id: "b1" } }), [
        { id: "b1", slug: "codeless", code: null, note: null },
      ]);
    });

    it("refuses a child-held CREATE under a parent whose reference reads null", async () => {
      // The produced value in the child-held direction: the member is created
      // holding NULL for the edge, which is not membership at all.
      const client = await world();
      await assert.rejects(
        async () => {
          await client.badge.update({
            where: { id: "b1" },
            data: { holders: { create: { id: "h3", name: "three" } } },
          });
        },
        (error: unknown) =>
          error instanceof NestedWriteError &&
          error.message === NULL_CODE_HOLDERS
      );
      assert.deepEqual(
        (await client.holder.findMany({ orderBy: { id: "asc" } })).map(
          (row) => row.id
        ),
        ["h1"]
      );
    });

    it("refuses a COMPOUND reference whose produced or parent-held member is null", async () => {
      const client = await world();
      // Produced: the create arm spells one member of the pair NULL.
      await assert.rejects(
        async () => {
          await client.gate.update({
            where: { id: "g1" },
            data: {
              label: "renamed",
              pass: {
                connectOrCreate: {
                  where: { id: "p9" },
                  create: { id: "p9", zone: "west", serial: null },
                },
              },
            },
          });
        },
        (error: unknown) =>
          error instanceof NestedWriteError && error.message === NULL_SERIAL
      );
      // Parent-held, child-held direction: `p1` holds NULL in one member.
      await assert.rejects(
        async () => {
          await client.pass.update({
            where: { id: "p1" },
            data: { gates: { connect: { id: "g1" } } },
          });
        },
        (error: unknown) =>
          error instanceof NestedWriteError &&
          error.message === NULL_SERIAL_GATES
      );
      assert.deepEqual(await client.gate.findMany(), [
        { id: "g1", label: "gate-1", passZone: "south", passSerial: "S2" },
      ]);
      assert.deepEqual(
        (await client.pass.findMany({ orderBy: { id: "asc" } })).map(
          (row) => row.id
        ),
        ["p1", "p2"]
      );
    });

    it("asks the same requirement at a NESTED placement and keeps the create root's own owner", async () => {
      const client = await world();
      // NESTED: the unrepresentable create arm one level down, under the
      // member's own update. The requirement is the record's, so its placement
      // in the tree is not a question it asks.
      await assert.rejects(
        async () => {
          await client.badge.update({
            where: { id: "b2" },
            data: {
              note: "outer",
              holders: {
                update: {
                  where: { id: "h1" },
                  data: {
                    name: "nested",
                    badge: {
                      connectOrCreate: {
                        where: { slug: "fresh" },
                        create: {
                          id: "b9",
                          slug: "fresh",
                          code: null,
                          note: null,
                        },
                      },
                    },
                  },
                },
              },
            },
          });
        },
        (error: unknown) =>
          error instanceof NestedWriteError && error.message === NULL_CODE
      );
      assert.deepEqual(await client.holder.findMany(), [
        { id: "h1", name: "one", badgeCode: "GOLD" },
      ]);
      assert.deepEqual(
        (await client.badge.findMany({ orderBy: { id: "asc" } })).map(
          (row) => row.id
        ),
        ["b1", "b2"]
      );
      // The CREATE ROOT keeps its existing owner and its existing sentence:
      // `Commands.assignMembership` already refuses a producer whose own
      // create data cannot supply the referenced field, at plan time, and this
      // unit does not take that answer over.
      await assert.rejects(
        async () => {
          await client.badge.create({
            data: {
              id: "b3",
              slug: "fresh",
              code: null,
              note: null,
              holders: { connect: { id: "h1" } },
            },
          });
        },
        (error: unknown) =>
          error instanceof UnsupportedOperationError &&
          error.message ===
            "query-engine-v2 create cannot resolve the parent id for relation 'holders': referenced field 'code' is neither this record's primary key nor a knowable value in its own create data."
      );
    });

    it("connects and disconnects in the child-held direction whenever the reference is representable", async () => {
      // The control that keeps the new direction from being a blanket refusal:
      // an explicit disconnect is legal, the same child-held `connect` against
      // a representable parent succeeds, and so does a child-held create.
      const client = await world();
      assert.deepEqual(
        await client.holder.update({
          where: { id: "h1" },
          data: { badge: { disconnect: true } },
        }),
        { id: "h1", name: "one", badgeCode: null }
      );
      await client.badge.update({
        where: { id: "b2" },
        data: { note: "kept", holders: { connect: { id: "h1" } } },
      });
      await client.badge.update({
        where: { id: "b2" },
        data: { holders: { create: { id: "h4", name: "four" } } },
      });
      assert.deepEqual(
        await client.holder.findMany({ orderBy: { id: "asc" } }),
        [
          { id: "h1", name: "one", badgeCode: "GOLD" },
          { id: "h4", name: "four", badgeCode: "GOLD" },
        ]
      );
      assert.deepEqual(await client.badge.findMany({ where: { id: "b2" } }), [
        { id: "b2", slug: "gold", code: "GOLD", note: "kept" },
      ]);
    });
  });
}

/**
 * What the SEGMENTED transports stand committed behind the refusal — measured,
 * not assumed.
 *
 * D-51's succession says what stands committed behind a planning refusal is
 * whatever an earlier flush already carried. For THIS requirement the answer
 * measured on both batch-only fixtures is *nothing*: the refusal stands ahead
 * of the first dispatch, so no segment was ever acknowledged, and the failure
 * accordingly claims no progress — and, just as importantly, claims no
 * rollback of a prefix it never made. `batchCalls === 0` is the discriminating
 * fact: an acknowledged prefix would be a dispatched batch.
 *
 * The two fixtures differ only in the transport fact D-53 names — a pinned
 * session that keeps the batch reference scratch across dispatches, and a
 * sessionless one that discards it — so both are run.
 */
const SEGMENTED = [
  ["session-pinned", () => new BatchOnlyDriver()],
  ["sessionless", () => new SessionlessBatchOnlyDriver()],
] as const;

for (const [transport, make] of SEGMENTED) {
  describe(`FC-02C: the ${transport} segmented transport's committed prefix`, () => {
    let driver: BatchOnlyDriver;
    afterEach(async () => {
      await driver?.disconnect();
    });

    it("claims neither progress nor a rollback, because nothing was dispatched", async () => {
      driver = make();
      const client = createClient({ schema, driver });
      await syncLiveSchema(client);
      await client.badge.create({
        data: { id: "b1", slug: "codeless", code: null, note: null },
      });
      await client.badge.create({
        data: { id: "b2", slug: "gold", code: "GOLD", note: null },
      });
      await client.holder.create({
        data: { id: "h1", name: "one", badgeCode: "GOLD" },
      });
      driver.reset();
      const failure = await client.holder
        .update({
          where: { id: "h1" },
          data: {
            name: "renamed",
            badge: {
              connectOrCreate: {
                where: { slug: "fresh" },
                create: { id: "b9", slug: "fresh", code: null, note: null },
              },
            },
          },
        })
        .then(
          () => undefined,
          (error: unknown) => error
        );
      assert.ok(failure instanceof NestedWriteError);
      assert.equal(failure.message, NULL_CODE);
      // No committed prefix is reported, because none exists: the failure
      // carries the relation it refused and no progress vocabulary at all.
      assert.equal(failure.meta.recordSeriesProgress, undefined);
      assert.equal(failure.meta.atomicity, undefined);
      // …and none exists because nothing was dispatched.
      assert.equal(driver.batchCalls, 0);
      assert.deepEqual(await client.holder.findMany(), [
        { id: "h1", name: "one", badgeCode: "GOLD" },
      ]);
      assert.deepEqual(
        (await client.badge.findMany({ orderBy: { id: "asc" } })).map(
          (row) => row.id
        ),
        ["b1", "b2"]
      );
    });
  });
}
