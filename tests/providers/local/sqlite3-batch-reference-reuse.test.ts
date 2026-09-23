/**
 * The BATCH route's half of the shared FOUND-consumption rule: the reference a
 * holder spends out of a located row is the row's OWN, at the moment it is
 * spent — credential-free.
 *
 * Repair prompt §1 (`docs/architecture/raptor3-local-closure-repair-2-prompt.md`).
 * U1 closed the rule on the interactive route and recorded this half as open
 * (`g4/release/closure-repair/u1/note.md` §11, "The CURRENT-reference half of
 * the rule is interactive-only on this tree"): on the batch route
 * `CommandExecution.confirmFound` takes no read, so a PARENT-held
 * `connectOrCreate` whose probe FOUND its target bound the probe's literal
 * bytes, and the holder's own statement spent them. What the unit states as
 * premises is the row's IDENTITY, its membership and its matched condition —
 * never the referenced COLUMN — so a key recycled between the plan-time probe
 * and the batch moved the connection to whichever row had acquired it.
 *
 * THE SCHEDULE. `b1(slug: "chosen", code: "G")` is observed; before the batch,
 * `b1.code` becomes `"M"` and a new `b2(slug: "unselected", code: "G")` is
 * created. The holder asked for the row its selector names — `b1` — and must
 * connect `b1` or fail; it must never connect `b2`, which acquired the bytes
 * and nothing else.
 *
 * WHAT THIS FILE IS NOT. SQLite carries one connection, so the drift is not a
 * concurrent commit: it is applied from the transport's own hook, at the two
 * positions that exist on this route — before the unit (the plan-time window)
 * and between the unit's last premise and its first write (the window a batch
 * premise cannot close, because a premise and the effect it protects are two
 * statements and this substrate's select assembly omits `FOR UPDATE`). The
 * native measurement, on two real PostgreSQL connections through the
 * repository's forced batch profile, is
 * `tests/providers/docker/pg-batch-reference-reuse.test.ts`.
 *
 * Both batch fixtures run every cell: `BatchOnlyDriver` keeps one session (and
 * therefore its batch-reference scratch) across dispatches, `SessionlessBatchOnlyDriver`
 * discards it (D-53). The reference this rule reads is a sub-select inside the
 * consuming statement, not a scratch value, so the two must answer alike.
 */

import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { NestedWriteError } from "@errors";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import {
  BatchOnlyDriver,
  SessionlessBatchOnlyDriver,
} from "@tests/raptor3/g4/parity/batch-only-drivers";
import { afterEach, describe, it } from "vitest";

/** The single-member bed: `code` is the referenced unique, `slug` the selector. */
const badge = s
  .model({
    id: s.string().id(),
    slug: s.string().unique(),
    code: s.string().nullable().unique(),
    holders: s.toMany(() => holder),
  })
  .map("te_brr_badges");
const holder = s
  .model({
    id: s.string().id(),
    name: s.string(),
    badgeCode: s.string().nullable(),
    badge: s
      .toOne(() => badge)
      .fields("badgeCode")
      .references("code"),
    office: s
      .toOne(() => office)
      .fields("officeId")
      .references("id"),
    officeId: s.string().nullable(),
  })
  .map("te_brr_holders");
/** The NESTED placement: the holder that spends the reference is itself nested. */
const office = s
  .model({
    id: s.string().id(),
    label: s.string(),
    holders: s.toMany(() => holder),
  })
  .map("te_brr_offices");
/** The COMPOUND bed: the referenced key is a mapped, two-member unique. */
const pass = s
  .model({
    id: s.string().id(),
    zone: s.string(),
    serial: s.string().nullable(),
    gates: s.toMany(() => gate),
  })
  .unique(["zone", "serial"])
  .map("te_brr_passes");
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
  .map("te_brr_gates");

/** The JUNCTION placement: the captured pair is not the holder's own field. */
const tag = s
  .model({
    id: s.string().id(),
    slug: s.string().unique(),
    code: s.string().nullable().unique(),
    posts: s.toMany(() => post),
  })
  .map("te_brr_tags");
const post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    tags: s.toMany(() => tag).through("te_brr_post_tags"),
  })
  .map("te_brr_posts");

const schema = { badge, gate, holder, office, pass, post, tag };

/** The replacement race the `connectOrCreate` arm already owns. */
const REPLACED =
  "Record was replaced by another transaction during nested connectOrCreate";
