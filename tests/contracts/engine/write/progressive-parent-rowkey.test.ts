import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { s } from "@schema";
import type { CommittedBatchNotification } from "@src/drivers/types";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { describe, expect, test } from "vitest";

/**
 * RESIDUAL PACKAGE H, unit H1 — the complete parent row key at a nested
 * `RecordSeriesStep`, derived from the SELECTED TARGET PROJECTION rather than from the
 * relation's reference value.
 *
 * The shape is a parent located by a NON-PRIMARY-KEY unique whose child edge references
 * that same non-PK column. Everything the boundary needs is already in hand — the locate
 * captures the parent's complete row key, because `TargetProjection.identityFields` IS
 * that key and leads the fields the probe publishes — but the membership source names
 * `code`, and a reference value is not row identity (plan §H1: "Do not accept a non-PK
 * reference value as proof of complete row identity").
 *
 * MEASURED before the change, on this exact payload and this exact driver: the placement
 * declined with *"Driver 'pglite' cannot execute this record series as committed segments
 * because nested relation-bearing createMany on relation 'spokes' cannot re-pin the
 * complete parent row key."*, zero batches submitted — while the row key sat in the
 * locate one statement earlier. The lift is `RecordUpdateCompiler.progressiveParentRowKey`,
 * the selected-record counterpart of the fresh-record owner `CreateOperation` already had.
 *
 * A row-key transition no longer narrows this lift. The selected-record compiler owns
 * the captured complete key and its post-transition value; the relation placement owns
 * only whether its progressive member runs before or after the root UPDATE. The
 * before-root witness below fails if a later segment is re-pinned with the final key.
 *
 * §H1 says "at EVERY `RecordSeriesStep` construction site", so the OTHER placements were
 * driven on this same payload family and are pinned in the second block below rather than
 * asserted in prose. Every ordinary child-held entrance uses one correlated premise owner:
 *
 * - an existing-member `updateMany` derives both the row key and any non-row-key
 *   referenced tuple from the membership's READ sources;
 * - a supplier continuation derives both from the WRITE sources the supplier stored;
 * - `RelationJunctionPart`'s placements ride the junction's source side, whose referenced
 *   field is the parent's single primary key by construction, and the inverse POLYMORPHIC
 *   placement rides a membership whose referenced field is the target's one scalar primary
 *   key (schema rule P009). Neither can name a non-row-key column.
 *
 * Ordinary child-held edges are therefore the only placements that can need the second
 * membership conjunct. Junction and polymorphic placements stay row-key-only.
 *
 * RESIDUAL I closed the case that same lift ADMITTED. Being a placement where the
 * row key and the reference key differ is exactly what makes the liveness guard partial
 * there: it re-pins `id`, while what each member writes into `hubCode` is a `code` value
 * captured one segment earlier. §H1's other sentence covers it — "an exact … referenced
 * value proves membership, not parent row identity … keep that pair in a distinct
 * exact-membership guard when the progressive boundary needs it" — so the guard gained a
 * SECOND conjunct from the shared membership owner, asked for on every ordinary child-held
 * progressive entrance whose reference key differs from the row key.
 *
 * FALSIFIED by dropping that premise: the guard loses `"t0"."code" = $2`, and the
 * existing-member and supplier-continuation race tests RESOLVE. The measured state of this
 * create-series arm under that mutation is the honest before-picture —
 * `hubs [[h-other, H1], [h-row-key, H1-moved]]`, `spokes [[sp1, H1]]`,
 * `notes [[n1, sp1]]`: the spoke and its grandchild written, under a hub the caller never
 * named, with no error at all. Junction and polymorphic guards remain byte-identical.
 */
const rowKeySchema = (() => {
  const hub = s
    .model({
      id: s.string().id(),
      // The LOCATOR and the REFERENCE are deliberately the same non-PK unique: that is
      // what makes the membership source a construction literal with no row-key member.
      code: s.string().unique(),
      label: s.string(),
      spokes: s.toMany(() => spoke),
    })
    .map("h1_hubs");

  const spoke = s
    .model({
      id: s.string().id(),
      label: s.string(),
      hubCode: s.string().nullable(),
      hub: s
        .toOne(() => hub)
        .fields("hubCode")
        .references("code")
        .onUpdate("cascade"),
      notes: s.toMany(() => note),
    })
    .map("h1_spokes");

  const note = s
    .model({
      id: s.string().id(),
      text: s.string(),
      spokeId: s.string().nullable(),
      spoke: s
        .toOne(() => spoke)
        .fields("spokeId")
        .references("id"),
    })
    .map("h1_notes");

  return { hub, spoke, note };
})();

