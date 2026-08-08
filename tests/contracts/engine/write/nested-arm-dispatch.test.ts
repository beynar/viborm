import { createClient } from "@client/client";
import type { QueryExecutionContext, QueryResult } from "@drivers";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { NestedWriteError } from "@errors";
import { beforeEach, describe, expect, test } from "vitest";
import { UnsupportedOperationError } from "@src/query-engine/write-engine/shared";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import {
  armDispatchSchema,
  armUpdate,
  BatchOnlyRecordingPGliteDriver,
  RecordingPGliteDriver,
} from "@tests/contracts/engine/write/nested-arm-dispatch-behavior";

/**
 * E3 — the upsert UPDATE arm's dispatch.
 *
 * Before this wave the arm compared `getRelationMutationKinds(mutation).join(",")` to
 * three strings, so `upsert` / `connectOrCreate` / `create` were expressible one level
 * deeper and everything else — eight kinds, every many-to-many kind, and every multi-kind
 * payload — was refused for the shape of a joined string. The measured refusals were:
 *
 *   query-engine-v2 supports only nested upsert/connectOrCreate/create one level deeper
 *   on the update arm; relation 'notes' uses 'update'.            (…'disconnect,create')
 *   query-engine-v2 does not support a nested many-to-many create one level deeper on
 *   the update arm of relation 'tags'.
 *   query-engine-v2 does not support a parent-held to-one create one level deeper on the
 *   update arm of relation 'owner'.
 *   query-engine-v2 does not support a nested connectOrCreate on the 'manyToOne'
 *   relation 'owner' here; only a child-held one-to-many … is expressible at this seam.
 *
 * all four raised at CONSTRUCTION with an empty statement log, identically on the
 * transaction and the atomic-batch substrates and under both arm-parent provenances.
 *
 * The arm's row is LOCATED, which is what a nested `update` target is, so it now reuses
 * that surface's builder through an injected seam. The witnesses below are the two halves
 * that make the absorption meaningful: the deeper write LANDS, and it lands on the row
 * this arm located rather than on the decoy beside it.
 */

/**
 * Rewrites one column of the rows the ARM'S PROBE returns, after the database answered
 * and before the engine consumes it — the wrong-row provenance harness. `wrongValue` is
 * another LIVE row's key, so no constraint can catch it: only a deeper write that
 * consumes the row the probe acted on, instead of re-deriving the value from the `where`,
 * shows the difference.
 */
class CorruptLocatePGliteDriver extends RecordingPGliteDriver {
  /** Off until the seed data is in place — `push` and the seeding writes read the same
   *  table, and corrupting those would prove nothing about the arm. */
  private armed = false;

  arm(): void {
    this.armed = true;
  }

  protected override async execute<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const result = await super.execute<T>(client, sql, params, context);
    return this.corrupt(sql, result);
  }

  protected override async executeRaw<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const result = await super.executeRaw<T>(client, sql, params, context);
    return this.corrupt(sql, result);
  }

  private corrupt<T>(sql: string, result: QueryResult<T>): QueryResult<T> {
    const isArmProbe =
      this.armed &&
      sql.startsWith("SELECT") &&
      sql.includes("e3_teams") &&
      result.rows.length > 0;
    if (!isArmProbe) return result;
    this.armed = false;
    return {
      ...result,
      rows: result.rows.map((row) => ({
        ...(row as Record<string, unknown>),
        id: "tDecoy",
      })) as T[],
    };
  }
}

