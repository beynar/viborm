import { s } from "@schema";
import { beforeEach, describe, expect, test } from "vitest";

/**
 * PACKAGE K — root `updateMany` whose `data` carries relations, as BEHAVIOR.
 *
 * Every claim here is one of plan §5.2's sentences, run against a real database on
 * whatever substrate the caller supplies:
 *
 *   · one ordinary selected-record update per captured root, sequentially, in one
 *     transaction — so parent-held folds, primary-key transitions and descendant
 *     ordering are each root's own, not a set's;
 *   · `count` is the CAPTURED ROOT count, never the provider's affected-row total;
 *   · an empty capture emits no effects;
 *   · returning reads use each member's FINAL row key, after ALL member effects;
 *   · one member may observe an earlier member's effects;
 *   · every member is constructed and every N-dependent check runs before the first
 *     write; a later deferred failure aborts and rolls the whole series back.
 *
 * The two boundaries the lift leaves are here too: the N>1 child-held membership
 * refusal, and the missing-final-read refusal for a root a later member removed.
 *
 * Deliberately NOT here: which SQL any of this compiles to. The plan shapes, step
 * ids and bytes are `parity-k-update-many.test.ts`'s (for the two arms K keeps
 * byte-identical, plus the capture) and `update-many-relation-series.test.ts`'s (for
 * the series' own routing and its PGlite-only statement traces).
 */
export const updateManySeriesSchema = (() => {
  const bin = s
    .model({
      id: s.int().id(),
      label: s.string(),
      // Child-held: the GADGET row stores which bin it is in, so `connect` here can
      // only mean one bin — the N>1 refusal's subject.
      gadgets: s.toMany(() => gadget),
      // Parent-held: the BIN row stores its own shelf, so N bins each get a copy.
      shelfId: s.int().nullable(),
      shelf: s
        .toOne(() => shelf)
        .fields("shelfId")
        .references("id"),
      // The junction is named explicitly: the generated name is derived from the two
      // MODEL KEYS, which the shared Docker database would hand to every other suite
      // whose models are also called `bin` and `zone`.
      zones: s.toMany(() => zone).through("kseries_bin_zone"),
      tickets: s.toMany(() => ticket),
    })
    .map("kseries_bins");

  const gadget = s
    .model({
      // PRODUCED identity, so a child-held `create` applied to N roots makes N
      // DISTINCT children rather than colliding on a literal the payload supplies.
      id: s.int().id().increment(),
      name: s.string(),
      binId: s.int().nullable(),
      bin: s
        .toOne(() => bin)
        .fields("binId")
        .references("id"),
    })
    .map("kseries_gadgets");

  const shelf = s
    .model({
      id: s.int().id(),
      room: s.string(),
      bins: s.toMany(() => bin),
    })
    .map("kseries_shelves");

  const zone = s
    .model({
      id: s.int().id(),
      name: s.string(),
      // One endpoint owns every junction override (R011).
      bins: s.toMany(() => bin),
    })
    .map("kseries_zones");

  /**
   * A CLIENT-GENERATED identity. Its default is a THUNK the object primitive runs on
   * every parse of an absent key, so it is the shape that decides how a series member
   * gets its data: parsed once and shared, N nested creates would all carry one
   * materialized ULID and collide on the first duplicate.
   */
  const ticket = s
    .model({
      id: s.string().id().ulid(),
      note: s.string(),
      binId: s.int().nullable(),
      bin: s
        .toOne(() => bin)
        .fields("binId")
        .references("id"),
    })
    .map("kseries_tickets");

  /**
   * A SELF-RELATION, and the only schema shape that can reach the two failure
   * families §6 K6 asks about: a member whose nested effects remove ANOTHER captured
   * root, and two roots transitioning onto one identity.
   */
  const node = s
    .model({
      id: s.int().id(),
      label: s.string(),
      parentId: s.int().nullable(),
      parent: s
        .toOne(() => node)
        .fields("parentId")
        .references("id"),
      children: s.toMany(() => node),
    })
    .map("kseries_nodes");

  return { bin, gadget, shelf, zone, ticket, node };
})();