/** Ordered committed segments over PGlite: D1's exact declared capability pair. */
class ProgressivePGliteDriver extends BatchOnlyPGliteDriver {
  override readonly supportsOrderedCommittedSegments = true;
  batches: string[][] = [];
  /** A concurrent writer, run once, right after the first segment commits. */
  moveCodeAfterFirstBatch: (() => Promise<void>) | undefined;

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[],
    _context?: QueryExecutionContext,
    committed?: CommittedBatchNotification
  ): Promise<QueryResult<T>[]> {
    this.batches.push(queries.map((query) => query.sql));
    const results = await super.executeBatch<T>(client, queries);
    await committed?.();
    const move = this.moveCodeAfterFirstBatch;
    if (move) {
      this.moveCodeAfterFirstBatch = undefined;
      await move();
    }
    return results;
  }
}

/** The interactive leg's recorder: the progressive machinery must not reach it. */
class RecordingPGliteDriver extends PGliteDriver {
  statements: string[] = [];

  protected override async execute<T>(
    client: PGlite | Transaction,
    statement: string,
    params: readonly unknown[],
    context?: Parameters<PGliteDriver["_execute"]>[1]
  ): Promise<QueryResult<T>> {
    this.statements.push(statement);
    return await (
      super.execute as unknown as (
        c: PGlite | Transaction,
        s: string,
        p: readonly unknown[],
        x?: unknown
      ) => Promise<QueryResult<T>>
    )(client, statement, params, context);
  }
}

/** A row that carries a relation, so the nested `createMany` routes to a series. */
const RELATION_BEARING_ROW = {
  id: "sp1",
  label: "one",
  notes: { create: { id: "n1", text: "note one" } },
};

const SPOKE_INSERT = /^INSERT INTO "h1_spokes"/;
const HUB_GUARD = /__viborm_assert__/;
const PARENT_MOVED = /parent record changed across a committed segment/;

async function seed(client: any): Promise<void> {
  await client.note.deleteMany({});
  await client.spoke.deleteMany({});
  await client.hub.deleteMany({});
  await client.hub.create({
    data: { id: "h-row-key", code: "H1", label: "hub" },
  });
}

async function world(client: any): Promise<unknown> {
  return {
    hubs: (await client.hub.findMany({ orderBy: { id: "asc" } })).map(
      (row: any) => [row.id, row.code]
    ),
    spokes: (await client.spoke.findMany({ orderBy: { id: "asc" } })).map(
      (row: any) => [row.id, row.hubCode]
    ),
    notes: (await client.note.findMany({ orderBy: { id: "asc" } })).map(
      (row: any) => [row.id, row.spokeId]
    ),
  };
}