const NULL_CODE =
  "Cannot connect relation 'badge': the located target's referenced field 'code' is null.";

/** The junction statement this bed's tag placement writes. */
const JUNCTION_INSERT = /insert\s+into\s+"?te_brr_post_tags/i;
/** Any sub-select inside a statement: what the fold would introduce. */
const SUB_SELECT = /\bselect\b/i;

const FIXTURES = [
  ["session-keeping", () => new BatchOnlyDriver()],
  ["sessionless", () => new SessionlessBatchOnlyDriver()],
] as const;

for (const [fixture, make] of FIXTURES) {
  describe(`batch reference reuse on the ${fixture} batch transport`, () => {
    let driver: BatchOnlyDriver;
    afterEach(async () => {
      await driver?.disconnect();
    });

    async function world() {
      driver = make();
      const client = createClient({ schema, driver });
      await syncLiveSchema(client);
      await client.badge.create({
        data: { id: "b1", slug: "chosen", code: "G" },
      });
      await client.office.create({ data: { id: "o1", label: "north" } });
      await client.holder.create({
        data: { id: "h1", name: "one", badgeCode: null, officeId: "o1" },
      });
      await client.pass.create({
        data: { id: "p1", zone: "north", serial: "S1" },
      });
      await client.gate.create({
        data: { id: "g1", label: "gate-1", passZone: null, passSerial: null },
      });
      await client.tag.create({
        data: { id: "t1", slug: "chosen", code: "T" },
      });
      await client.post.create({ data: { id: "po1", title: "post-1" } });
      driver.reset();
      return client;
    }

    /** The recycled key, as one statement pair the hook applies. */
    const recycle = (database: import("better-sqlite3").Database) => {
      database
        .prepare("UPDATE te_brr_badges SET code = 'M' WHERE id = 'b1'")
        .run();
      database
        .prepare(
          "INSERT INTO te_brr_badges (id, slug, code) VALUES ('b2', 'unselected', 'G')"
        )
        .run();
    };

    const connectChosen = {
      connectOrCreate: {
        where: { slug: "chosen" },
        create: { id: "b9", slug: "chosen", code: "NEW" },
      },
    };

    it("spends the intended row's CURRENT reference when the key is recycled before the unit", async () => {
      // THE WITNESS. At the base the holder's UPDATE spent the probe's literal
      // `G`, which `b2` had acquired, so the holder became a member of `b2` —
      // a row its selector never named.
      const client = await world();
      driver.plant = recycle;
      assert.deepEqual(
        await client.holder.update({
          where: { id: "h1" },
          data: { name: "connected", badge: connectChosen },
        }),
        { id: "h1", name: "connected", badgeCode: "M", officeId: "o1" }
      );
      // The connection is `b1`'s, read at the write: `b2` holds the bytes the
      // probe saw and is a member of nothing.
      assert.deepEqual(
        (
          await client.badge.findMany({
            include: { holders: true },
            orderBy: { id: "asc" },
          })
        ).map((row) => [row.id, row.holders.map((held) => held.id)]),
        [
          ["b1", ["h1"]],
          ["b2", []],
        ]
      );
    });

    it("spends the intended row's CURRENT reference when the key is recycled BETWEEN the unit's premise and its write", async () => {
      // The window a batch premise cannot close on this substrate: the premise
      // has answered, and the statement it stands in front of has not run. The
      // value is read INSIDE that statement, so it is the row's own either way.
      const client = await world();
      driver.plantBeforeFirstWrite = recycle;
      assert.deepEqual(
        await client.holder.update({
          where: { id: "h1" },
          data: { name: "connected", badge: connectChosen },
        }),
        { id: "h1", name: "connected", badgeCode: "M", officeId: "o1" }
      );
      assert.deepEqual(
        (
          await client.badge.findMany({
            include: { holders: true },
            orderBy: { id: "asc" },
          })
        ).map((row) => [row.id, row.holders.map((held) => held.id)]),
        [
          ["b1", ["h1"]],
          ["b2", []],
        ]
      );
    });

    it("does not adopt a replacement row that acquires the SELECTOR after the premise", async () => {
      // Why the fold reads at the located IDENTITY and never at the arm's own
      // selector: the premise proves that THIS row still satisfies the
      // selector, and it proves it once. A row that acquires the selector
      // afterwards answers a selector-based sub-select and is not the row this
      // operation located — which is exactly what the shipped fold of a
      // parent-held `connect` may do where its probe kept no lock.
      const client = await world();
      driver.plantBeforeFirstWrite = (database) => {
        database
          .prepare("UPDATE te_brr_badges SET slug = 'moved' WHERE id = 'b1'")
          .run();
        database
          .prepare(
            "INSERT INTO te_brr_badges (id, slug, code) VALUES ('b2', 'chosen', 'H')"
          )
          .run();
      };
      assert.deepEqual(
        await client.holder.update({
          where: { id: "h1" },
          data: { name: "connected", badge: connectChosen },
        }),
        { id: "h1", name: "connected", badgeCode: "G", officeId: "o1" }
      );
      assert.deepEqual(
        (
          await client.badge.findMany({
            include: { holders: true },
            orderBy: { id: "asc" },
          })
        ).map((row) => [row.id, row.holders.map((held) => held.id)]),
        [
          ["b1", ["h1"]],
          ["b2", []],
        ]
      );
    });

    it("spends the intended row's CURRENT reference from a ROOT create's own INSERT", async () => {
      const client = await world();
      driver.plant = recycle;
      assert.deepEqual(
        await client.holder.create({
          data: { id: "h2", name: "two", officeId: "o1", badge: connectChosen },
        }),
        { id: "h2", name: "two", badgeCode: "M", officeId: "o1" }
      );
      assert.deepEqual(
        (
          await client.badge.findMany({
            include: { holders: true },
            orderBy: { id: "asc" },
          })
        ).map((row) => [row.id, row.holders.map((held) => held.id)]),
        [
          ["b1", ["h2"]],
          ["b2", []],
        ]
      );
    });

    it("spends the intended row's CURRENT reference at a NESTED placement", async () => {
      const client = await world();
      driver.plant = recycle;
      assert.deepEqual(
        await client.office.update({
          where: { id: "o1" },
          data: {
            label: "renamed",
            holders: {
              create: { id: "h3", name: "three", badge: connectChosen },
            },
          },
          include: { holders: { orderBy: { id: "asc" } } },
        }),
        {
          id: "o1",
          label: "renamed",
          holders: [
            { id: "h1", name: "one", badgeCode: null, officeId: "o1" },
            { id: "h3", name: "three", badgeCode: "M", officeId: "o1" },
          ],
        }
      );
    });

    it("spends a COMPOUND reference at the intended row's current pair, both members", async () => {
      const client = await world();
      driver.plant = (database) => {
        database
          .prepare("UPDATE te_brr_passes SET serial = 'S9' WHERE id = 'p1'")
          .run();
        database
          .prepare(
            "INSERT INTO te_brr_passes (id, zone, serial) VALUES ('p2', 'north', 'S1')"
          )
          .run();
      };
      assert.deepEqual(
        await client.gate.update({
          where: { id: "g1" },
          data: {
            label: "moved",
            pass: {
              connectOrCreate: {
                where: { id: "p1" },
                create: { id: "p9", zone: "north", serial: "S1" },
              },
            },
          },
        }),
        {
          id: "g1",
          label: "moved",
          passZone: "north",
          passSerial: "S9",
        }
      );
      assert.deepEqual(
        (
          await client.pass.findMany({
            include: { gates: true },
            orderBy: { id: "asc" },
          })
        ).map((row) => [row.id, row.gates.map((held) => held.id)]),
        [
          ["p1", ["g1"]],
          ["p2", []],
        ]
      );
    });

    it("aborts the unit with the arm's own failure when the located target disappears", async () => {
      const client = await world();
      driver.plant = (database) => {
        database.prepare("DELETE FROM te_brr_badges WHERE id = 'b1'").run();
        database
          .prepare(
            "INSERT INTO te_brr_badges (id, slug, code) VALUES ('b2', 'unselected', 'G')"
          )
          .run();
      };
      await assert.rejects(
        async () => {
          await client.holder.update({
            where: { id: "h1" },
            data: { name: "connected", badge: connectChosen },
          });
        },
        (error: unknown) =>
          error instanceof NestedWriteError && error.message === REPLACED
      );
      // Nothing of the unit stands: no rename, no connection, no create arm.
      assert.deepEqual(await client.holder.findMany(), [
        { id: "h1", name: "one", badgeCode: null, officeId: "o1" },
      ]);
      assert.deepEqual(
        (await client.badge.findMany({ orderBy: { id: "asc" } })).map(
          (row) => row.id
        ),
        ["b2"]
      );
    });

    it("never writes the NULL a reference transitions to", async () => {
      // The fold's own value is a sub-select, so the literal R1 was asked
      // about is gone by the time the statement runs; the complement premise
      // asks the same requirement of the row the sub-select will read, inside
      // the unit, and carries R1's own sentence. At the base this reached the
      // provider as a foreign-key violation on a key the engine chose (`G`,
      // which `b1` no longer held) — or, where another row had acquired it,
      // as a silent connection to that row.
      const client = await world();
      driver.plant = (database) => {
        database
          .prepare("UPDATE te_brr_badges SET code = NULL WHERE id = 'b1'")
          .run();
      };
      await assert.rejects(
        async () => {
          await client.holder.update({
            where: { id: "h1" },
            data: { name: "connected", badge: connectChosen },
          });
        },
        (error: unknown) =>
          error instanceof NestedWriteError && error.message === NULL_CODE
      );
      assert.deepEqual(await client.holder.findMany(), [
        { id: "h1", name: "one", badgeCode: null, officeId: "o1" },
      ]);
    });

    it("refuses a target whose reference already reads NULL, by R1's own sentence", async () => {
      // The capture-time half of the representability requirement (FC-02C),
      // unchanged by this unit: the literal the probe read is what R1 is asked
      // about before anything is folded into the holder's statement.
      const client = await world();
      await client.badge.update({
        where: { id: "b1" },
        data: { code: null },
      });
      driver.reset();
      await assert.rejects(
        async () => {
          await client.holder.update({
            where: { id: "h1" },
            data: { name: "connected", badge: connectChosen },
          });
        },
        (error: unknown) =>
          error instanceof NestedWriteError && error.message === NULL_CODE
      );
      assert.deepEqual(await client.holder.findMany(), [
        { id: "h1", name: "one", badgeCode: null, officeId: "o1" },
      ]);
    });

    it("asks nothing of a JUNCTION choice, whose captured pair is not the holder's own field", async () => {
      // The rule is the HOLDER's: it reads a value the enclosing record's own
      // statement spends, which is the one supply that statement's own
      // requirement (`CommandExecution.stored`) cannot ask about. A junction's
      // captured pair is the endpoints' row keys, written by the junction's own
      // statement, so nothing of the located row is folded and the pair is
      // bound as it was captured.
      const client = await world();
      assert.deepEqual(
        await client.post.update({
          where: { id: "po1" },
          data: {
            title: "linked",
            tags: {
              connectOrCreate: {
                where: { slug: "chosen" },
                create: { id: "t9", slug: "chosen", code: "T9" },
              },
            },
          },
          include: { tags: true },
        }),
        {
          id: "po1",
          title: "linked",
          tags: [{ id: "t1", slug: "chosen", code: "T" }],
        }
      );
      const junction = driver.statements.filter((statement) =>
        JUNCTION_INSERT.test(statement.sql)
      );
      assert.equal(junction.length > 0, true);
      for (const statement of junction)
        assert.equal(SUB_SELECT.test(statement.sql), false);
    });

    it("commits its ordinary result when nothing interferes", async () => {
      // No blanket refusal: the uncontended found consumption connects the row
      // its selector names, at that row's own value, and the create arm of a
      // MISSING target still converges.
      const client = await world();
      assert.deepEqual(
        await client.holder.update({
          where: { id: "h1" },
          data: { name: "connected", badge: connectChosen },
        }),
        { id: "h1", name: "connected", badgeCode: "G", officeId: "o1" }
      );
      assert.deepEqual(
        await client.holder.create({
          data: {
            id: "h4",
            name: "four",
            officeId: "o1",
            badge: {
              connectOrCreate: {
                where: { slug: "fresh" },
                create: { id: "b7", slug: "fresh", code: "F" },
              },
            },
          },
        }),
        { id: "h4", name: "four", badgeCode: "F", officeId: "o1" }
      );
      assert.deepEqual(
        (await client.badge.findMany({ orderBy: { id: "asc" } })).map(
          (row) => row.id
        ),
        ["b1", "b7"]
      );
    });
  });
}