export function registerUpdateManySeriesBehavior(
  name: string,
  getClient: () => Promise<any>,
  describeFn: (name: string, body: () => void) => void = describe
): void {
  describeFn(`Package K relation-bearing updateMany (${name})`, () => {
    let client: any;

    beforeEach(async () => {
      client = await getClient();
      // Children before parents: every suite shares one migrated database and each
      // test starts from an empty one.
      await client.node.updateMany({ data: { parentId: null } });
      for (const model of [
        "node",
        "gadget",
        "ticket",
        "zone",
        "bin",
        "shelf",
      ]) {
        await client[model].deleteMany({});
      }
    });

    const seedBins = async () => {
      await client.shelf.create({ data: { id: 1, room: "north" } });
      await client.shelf.create({ data: { id: 2, room: "south" } });
      await client.bin.create({ data: { id: 1, label: "one" } });
      await client.bin.create({ data: { id: 2, label: "two" } });
      await client.bin.create({ data: { id: 3, label: "three" } });
    };

    test("a parent-held fold rides EACH root's own UPDATE, and count is the root count", async () => {
      await seedBins();

      const result = await client.bin.updateMany({
        where: { id: { in: [1, 2] } },
        data: { label: "moved", shelf: { connect: { id: 1 } } },
      });

      // Two captured roots, two applied updates — and the FK landed in the same
      // statement as the scalar, per root, which is the whole reason §5.2 forbids
      // one set-based UPDATE followed by relation Parts.
      expect(result).toEqual({ count: 2 });
      await expect(
        client.bin.findMany({
          orderBy: { id: "asc" },
          select: { id: true, label: true, shelfId: true },
        })
      ).resolves.toEqual([
        { id: 1, label: "moved", shelfId: 1 },
        { id: 2, label: "moved", shelfId: 1 },
        { id: 3, label: "three", shelfId: null },
      ]);
    });

    test("count is the CAPTURED root count even when no column changes", async () => {
      await seedBins();
      // §5.2 names this case: MySQL reports ZERO affected rows for an assignment that
      // changes nothing (mysql2 does not set CLIENT_FOUND_ROWS), so a provider count
      // would answer 0 here on one dialect and 2 on the others. The captured count is
      // the same number everywhere.
      const result = await client.bin.updateMany({
        where: { id: { in: [1, 2] } },
        data: { label: undefined, shelf: { disconnect: true } },
      });
      expect(result).toEqual({ count: 2 });

      // …and again with a scalar assignment to the value the row already carries.
      await expect(
        client.bin.updateMany({
          where: { id: 1 },
          data: { label: "one", shelf: { disconnect: true } },
        })
      ).resolves.toEqual({ count: 1 });
    });

    test("an empty capture emits no effects and answers zero", async () => {
      await seedBins();
      await expect(
        client.bin.updateMany({
          where: { label: "nothing matches" },
          data: { label: "x", shelf: { connect: { id: 1 } } },
        })
      ).resolves.toEqual({ count: 0 });
      await expect(
        client.shelf.findMany({ select: { id: true } })
      ).resolves.toHaveLength(2);
    });

    test("limit caps the captured roots, and the count follows it", async () => {
      await seedBins();
      const result = await client.bin.updateMany({
        data: { label: "capped", shelf: { connect: { id: 2 } } },
        limit: 2,
      });
      expect(result).toEqual({ count: 2 });
      const moved = await client.bin.findMany({ where: { label: "capped" } });
      expect(moved).toHaveLength(2);
    });

    test("limit: 0 touches nothing at all", async () => {
      await seedBins();
      await expect(
        client.bin.updateMany({
          data: { label: "never", shelf: { connect: { id: 1 } } },
          limit: 0,
        })
      ).resolves.toEqual({ count: 0 });
      await expect(
        client.bin.findMany({ where: { label: "never" } })
      ).resolves.toEqual([]);
    });

    test("a child-held create makes ONE fresh child per root", async () => {
      await seedBins();
      // `create` is deliberately NOT in the refused set: one fresh child per root is
      // exactly N children, each owned by its own root. This is also the witness for
      // the parse decision — every member parses the shared RAW data ITSELF, so the
      // two children get two identities rather than one shared materialized default.
      const result = await client.bin.updateMany({
        where: { id: { in: [1, 2] } },
        data: { gadgets: { create: { name: "spare" } } },
      });

      expect(result).toEqual({ count: 2 });
      const gadgets = await client.gadget.findMany({
        orderBy: { binId: "asc" },
        select: { name: true, binId: true },
      });
      expect(gadgets).toEqual([
        { name: "spare", binId: 1 },
        { name: "spare", binId: 2 },
      ]);
    });

    test("each root's nested create gets its OWN client-generated identity", async () => {
      await seedBins();

      // THE MEASUREMENT BEHIND K5's AMENDMENT. Plan §6 K5 said members share one
      // immutable parse of `data`; a ULID default is a THUNK the object primitive
      // runs on every parse of an absent key, so one shared parse would hand both
      // roots the SAME ticket id and the second member's INSERT would violate the
      // primary key. Members parse the shared RAW data themselves, and this is what
      // says so: two roots, two distinct identities, one call.
      const result = await client.bin.updateMany({
        where: { id: { in: [1, 2] } },
        data: { tickets: { create: { note: "auto" } } },
      });

      expect(result).toEqual({ count: 2 });
      const tickets = await client.ticket.findMany({
        orderBy: { binId: "asc" },
        select: { id: true, binId: true },
      });
      expect(tickets.map((row: any) => row.binId)).toEqual([1, 2]);
      expect(new Set(tickets.map((row: any) => row.id)).size).toBe(2);
    });

    test("nested updateMany reparses defaults once per selected target", async () => {
      await seedBins();
      await client.bin.updateMany({
        where: { id: { in: [1, 2] } },
        data: { shelfId: 1 },
      });

      const result = await client.shelf.update({
        where: { id: 1 },
        data: {
          bins: {
            updateMany: {
              where: { id: { in: [1, 2] } },
              data: { tickets: { create: { note: "nested" } } },
            },
          },
        },
      });

      expect(result.id).toBe(1);
      const tickets = await client.ticket.findMany({
        orderBy: { binId: "asc" },
        select: { id: true, binId: true },
      });
      expect(tickets.map((row: any) => row.binId)).toEqual([1, 2]);
      expect(new Set(tickets.map((row: any) => row.id)).size).toBe(2);
    });

    test("nested updateMany applies N=0/N=1 and refuses an impossible N>1 move", async () => {
      await seedBins();
      await client.bin.updateMany({
        where: { id: { in: [1, 2] } },
        data: { shelfId: 1 },
      });
      await client.gadget.create({ data: { id: 1, name: "shared" } });

      await client.shelf.update({
        where: { id: 1 },
        data: {
          bins: {
            updateMany: {
              where: { id: 999 },
              data: { gadgets: { connect: [{ id: 1 }] } },
            },
          },
        },
      });
      await expect(
        client.gadget.findUnique({ where: { id: 1 } })
      ).resolves.toMatchObject({ binId: null });

      await client.shelf.update({
        where: { id: 1 },
        data: {
          bins: {
            updateMany: {
              where: { id: 1 },
              data: { gadgets: { connect: [{ id: 1 }] } },
            },
          },
        },
      });
      await expect(
        client.gadget.findUnique({ where: { id: 1 } })
      ).resolves.toMatchObject({ binId: 1 });

      await expect(
        client.shelf.update({
          where: { id: 1 },
          data: {
            room: "must roll back",
            bins: {
              updateMany: {
                where: { id: { in: [1, 2] } },
                data: { gadgets: { connect: [{ id: 1 }] } },
              },
            },
          },
        })
      ).rejects.toThrow("updateMany matched 2 rows");
      await expect(
        client.shelf.findUnique({ where: { id: 1 } })
      ).resolves.toMatchObject({ room: "north" });
      await expect(
        client.gadget.findUnique({ where: { id: 1 } })
      ).resolves.toMatchObject({ binId: 1 });
    });

    test("a later nested updateMany member failure rolls back the prefix and earlier members", async () => {
      await seedBins();
      await client.bin.updateMany({
        where: { id: { in: [1, 2] } },
        data: { shelfId: 1 },
      });

      await expect(
        client.shelf.update({
          where: { id: 1 },
          data: {
            room: "must roll back",
            bins: {
              updateMany: {
                where: { id: { in: [1, 2] } },
                data: {
                  tickets: {
                    create: { id: "same-ticket", note: "collision" },
                  },
                },
              },
            },
          },
        })
      ).rejects.toThrow();

      await expect(
        client.shelf.findUnique({ where: { id: 1 } })
      ).resolves.toMatchObject({ room: "north" });
      await expect(client.ticket.findMany()).resolves.toEqual([]);
    });

    test("a junction link is meaningful for every root and is applied to all of them", async () => {
      await seedBins();
      await client.zone.create({ data: { id: 1, name: "cold" } });

      const result = await client.bin.updateMany({
        where: { id: { in: [1, 2, 3] } },
        data: { zones: { connect: [{ id: 1 }] } },
      });

      // A junction stores membership in a third table that admits many parents, so
      // N roots may each link the SAME target. This is the shape §5.2 keeps.
      expect(result).toEqual({ count: 3 });
      await expect(
        client.bin.findMany({
          orderBy: { id: "asc" },
          select: { id: true, zones: { select: { id: true } } },
        })
      ).resolves.toEqual([
        { id: 1, zones: [{ id: 1 }] },
        { id: 2, zones: [{ id: 1 }] },
        { id: 3, zones: [{ id: 1 }] },
      ]);
    });

    test("a child-held connect across TWO roots is refused before the first write", async () => {
      await seedBins();
      await client.gadget.create({ data: { id: 1, name: "widget" } });

      await expect(
        client.bin.updateMany({
          where: { id: { in: [1, 2] } },
          data: { label: "claimed", gadgets: { connect: [{ id: 1 }] } },
        })
      ).rejects.toThrow("updateMany matched 2 rows");

      // NOTHING ran: not the scalar half of the first root's update, not the link.
      await expect(
        client.bin.findMany({
          orderBy: { id: "asc" },
          select: { id: true, label: true },
        })
      ).resolves.toEqual([
        { id: 1, label: "one" },
        { id: 2, label: "two" },
        { id: 3, label: "three" },
      ]);
      await expect(
        client.gadget.findUnique({ where: { id: 1 } })
      ).resolves.toMatchObject({ binId: null });
    });

    test("the SAME payload at ONE captured root means what a single update means", async () => {
      await seedBins();
      await client.gadget.create({ data: { id: 1, name: "widget" } });

      await expect(
        client.bin.updateMany({
          where: { id: 1 },
          data: { label: "claimed", gadgets: { connect: [{ id: 1 }] } },
        })
      ).resolves.toEqual({ count: 1 });
      await expect(
        client.gadget.findUnique({ where: { id: 1 } })
      ).resolves.toMatchObject({ binId: 1 });
    });

    test("an EMPTY child-held collection is not a membership move, at any N", async () => {
      // The refusal is about contention over a NAMED target. `set: []` names none:
      // it says "this root keeps no gadgets", which is a per-root fact and exactly
      // what the same payload does spelled as one ordinary `update` per row. It is
      // also not hypothetical — `set: []` is how a caller clears a to-many.
      await seedBins();
      await client.gadget.create({
        data: { id: 1, name: "widget", binId: 1 },
      });
      await client.gadget.create({
        data: { id: 2, name: "gizmo", binId: 2 },
      });

      await expect(
        client.bin.updateMany({
          where: { id: { in: [1, 2] } },
          data: { label: "cleared", gadgets: { set: [] } },
        })
      ).resolves.toEqual({ count: 2 });
      // EACH root cleared its OWN children — no root took anything from another.
      await expect(
        client.gadget.findMany({ orderBy: { id: "asc" } })
      ).resolves.toMatchObject([
        { id: 1, binId: null },
        { id: 2, binId: null },
      ]);

      // The two empty spellings that mean nothing at all are equally unrefused.
      await expect(
        client.bin.updateMany({
          where: { id: { in: [1, 2] } },
          data: { gadgets: { connect: [], connectOrCreate: [] } },
        })
      ).resolves.toEqual({ count: 2 });

      // ONE named target is all it takes to reach the refusal again.
      await expect(
        client.bin.updateMany({
          where: { id: { in: [1, 2] } },
          data: { gadgets: { set: [{ id: 1 }] } },
        })
      ).rejects.toThrow("updateMany matched 2 rows");
    });

    test("a composed connect+update pair is refused at N>1 just like a bare connect", async () => {
      // Package H's lattice lets a supplier travel beside a modifier, and its
      // composition owner keeps the supplier's own kind — so a composed pair applied
      // to N roots is the same child stolen N times. The scan sees it because it
      // reads RAW entries, before composition.
      await seedBins();
      await client.gadget.create({ data: { id: 1, name: "widget" } });

      await expect(
        client.bin.updateMany({
          where: { id: { in: [1, 2] } },
          data: {
            gadgets: {
              connect: [{ id: 1 }],
              update: [{ where: { id: 1 }, data: { name: "renamed" } }],
            },
          },
        })
      ).rejects.toThrow("updateMany matched 2 rows");
      await expect(
        client.gadget.findUnique({ where: { id: 1 } })
      ).resolves.toMatchObject({ name: "widget", binId: null });
    });

    test("a returning projection is read AFTER every member's effects", async () => {
      await client.node.create({ data: { id: 2, label: "parent" } });
      await client.node.create({
        data: { id: 1, label: "child", parentId: 2 },
      });

      // Member 1 (node 1, first in row-key order) writes `label: "seen"` on itself.
      // Member 2 then relabels ITS children, which includes node 1 — rewriting the
      // very column node 1's own projection reads. If the projection were read as
      // each member finished, node 1 would answer "seen".
      const rows = await client.node.updateMany({
        where: { id: { in: [1, 2] } },
        data: {
          label: "seen",
          children: { updateMany: { where: {}, data: { label: "touched" } } },
        },
        select: { id: true, label: true },
      });

      expect(rows).toEqual([
        { id: 1, label: "touched" },
        { id: 2, label: "seen" },
      ]);
    });

    test("the returning rows come back in deterministic captured order", async () => {
      await seedBins();
      const rows = await client.bin.updateMany({
        where: { id: { in: [3, 1, 2] } },
        data: { label: "ordered", shelf: { connect: { id: 1 } } },
        select: { id: true },
      });
      // Row-key order, not filter order and not physical order.
      expect(rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    });

    test("omit and scalar casts survive the series' own read", async () => {
      await seedBins();
      const rows = await client.bin.updateMany({
        where: { id: { in: [1, 2] } },
        data: { label: "kept", shelf: { connect: { id: 2 } } },
        omit: { label: true },
      });
      expect(rows).toEqual([
        { id: 1, shelfId: 2 },
        { id: 2, shelfId: 2 },
      ]);
    });

    test("one member observes an earlier member's effects", async () => {
      // Node 1 becomes node 2's child through member 1's own `parent` fold; member 2
      // then reads its children and finds node 1 already there, so its `deleteMany`
      // removes a row that only exists as a child because an EARLIER member put it
      // there. That is "one member may observe the completed effects of an earlier
      // member", spelled with an effect rather than a probe.
      await client.node.create({ data: { id: 1, label: "a" } });
      await client.node.create({ data: { id: 2, label: "b" } });
      await client.node.create({ data: { id: 3, label: "c", parentId: 2 } });

      const result = await client.node.updateMany({
        where: { id: { in: [1, 2] } },
        data: { children: { deleteMany: {} } },
      });

      expect(result).toEqual({ count: 2 });
      // Node 3 was node 2's child and is gone; nodes 1 and 2 remain.
      await expect(
        client.node.findMany({ orderBy: { id: "asc" }, select: { id: true } })
      ).resolves.toEqual([{ id: 1 }, { id: 2 }]);
    });

    test("a captured root REMOVED by a later member refuses on the select arm", async () => {
      // THE DECISION §6 K6 asks for, witnessed. Node 1 sorts first, so its member
      // runs and succeeds; node 2's member then deletes its children, which includes
      // node 1. The final reads address each member's reported row key, and node 1's
      // no longer names a row.
      //
      // The engine REFUSES rather than hand back a plausible shorter list, because
      // when the same removal happens BEFORE the victim's member runs the engine
      // already fails loudly at that member's own locate — so a legal-empty read
      // would make the public answer depend on capture order alone.
      await client.node.create({ data: { id: 2, label: "b" } });
      await client.node.create({ data: { id: 1, label: "a", parentId: 2 } });

      await expect(
        client.node.updateMany({
          where: { id: { in: [1, 2] } },
          data: { label: "x", children: { deleteMany: {} } },
          select: { id: true, label: true },
        })
      ).rejects.toThrow(
        "updateMany with 'select' could not read back one of the updated rows"
      );

      // Everything rolled back, including the member that had succeeded.
      await expect(
        client.node.findMany({
          orderBy: { id: "asc" },
          select: { id: true, label: true },
        })
      ).resolves.toEqual([
        { id: 1, label: "a" },
        { id: 2, label: "b" },
      ]);
    });

    test("…and the { count } arm of the SAME payload answers the captured count", async () => {
      // The other half of the same decision: `count` is the captured root count, so
      // it answers 2 even though one of those roots no longer exists afterwards. The
      // arms disagree about whether the call SUCCEEDS, and that is deliberate — the
      // `select` arm has rows it cannot produce, the `{ count }` arm does not.
      await client.node.create({ data: { id: 2, label: "b" } });
      await client.node.create({ data: { id: 1, label: "a", parentId: 2 } });

      await expect(
        client.node.updateMany({
          where: { id: { in: [1, 2] } },
          data: { label: "x", children: { deleteMany: {} } },
        })
      ).resolves.toEqual({ count: 2 });
      await expect(
        client.node.findMany({ select: { id: true } })
      ).resolves.toEqual([{ id: 2 }]);
    });

    test("two roots converging on ONE identity abort the whole transaction", async () => {
      await client.node.create({ data: { id: 1, label: "a" } });
      await client.node.create({ data: { id: 2, label: "b" } });
      await client.node.create({ data: { id: 9, label: "target" } });

      await expect(
        client.node.updateMany({
          where: { id: { in: [1, 2] } },
          data: { id: { set: 5 }, parent: { connect: { id: 9 } } },
        })
      ).rejects.toThrow();

      // The first member's transition rolled back with the second's violation.
      await expect(
        client.node.findMany({ orderBy: { id: "asc" }, select: { id: true } })
      ).resolves.toEqual([{ id: 1 }, { id: 2 }, { id: 9 }]);
    });

    test("a primary-key transition writes descendants with the TRANSITIONED value", async () => {
      await client.node.create({ data: { id: 10, label: "root" } });

      const result = await client.node.updateMany({
        where: { id: 10 },
        data: {
          id: { increment: 5 },
          children: { create: { id: 12, label: "fresh" } },
        },
      });

      expect(result).toEqual({ count: 1 });
      // §5.2: "a parent key transition reads the old captured value and writes
      // descendants with the transitioned value". The fresh child points at 15, the
      // key the root MOVED to — not at 10, the key the member located it by.
      await expect(
        client.node.findMany({
          orderBy: { id: "asc" },
          select: { id: true, label: true, parentId: true },
        })
      ).resolves.toEqual([
        { id: 12, label: "fresh", parentId: 15 },
        { id: 15, label: "root", parentId: null },
      ]);
    });

    test("a mid-member failure rolls back every earlier member", async () => {
      await seedBins();

      await expect(
        client.bin.updateMany({
          where: { id: { in: [1, 2] } },
          // Root 1's member succeeds; root 2's nested update names a gadget that does
          // not exist, and the failure takes root 1's write with it.
          data: {
            label: "attempted",
            gadgets: {
              update: [{ where: { id: 404 }, data: { name: "ghost" } }],
            },
          },
        })
      ).rejects.toThrow();

      await expect(
        client.bin.findMany({
          orderBy: { id: "asc" },
          select: { id: true, label: true },
        })
      ).resolves.toEqual([
        { id: 1, label: "one" },
        { id: 2, label: "two" },
        { id: 3, label: "three" },
      ]);
    });

    test("inside an interactive transaction, a failed series takes back ONLY its own effects", async () => {
      // The series always opens a scope of its OWN — a SAVEPOINT when the caller
      // already holds one (Package I). The caller's work on both sides survives and
      // the enclosing transaction is still usable afterwards.
      await seedBins();

      let refusal: unknown;
      await client.$transaction(async (tx: any) => {
        await tx.shelf.create({ data: { id: 3, room: "before" } });
        try {
          await tx.bin.updateMany({
            where: { id: { in: [1, 2] } },
            data: {
              label: "attempted",
              gadgets: {
                update: [{ where: { id: 404 }, data: { name: "ghost" } }],
              },
            },
          });
        } catch (error) {
          refusal = error;
        }
        await tx.shelf.create({ data: { id: 4, room: "after" } });
      });

      expect(refusal).toBeInstanceOf(Error);
      await expect(
        client.bin.findMany({ where: { label: "attempted" } })
      ).resolves.toEqual([]);
      await expect(
        client.shelf.findMany({
          orderBy: { id: "asc" },
          select: { room: true },
        })
      ).resolves.toEqual([
        { room: "north" },
        { room: "south" },
        { room: "before" },
        { room: "after" },
      ]);
    });

    test("inside an interactive transaction, a series that SUCCEEDS still rolls back with the caller", async () => {
      await seedBins();
      await expect(
        client.$transaction(async (tx: any) => {
          await tx.bin.updateMany({
            where: { id: 1 },
            data: { label: "committed?", shelf: { connect: { id: 1 } } },
          });
          throw new Error("caller aborts");
        })
      ).rejects.toThrow("caller aborts");

      await expect(
        client.bin.findUnique({
          where: { id: 1 },
          select: { label: true, shelfId: true },
        })
      ).resolves.toEqual({ label: "one", shelfId: null });
    });

    test("scalar-only data keeps the one-statement arm and the provider's own count", async () => {
      await seedBins();
      // The fast path, unchanged, on the same substrate — including a `select` arm
      // that never becomes a series.
      await expect(
        client.bin.updateMany({
          where: { id: { in: [1, 2] } },
          data: { label: "flat" },
        })
      ).resolves.toEqual({ count: 2 });
      await expect(
        client.bin.updateMany({
          where: { id: 3 },
          data: { label: "flat too" },
          select: { id: true, label: true },
        })
      ).resolves.toEqual([{ id: 3, label: "flat too" }]);
    });
  });
}