describe("H1 — the complete parent row key at a progressive nested series", () => {
  let driver: ProgressivePGliteDriver | undefined;
  let client: any;
  /** A second client over the SAME database, for the out-of-band concurrent writer.
   *  It needs its own driver: re-entering the driver under test from inside its own
   *  `executeBatch` deadlocks on that driver's queue rather than racing it. */
  let concurrent: any;
  const open = async () => {
    if (!client) {
      const database = new PGlite();
      driver = new ProgressivePGliteDriver({ client: database });
      client = createClient({ schema: rowKeySchema, driver }) as any;
      concurrent = createClient({
        schema: rowKeySchema,
        driver: new PGliteDriver({ client: database }),
      }) as any;
      await push(client, { force: true });
    }
    return client;
  };

  test("row liveness and non-PK membership remain separate guard facts", async () => {
    const c = await open();
    await seed(c);
    if (!driver) throw new Error("driver was not provisioned");
    driver.batches = [];

    await c.hub.update({
      where: { code: "H1" },
      data: { spokes: { createMany: { data: [RELATION_BEARING_ROW] } } },
    });

    // The state claim first: the member ran, and its grandchild with it.
    expect(await world(c)).toEqual({
      hubs: [["h-row-key", "H1"]],
      spokes: [["sp1", "H1"]],
      notes: [["n1", "sp1"]],
    });

    // The BOUNDARY claim: the member's writes are in a LATER batch than the enclosing
    // update's own, so the parent is on the far side of a commit — which is the whole
    // reason a guard exists here.
    const enclosing = driver.batches.findIndex((batch) =>
      batch.some((statement) => statement.includes('"t0"."code" = $1'))
    );
    const member = driver.batches.findIndex((batch) =>
      batch.some((statement) => SPOKE_INSERT.test(statement))
    );
    expect(enclosing).toBeGreaterThanOrEqual(0);
    expect(member).toBeGreaterThan(enclosing);

    // The GUARD claim, and the one §H1 is about: the member's batch opens by re-pinning
    // the hub through its ROW KEY. `code` is what the caller named and what the child's
    // foreign key references, and it is NOT what addresses the row.
    const guard = (driver.batches[member] ?? []).find((statement) =>
      HUB_GUARD.test(statement)
    );
    expect(guard).toBeDefined();
    expect(guard).toContain('"h1_hubs"');
    expect(guard).toContain('"t0"."id" = $1');

    // RESIDUAL I — the second conjunct, and it is a second FACT rather than a second
    // reading of the first. `id` says the hub is still there; `code` says the value this
    // member is about to write into `hubCode` still names THAT hub. Both are needed here
    // because this ordinary child-held placement has different row and reference keys;
    // the witness for what happens WITHOUT the second one is the next test.
    expect(guard).toContain('"t0"."code" = $2');
  }, 60_000);

  test("a concurrent move of the referenced value fails the member closed", async () => {
    const c = await open();
    await seed(c);
    if (!driver) throw new Error("driver was not provisioned");
    driver.batches = [];

    // THE CROSS-SEGMENT CASE THE LIFTED SHAPE ADMITS. Between the enclosing update's
    // committed segment and the member's, another writer moves the hub's `code` and a
    // DIFFERENT hub takes the old value. The row key guard alone passes — hub
    // `h-row-key` is still there — while `hubCode: 'H1'`, captured one segment earlier,
    // now names `h-other`. MEASURED before the premise was added: the spoke and its note
    // were written and the spoke sat under `h-other`, a hub the caller never named, with
    // no error at all.
    driver.moveCodeAfterFirstBatch = async () => {
      await concurrent.hub.update({
        where: { id: "h-row-key" },
        data: { code: "H1-moved" },
      });
      await concurrent.hub.create({
        data: { id: "h-other", code: "H1", label: "other" },
      });
    };

    await expect(
      c.hub.update({
        where: { code: "H1" },
        data: { spokes: { createMany: { data: [RELATION_BEARING_ROW] } } },
      })
    ).rejects.toThrow(PARENT_MOVED);

    // The member wrote NOTHING — neither the spoke nor its grandchild note — and the
    // out-of-band rows are exactly the ones the injection made. Committed progress
    // before the member is the substrate's contract, not a leak: this operation's own
    // prefix here is the locate, which writes nothing.
    expect(await world(c)).toEqual({
      hubs: [
        ["h-other", "H1"],
        ["h-row-key", "H1-moved"],
      ],
      spokes: [],
      notes: [],
    });
  }, 60_000);

  test("a child-held updateMany cannot continue under a replacement owner", async () => {
    const c = await open();
    await seed(c);
    if (!driver) throw new Error("driver was not provisioned");
    driver.batches = [];
    await c.hub.create({
      data: { id: "h-other", code: "H2", label: "other" },
    });
    await c.spoke.create({
      data: { id: "sp1", label: "first", hubCode: "H1" },
    });
    await c.spoke.create({
      data: { id: "sp2", label: "second", hubCode: "H2" },
    });
    driver.batches = [];

    // Both parents remain live. Cascades move the original member with h-row-key,
    // then reuse H1 for h-other and its member. A liveness-only guard therefore
    // passes while a capture by the stale referenced value selects sp2.
    driver.moveCodeAfterFirstBatch = async () => {
      await concurrent.hub.update({
        where: { id: "h-row-key" },
        data: { code: "H3" },
      });
      await concurrent.hub.update({
        where: { id: "h-other" },
        data: { code: "H1" },
      });
    };

    await expect(
      c.hub.update({
        where: { code: "H1" },
        data: {
          spokes: {
            updateMany: {
              where: {},
              data: {
                label: "wrong-owner",
                notes: { create: { id: "n-race", text: "must not land" } },
              },
            },
          },
        },
      })
    ).rejects.toThrow(PARENT_MOVED);

    expect(await world(c)).toEqual({
      hubs: [
        ["h-other", "H1"],
        ["h-row-key", "H3"],
      ],
      spokes: [
        ["sp1", "H3"],
        ["sp2", "H1"],
      ],
      notes: [],
    });
    await expect(
      c.spoke.findUnique({ where: { id: "sp2" } })
    ).resolves.toMatchObject({
      label: "second",
    });
  }, 60_000);

  test("a before-root series re-pins the selected row by its captured key", async () => {
    const c = await open();
    await seed(c);
    if (!driver) throw new Error("driver was not provisioned");
    driver.batches = [];

    await expect(
      c.hub.update({
        where: { code: "H1" },
        data: {
          id: "h-moved",
          spokes: { createMany: { data: [RELATION_BEARING_ROW] } },
        },
      })
    ).resolves.toMatchObject({ id: "h-moved", code: "H1" });

    // Every selected row-key member is part of the target projection. The compiler
    // therefore places this series before its root key transition and re-pins the
    // captured key. A final-key-only implementation would look for `h-moved` before
    // that row exists and abort.
    expect(await world(c)).toEqual({
      hubs: [["h-moved", "H1"]],
      spokes: [["sp1", "H1"]],
      notes: [["n1", "sp1"]],
    });
    const rootMove = driver.batches.findIndex((batch) =>
      batch.some((statement) => statement.includes('UPDATE "h1_hubs"'))
    );
    const member = driver.batches.findIndex((batch) =>
      batch.some((statement) => SPOKE_INSERT.test(statement))
    );
    expect(rootMove).toBeGreaterThanOrEqual(0);
    expect(member).toBeLessThan(rootMove);
  }, 60_000);

  test("a capability-false batch driver runs the guarded placement after normalized success", async () => {
    // The strong ordered-commit capability improves callback-before-decode attribution;
    // it is not the execution gate. A native atomic batch driver can continue after a
    // normalized success and must still apply the same complete parent premise.
    const plainDriver = new BatchOnlyPGliteDriver({ client: new PGlite() });
    expect(plainDriver.supportsOrderedCommittedSegments).toBe(false);
    const plain = createClient({
      schema: rowKeySchema,
      driver: plainDriver,
    }) as any;
    await push(plain, { force: true });
    await seed(plain);

    await expect(
      plain.hub.update({
        where: { code: "H1" },
        data: { spokes: { createMany: { data: [RELATION_BEARING_ROW] } } },
      })
    ).resolves.toEqual({ id: "h-row-key", code: "H1", label: "hub" });
    expect(await world(plain)).toEqual({
      hubs: [["h-row-key", "H1"]],
      spokes: [["sp1", "H1"]],
      notes: [["n1", "sp1"]],
    });
    await plain.$disconnect();
  }, 60_000);

  test("an interactive driver is untouched: same rows, and no parent presence guard", async () => {
    const recorder = new RecordingPGliteDriver({ client: new PGlite() });
    const interactive = createClient({
      schema: rowKeySchema,
      driver: recorder,
    }) as any;
    await push(interactive, { force: true });
    await seed(interactive);
    recorder.statements = [];

    await interactive.hub.update({
      where: { code: "H1" },
      data: { spokes: { createMany: { data: [RELATION_BEARING_ROW] } } },
    });

    expect(await world(interactive)).toEqual({
      hubs: [["h-row-key", "H1"]],
      spokes: [["sp1", "H1"]],
      notes: [["n1", "sp1"]],
    });
    // The owner is gated on the substrate that consumes it, so an interactive plan
    // neither computes nor emits a boundary guard: the locked locate is the premise.
    expect(recorder.statements.filter((sql) => HUB_GUARD.test(sql))).toEqual(
      []
    );
    await interactive.$disconnect();
  }, 60_000);
});