function runSuite(
  name: string,
  make: (database: PGlite) => RecordingPGliteDriver
): void {
  describe(`E3 upsert update-arm dispatch (${name})`, () => {
    const getFamily = usePGliteSchemaFamily(armDispatchSchema);
    let driver: RecordingPGliteDriver;
    let client: any;

    beforeEach(async () => {
      driver = make(getFamily().database);
      client = createClient({ schema: armDispatchSchema, driver }) as any;
      await client.org.create({ data: { id: "o1", name: "Org" } });
      await client.owner.create({ data: { id: "w1", name: "Owner" } });
      await client.tag.create({ data: { id: "g1", name: "Tag" } });
      await client.team.create({
        data: { id: "t1", label: "T1", slug: "team-1", orgId: "o1" },
      });
      // THE DECOY: a sibling team of the same parent, carrying its own note. Every
      // absorbed kind below is asked to act on t1's rows; the decoy's must not move.
      await client.team.create({
        data: { id: "tDecoy", label: "DECOY", slug: "team-decoy", orgId: "o1" },
      });
      await client.note.create({
        data: { id: "n1", body: "old", tagName: "nt1", teamId: "t1" },
      });
      await client.note.create({
        data: { id: "nDecoy", body: "decoy", tagName: "ntD", teamId: "tDecoy" },
      });
    });

    const run = async (
      relations: Record<string, unknown>,
      locator?: Record<string, unknown>,
      scalars?: Record<string, unknown>
    ) => {
      driver.statements.length = 0;
      driver.recording = true;
      try {
        await client.org.update(armUpdate(relations, locator, scalars));
      } finally {
        driver.recording = false;
      }
    };

    const refusalOf = async (
      relations: Record<string, unknown>,
      locator?: Record<string, unknown>,
      scalars?: Record<string, unknown>
    ) => {
      driver.statements.length = 0;
      driver.recording = true;
      const error = await client.org
        .update(armUpdate(relations, locator, scalars))
        .then(
          () => undefined,
          (thrown: unknown) => thrown
        );
      driver.recording = false;
      return error;
    };

    const notesOf = async (target: any) =>
      (await target.note.findMany({
        orderBy: { id: "asc" },
        select: { id: true, body: true, teamId: true },
      })) as { id: string; body: string; teamId: string | null }[];

    const notes = () => notesOf(client);

    const decoyNote = async () =>
      (await notes()).find((note) => note.id === "nDecoy");

    // -----------------------------------------------------------------------
    // ABSORPTIONS. Each was a `…uses '<kind>'` refusal; each now writes, and each
    // leaves the decoy exactly as it was.
    // -----------------------------------------------------------------------

    test("update: the located note changes, the decoy's does not", async () => {
      await run({
        notes: { update: [{ where: { id: "n1" }, data: { body: "new" } }] },
      });
      expect(await notes()).toEqual([
        { id: "n1", body: "new", teamId: "t1" },
        { id: "nDecoy", body: "decoy", teamId: "tDecoy" },
      ]);
    });

    test("updateMany: the arm's correlation bounds the bulk write to its own rows", async () => {
      await run({ notes: { updateMany: [{ data: { body: "bulk" } }] } });
      expect(await notes()).toEqual([
        { id: "n1", body: "bulk", teamId: "t1" },
        { id: "nDecoy", body: "decoy", teamId: "tDecoy" },
      ]);
    });

    test("delete: only the arm's note dies", async () => {
      await run({ notes: { delete: [{ id: "n1" }] } });
      expect(await notes()).toEqual([
        { id: "nDecoy", body: "decoy", teamId: "tDecoy" },
      ]);
    });

    test("deleteMany: the correlation bounds the bulk delete", async () => {
      await run({ notes: { deleteMany: [{}] } });
      expect(await notes()).toEqual([
        { id: "nDecoy", body: "decoy", teamId: "tDecoy" },
      ]);
    });

    test("disconnect at a LITERAL arm parent: the correlated probe inlines the arm's key", async () => {
      // The carve-out the shared correlation resolver closed. This probe used to raise
      // `query-engine-v2 disconnect … requires a planned parent id to correlate its
      // probe.` — an internal QueryEngineError — for the `where: { id }` spelling.
      await run({ notes: { disconnect: [{ id: "n1" }] } });
      expect(await notes()).toEqual([
        { id: "n1", body: "old", teamId: null },
        { id: "nDecoy", body: "decoy", teamId: "tDecoy" },
      ]);
    });

    test("disconnect refuses the DECOY's note: it is not this arm's child", async () => {
      const error = await refusalOf({
        notes: { disconnect: [{ id: "nDecoy" }] },
      });
      expect(error).toBeInstanceOf(NestedWriteError);
      expect(await decoyNote()).toEqual({
        id: "nDecoy",
        body: "decoy",
        teamId: "tDecoy",
      });
    });

    test("connect: a free note is adopted by the arm's row, not the decoy", async () => {
      await client.note.create({
        data: { id: "nFree", body: "free", tagName: "ntF", teamId: null },
      });
      await run({ notes: { connect: [{ id: "nFree" }] } });
      const row = (await notes()).find((note) => note.id === "nFree");
      expect(row).toEqual({ id: "nFree", body: "free", teamId: "t1" });
    });

    test("set: membership becomes exactly the target set, decoy untouched", async () => {
      await client.note.create({
        data: { id: "nFree", body: "free", tagName: "ntF", teamId: null },
      });
      await run({ notes: { set: [{ id: "nFree" }] } });
      expect(await notes()).toEqual([
        { id: "n1", body: "old", teamId: null },
        { id: "nDecoy", body: "decoy", teamId: "tDecoy" },
        { id: "nFree", body: "free", teamId: "t1" },
      ]);
    });

    test("createMany: the bulk arm files its rows against the located team", async () => {
      await run({
        notes: {
          createMany: {
            data: [
              { id: "nA", body: "a", tagName: "ntA" },
              { id: "nB", body: "b", tagName: "ntB" },
            ],
          },
        },
      });
      const made = (await notes()).filter((note) => note.id.startsWith("n"));
      expect(made).toContainEqual({ id: "nA", body: "a", teamId: "t1" });
      expect(made).toContainEqual({ id: "nB", body: "b", teamId: "t1" });
    });

    test("MULTI-KIND: {disconnect, create} on one arm relation runs both", async () => {
      // The `.join(",")` dispatch could not express a two-kind payload at all: the joined
      // string `'disconnect,create'` matched none of its three literals.
      await run({
        notes: {
          disconnect: [{ id: "n1" }],
          create: [{ id: "nNew", body: "fresh", tagName: "ntN" }],
        },
      });
      expect(await notes()).toEqual([
        { id: "n1", body: "old", teamId: null },
        { id: "nDecoy", body: "decoy", teamId: "tDecoy" },
        { id: "nNew", body: "fresh", teamId: "t1" },
      ]);
    });

    // -----------------------------------------------------------------------
    // MANY-TO-MANY on the arm: the junction, correlated to the arm's row.
    // -----------------------------------------------------------------------

    const membership = async () =>
      (
        (await client.$queryRaw(
          'SELECT "teamId", "tagId" FROM "tag_team" ORDER BY "teamId", "tagId"'
        )) as { teamId: string; tagId: string }[]
      ).map((row) => `${row.teamId}/${row.tagId}`);

    test("m2m create: the fresh tag joins the ARM's team", async () => {
      await run({ tags: { create: [{ id: "gNew", name: "New" }] } });
      expect(await membership()).toEqual(["t1/gNew"]);
    });

    test("m2m connect + disconnect compose on the arm", async () => {
      await run({ tags: { connect: [{ id: "g1" }] } });
      expect(await membership()).toEqual(["t1/g1"]);
      await run({ tags: { disconnect: [{ id: "g1" }] } });
      expect(await membership()).toEqual([]);
    });

    test("m2m set replaces membership on the arm's row alone", async () => {
      await client.team.update({
        where: { id: "tDecoy" },
        data: { tags: { connect: [{ id: "g1" }] } },
      });
      await run({ tags: { set: [{ id: "g1" }] } });
      expect(await membership()).toEqual(["t1/g1", "tDecoy/g1"]);
    });

    // -----------------------------------------------------------------------
    // WRONG-ROW PROVENANCE. A `where` naming a NON-primary-key unique makes the arm's
    // parent value a `planned` read of this part's probe. Corrupt that read and every
    // deeper write must follow the corrupted row — the row the probe ACTED ON — not the
    // selector it was named by.
    // -----------------------------------------------------------------------

    /** Independently reset state whose arm probe is corrupted on demand. */
    const corruptedClient = async () => {
      const family = getFamily();
      await family.reset();
      const corrupting = new CorruptLocatePGliteDriver({
        client: family.database,
      });
      const seeded = createClient({
        schema: armDispatchSchema,
        driver: corrupting,
      }) as any;
      await seeded.org.create({ data: { id: "o1", name: "Org" } });
      await seeded.tag.create({ data: { id: "g1", name: "Tag" } });
      await seeded.team.create({
        data: { id: "t1", label: "T1", slug: "team-1", orgId: "o1" },
      });
      await seeded.team.create({
        data: { id: "tDecoy", label: "DECOY", slug: "team-decoy", orgId: "o1" },
      });
      corrupting.arm();
      return seeded;
    };

    test("CorruptLocate: a newly-opened createMany follows the probe row, not the where", async () => {
      const corrupted = await corruptedClient();
      await corrupted.org.update(
        armUpdate(
          {
            notes: {
              createMany: { data: [{ id: "nP", body: "p", tagName: "ntP" }] },
            },
          },
          { slug: "team-1" }
        )
      );
      // "tDecoy" is what the corrupted probe row carried; "t1" is what `slug: team-1`
      // names. A re-derivation from the selector would write "t1", and this bulk leaf's
      // `planned` foreign-key inject is one of the paths E3 newly opened.
      expect((await notesOf(corrupted))[0]?.teamId).toBe("tDecoy");
    });

    test("CorruptLocate: the junction edge follows the probe row too", async () => {
      const corrupted = await corruptedClient();
      await corrupted.org.update(
        armUpdate({ tags: { connect: [{ id: "g1" }] } }, { slug: "team-1" })
      );
      const rows = (await corrupted.$queryRaw(
        'SELECT "teamId", "tagId" FROM "tag_team"'
      )) as { teamId: string }[];
      expect(rows.map((row) => row.teamId)).toEqual(["tDecoy"]);
    });

    // -----------------------------------------------------------------------
    // THE CREATE ARM. Its update payload never runs — including now that the payload can
    // name kinds that locate. Nothing deeper may be written, and nothing may ABORT.
    // -----------------------------------------------------------------------

    test("create arm: the deeper update payload is skipped, not attempted", async () => {
      await run(
        { notes: { update: [{ where: { id: "n1" }, data: { body: "X" } }] } },
        { id: "tFresh" }
      );
      expect(
        (await client.team.findMany({ where: { id: "tFresh" } })).length
      ).toBe(1);
      expect(await notes()).toEqual([
        { id: "n1", body: "old", teamId: "t1" },
        { id: "nDecoy", body: "decoy", teamId: "tDecoy" },
      ]);
    });

    test("create arm: a deeper m2m payload is skipped too", async () => {
      await run({ tags: { connect: [{ id: "g1" }] } }, { id: "tFresh" });
      expect(await membership()).toEqual([]);
    });

    // -----------------------------------------------------------------------
    // CARVE-OUTS. Each refuses TYPED, at construction, with an empty statement log.
    // -----------------------------------------------------------------------

    const PARENT_HELD =
      "query-engine-v2 does not support a parent-held to-one write on relation 'owner' one level deeper on the update arm; the arm's row holds that foreign key, so the write belongs in the arm's own UPDATE SET, which already carries this relation's reparent.";

    test.each([
      ["create", { create: { id: "w9", name: "W9" } }],
      ["connect", { connect: { id: "w1" } }],
      [
        "connectOrCreate",
        {
          connectOrCreate: {
            where: { id: "w1" },
            create: { id: "w1", name: "W" },
          },
        },
      ],
      ["update", { update: { name: "W2" } }],
      [
        "upsert",
        { upsert: { create: { id: "w1", name: "W" }, update: { name: "W2" } } },
      ],
    ])("carve-out: a parent-held to-one %s refuses by DIRECTION", async (_label, payload) => {
      const error = await refusalOf({ owner: payload });
      expect(error).toBeInstanceOf(UnsupportedOperationError);
      expect((error as Error).message).toBe(PARENT_HELD);
      expect(driver.statements).toEqual([]);
    });

    test("carve-out: moving the arm's own primary key beside a deeper write refuses", async () => {
      const error = await refusalOf(
        { notes: { create: [{ id: "nX", body: "x", tagName: "ntX" }] } },
        { id: "t1" },
        { id: "tMoved", label: "T1b" }
      );
      expect(error).toBeInstanceOf(UnsupportedOperationError);
      expect((error as Error).message).toBe(
        "query-engine-v2 does not support an update arm that moves the primary key 'id' of relation 'teams' while it carries deeper relation writes; those writes correlate on the key the arm vacates."
      );
      expect(driver.statements).toEqual([]);
    });

    test("CONTROL: a SAME-VALUE set of the arm's primary key is not a move", async () => {
      // The root accepts `id: <the value it already has>` beside child writes; asking
      // `Object.hasOwn` alone would have refused here what the root runs.
      await run(
        { notes: { create: [{ id: "nX", body: "x", tagName: "ntX" }] } },
        { id: "t1" },
        { id: "t1", label: "T1b" }
      );
      const row = (await notes()).find((note) => note.id === "nX");
      expect(row).toEqual({ id: "nX", body: "x", teamId: "t1" });
    });

    const ASSERTING_PLANNING_READ = {
      notes: {
        update: [
          {
            where: { id: "n1" },
            data: { body: "u", team: { connect: { id: "t1" } } },
          },
        ],
      },
    };
    test("a deeper selected-record update runs on the found arm", async () => {
      await run(ASSERTING_PLANNING_READ);
      expect(await notes()).toEqual([
        { id: "n1", body: "u", teamId: "t1" },
        { id: "nDecoy", body: "decoy", teamId: "tDecoy" },
      ]);
    });

    test("the same deeper update stays inert on the create arm", async () => {
      await run(ASSERTING_PLANNING_READ, { id: "tFresh" });
      expect(
        (await client.team.findMany({ where: { id: "tFresh" } })).length
      ).toBe(1);
      expect(await notes()).toEqual([
        { id: "n1", body: "old", teamId: "t1" },
        { id: "nDecoy", body: "decoy", teamId: "tDecoy" },
      ]);
    });
  });
}

runSuite(
  "PGlite transaction",
  (database) => new RecordingPGliteDriver({ client: database })
);
runSuite(
  "PGlite atomic batch",
  (database) => new BatchOnlyRecordingPGliteDriver({ client: database })
);