/**
 * The remaining `RecordSeriesStep` placements, on the same non-PK-located parent. They
 * all retain the complete row-key liveness guard. The child-held `updateMany` also
 * carries the distinct referenced-value premise because its members are selected by
 * that value; junction membership already addresses the parent by its primary key.
 *
 * `stamps` is a junction, so its `createMany` and `updateMany` reach
 * `RelationJunctionPart`'s two placements; `spokes.updateMany` reaches
 * `RelationWritePart`'s captured-set placement. The latter shares the source-selection
 * owner with the supplier continuation, but reads the old membership where the
 * continuation reads the supplier's write-side value.
 *
 * FALSIFIED, both ways, because the two halves of the assertion do not fail together:
 *
 * - resolving the guard over the SOURCES' fields instead of `ModelKeyCatalog.rowKey`
 *   (a one-line mutation of `resolveFinalReferenceRowKey`) turns the child-held
 *   `updateMany` red on `"t0"."id" = $1` — it then guards by `code`. The junction pair
 *   stays green under that mutation and is honest about why: a junction side references
 *   the parent's single primary key, so its reference value IS the row key and no payload
 *   can tell the two apart there;
 * - dropping the junction placement's boundary guard turns exactly that pair red, with
 *   the capability refusal. That is what makes them non-vacuous: with no later guard,
 *   `parentGuard()` falls back to the enclosing update's own re-pin, which carries `code`.
 */
const junctionRowKeySchema = (() => {
  const hub = s
    .model({
      id: s.string().id(),
      code: s.string().unique(),
      label: s.string(),
      spokes: s.toMany(() => spoke),
      stamps: s.toMany(() => stamp),
    })
    .map("h1j_hubs");

  const spoke = s
    .model({
      id: s.string().id(),
      label: s.string(),
      hubCode: s.string().nullable(),
      hub: s
        .toOne(() => hub)
        .fields("hubCode")
        .references("code"),
      notes: s.toMany(() => note),
    })
    .map("h1j_spokes");

  const note = s
    .model({
      id: s.string().id(),
      text: s.string(),
      spokeId: s.string().nullable(),
      spoke: s
        .toOne(() => spoke)
        .fields("spokeId")
        .references("id"),
    })
    .map("h1j_notes");

  const stamp = s
    .model({
      id: s.string().id(),
      name: s.string().unique(),
      hubs: s.toMany(() => hub),
      marks: s.toMany(() => mark),
    })
    .map("h1j_stamps");

  const mark = s
    .model({
      id: s.string().id(),
      text: s.string(),
      stampId: s.string().nullable(),
      stamp: s
        .toOne(() => stamp)
        .fields("stampId")
        .references("id"),
    })
    .map("h1j_marks");

  return { hub, mark, note, spoke, stamp };
})();

describe("H1 — each placement guards its exact progressive premise", () => {
  let driver: ProgressivePGliteDriver | undefined;
  let client: any;
  const open = async () => {
    if (!client) {
      driver = new ProgressivePGliteDriver({ client: new PGlite() });
      client = createClient({ schema: junctionRowKeySchema, driver }) as any;
      await push(client, { force: true });
      await client.hub.create({
        data: { id: "h-row-key", code: "H1", label: "hub" },
      });
      await client.spoke.create({
        data: { id: "sp1", label: "one", hubCode: "H1" },
      });
    }
    return client;
  };

  /** The member batch's parent re-pin: complete row key, plus ordinary membership when
   * its reference key differs. */
  const parentGuard = (): string => {
    const guards = (driver?.batches ?? [])
      .flat()
      .filter(
        (statement) =>
          HUB_GUARD.test(statement) && statement.includes('"h1j_hubs"')
      );
    // The first is the enclosing update's own locate re-pin (`code` AND `id`); the
    // boundary guard is the one a LATER batch opens with.
    const boundary = guards.at(-1);
    if (!boundary) throw new Error("no hub guard was emitted");
    return boundary;
  };

  test("a junction relation-bearing createMany", async () => {
    const c = await open();
    if (!driver) throw new Error("driver was not provisioned");
    driver.batches = [];
    await c.hub.update({
      where: { code: "H1" },
      data: {
        stamps: {
          createMany: {
            data: [
              {
                id: "st1",
                name: "s1",
                marks: { create: { id: "m1", text: "t" } },
              },
            ],
          },
        },
      },
    });
    expect(await c.stamp.findMany({})).toEqual([{ id: "st1", name: "s1" }]);
    expect(parentGuard()).toContain('"t0"."id" = $1');
    expect(parentGuard()).not.toContain('"code"');
  }, 60_000);

  test("a junction relation-bearing updateMany", async () => {
    const c = await open();
    if (!driver) throw new Error("driver was not provisioned");
    driver.batches = [];
    await c.hub.update({
      where: { code: "H1" },
      data: {
        stamps: {
          updateMany: {
            where: {},
            data: { name: "s1b", marks: { create: { id: "m2", text: "u" } } },
          },
        },
      },
    });
    expect((await c.stamp.findMany({}))[0]?.name).toBe("s1b");
    expect(parentGuard()).toContain('"t0"."id" = $1');
    expect(parentGuard()).not.toContain('"code"');
  }, 60_000);

  test("a child-held relation-bearing updateMany", async () => {
    const c = await open();
    if (!driver) throw new Error("driver was not provisioned");
    driver.batches = [];
    await c.hub.update({
      where: { code: "H1" },
      data: {
        spokes: {
          updateMany: {
            where: {},
            data: {
              label: "two",
              notes: { create: { id: "n2", text: "note two" } },
            },
          },
        },
      },
    });
    expect((await c.spoke.findMany({}))[0]?.label).toBe("two");
    expect(parentGuard()).toContain('"t0"."id" = $1');
    expect(parentGuard()).toContain('"t0"."code" = $2');
  }, 60_000);
});
