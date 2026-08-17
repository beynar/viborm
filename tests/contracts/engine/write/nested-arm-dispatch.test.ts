import { createClient } from "@client/client";
import type { QueryExecutionContext, QueryResult } from "@drivers";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { NestedWriteError } from "@errors";
import { hydrateSchemaNames, s } from "@schema";
import { UnsupportedOperationError } from "@src/query-engine/write-engine/shared";
import {
  armDispatchSchema,
  armUpdate,
  BatchOnlyRecordingPGliteDriver,
  RecordingPGliteDriver,
} from "@tests/contracts/engine/write/nested-arm-dispatch-behavior";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { beforeEach, describe, expect, test } from "vitest";

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
      await client.org.create({
        data: { id: "o1", code: "org-1-code", name: "Org" },
      });
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
      scalars?: Record<string, unknown>,
      rootScalars?: Record<string, unknown>
    ) => {
      driver.statements.length = 0;
      driver.recording = true;
      try {
        await client.org.update(
          armUpdate(relations, locator, scalars, rootScalars)
        );
      } finally {
        driver.recording = false;
      }
    };

    const refusalOf = async (
      relations: Record<string, unknown>,
      locator?: Record<string, unknown>,
      scalars?: Record<string, unknown>,
      rootScalars?: Record<string, unknown>
    ) => {
      driver.statements.length = 0;
      driver.recording = true;
      const error = await client.org
        .update(armUpdate(relations, locator, scalars, rootScalars))
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
      await seeded.org.create({
        data: { id: "o1", code: "org-1-code", name: "Org" },
      });
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
    // Parent-held folds now belong to the selected-record compiler too.
    // -----------------------------------------------------------------------

    test.each([
      ["create", { create: { id: "w9", name: "W9" } }, "w9"],
      ["connect", { connect: { id: "w1" } }, "w1"],
      [
        "connectOrCreate found",
        {
          connectOrCreate: {
            where: { id: "w1" },
            create: { id: "w1", name: "W" },
          },
        },
        "w1",
      ],
      [
        "connectOrCreate missing",
        {
          connectOrCreate: {
            where: { id: "w9" },
            create: { id: "w9", name: "W9" },
          },
        },
        "w9",
      ],
    ])("parent-held %s folds into the selected arm root", async (_label, payload, ownerId) => {
      await run({ owner: payload });
      expect(
        (await client.team.findUnique({ where: { id: "t1" } })).ownerId
      ).toBe(ownerId);
    });

    test("parent-held update and upsert target the selected arm's relation", async () => {
      await client.team.update({
        where: { id: "t1" },
        data: { owner: { connect: { id: "w1" } } },
      });
      await run({ owner: { update: { name: "W1b" } } });
      expect(
        (await client.owner.findUnique({ where: { id: "w1" } })).name
      ).toBe("W1b");

      await run({
        owner: {
          upsert: {
            create: { id: "w9", name: "W9" },
            update: { name: "unused" },
          },
        },
      });
      expect(
        (await client.team.findUnique({ where: { id: "t1" } })).ownerId
      ).toBe("w1");
    });

    test("a membership writer on the incoming edge may reparent", async () => {
      await client.org.create({
        data: { id: "o2", code: "org-2-code", name: "O2" },
      });
      await run({ org: { connect: { id: "o2" } } });
      expect(
        (await client.team.findUnique({ where: { id: "t1" } })).orgId
      ).toBe("o2");
    });

    test("a membership writer on the incoming edge may disconnect", async () => {
      await run({ org: { disconnect: true } });
      expect(
        (await client.team.findUnique({ where: { id: "t1" } })).orgId
      ).toBeNull();
    });

    test("same-incoming update re-enters the exact selected parent", async () => {
      await client.org.create({
        data: { id: "o2", code: "org-2-code", name: "decoy" },
      });
      await run({ org: { update: { name: "selected" } } });
      expect(
        await client.org.findMany({
          orderBy: { id: "asc" },
          select: { id: true, name: true },
        })
      ).toEqual([
        { id: "o1", name: "selected" },
        { id: "o2", name: "decoy" },
      ]);
    });

    test("same-incoming descendants read a demanded non-key reference from the selected parent", async () => {
      await run(
        {
          org: {
            update: {
              codeNotes: {
                create: { id: "nCode", body: "deep", tagName: "ntCode" },
              },
            },
          },
        },
        undefined,
        undefined,
        { code: "org-1-code-moved" }
      );
      await expect(
        client.note.findUnique({ where: { id: "nCode" } })
      ).resolves.toMatchObject({
        id: "nCode",
        orgCode: "org-1-code-moved",
        teamId: null,
      });
    });

    test("the optional parent filter cannot redirect re-entry to a decoy", async () => {
      await client.org.create({
        data: { id: "o2", code: "org-2-code", name: "decoy-match" },
      });
      const error = await refusalOf({
        org: {
          update: {
            where: { name: "decoy-match" },
            data: { name: "must not escape" },
          },
        },
      });
      expect(error).toBeInstanceOf(NestedWriteError);
      expect((error as Error).message).toContain(
        "target record was not found for this parent"
      );
      await expect(
        client.org.findMany({ orderBy: { id: "asc" } })
      ).resolves.toMatchObject([
        { id: "o1", name: "Org" },
        { id: "o2", name: "decoy-match" },
      ]);
    });

    test("same-incoming upsert takes the found arm and never creates its sentinel", async () => {
      await run({
        org: {
          upsert: {
            create: {
              id: "o-sentinel",
              code: "org-sentinel-code",
              name: "must not create",
            },
            update: { name: "selected by found arm" },
          },
        },
      });
      await expect(
        client.org.findUnique({ where: { id: "o1" } })
      ).resolves.toMatchObject({ name: "selected by found arm" });
      await expect(
        client.org.findUnique({ where: { id: "o-sentinel" } })
      ).resolves.toBeNull();
    });

    test("the enclosing create arm leaves the incoming-parent update inert", async () => {
      await run(
        { org: { update: { name: "must not run" } } },
        { id: "tFresh" }
      );
      await expect(
        client.org.findUnique({ where: { id: "o1" } })
      ).resolves.toMatchObject({ name: "Org" });
      await expect(
        client.team.findUnique({ where: { id: "tFresh" } })
      ).resolves.toMatchObject({ orgId: "o1" });
    });

    test("a direct parent-key transition keeps re-entry on the captured parent", async () => {
      await run(
        { org: { update: { name: "inner-before-root" } } },
        { id: "t1" },
        { label: "T1b" },
        { id: "o-moved", name: "outer-after-child" }
      );
      await expect(
        client.org.findUnique({ where: { id: "o1" } })
      ).resolves.toBeNull();
      await expect(
        client.org.findUnique({ where: { id: "o-moved" } })
      ).resolves.toMatchObject({ name: "outer-after-child" });
      await expect(
        client.team.findUnique({ where: { id: "t1" } })
      ).resolves.toMatchObject({ orgId: "o-moved" });
    });

    const SAME_INCOMING_DELETE =
      "query-engine-v2 does not support a target mutation on relation 'org' when it addresses the same incoming membership as the selected upsert arm.";

    test("same-incoming delete keeps the focused overlap refusal", async () => {
      const error = await refusalOf({ org: { delete: true } });
      expect(error).toBeInstanceOf(UnsupportedOperationError);
      expect((error as Error).message).toBe(SAME_INCOMING_DELETE);
      expect(driver.statements).toEqual([]);
    });

    test("a key-changing re-entry remains a focused refusal", async () => {
      const error = await refusalOf({ org: { update: { id: "o-inner" } } });
      expect(error).toBeInstanceOf(UnsupportedOperationError);
      expect((error as Error).message).toBe(
        "query-engine-v2 does not support a selected incoming-parent re-entry that changes row-key field 'id' on relation 'org'."
      );
      expect(
        driver.statements.every((statement) => statement.startsWith("SELECT "))
      ).toBe(true);
      await expect(
        client.org.findUnique({ where: { id: "o1" } })
      ).resolves.toMatchObject({ name: "Org" });
    });

    test("delete beside a supplier stays with the earlier OwnWrite refusal", async () => {
      const error = await refusalOf({
        org: { connect: { id: "o1" }, delete: true },
      });
      expect(error).toBeInstanceOf(NestedWriteError);
      expect((error as Error).message).toBe(
        "Nested operation 'connect' on relation 'org' depends on an earlier 'delete' target write in the same nested write. Split these operations into separate queries."
      );
      expect(driver.statements).toEqual([]);
    });

    test("a self-relation child-held inverse is not the incoming parent-held edge", async () => {
      await client.node.create({
        data: { id: "root", label: "root", parentId: null },
      });
      await client.node.create({
        data: { id: "child", label: "child", parentId: "root" },
      });
      await client.node.create({
        data: { id: "grand", label: "before", parentId: "child" },
      });

      await client.node.update({
        where: { id: "root" },
        data: {
          children: {
            upsert: [
              {
                where: { id: "child" },
                create: { id: "unused", label: "unused" },
                update: {
                  children: {
                    update: [
                      {
                        where: { id: "grand" },
                        data: { label: "after" },
                      },
                    ],
                  },
                },
              },
            ],
          },
        },
      });

      expect(
        await client.node.findUnique({
          where: { id: "grand" },
          select: { label: true, parentId: true },
        })
      ).toEqual({ label: "after", parentId: "child" });
    });

    // -----------------------------------------------------------------------
    // B1 — THE ARM MOVES ITS OWN PRIMARY KEY. Until this package, `assertArmPkStable`
    // refused the payload below at construction with an empty statement log:
    //
    //   query-engine-v2 does not support an update arm that moves the primary key 'id'
    //   of relation 'teams' while it carries deeper relation writes; those writes
    //   correlate on the key the arm vacates.
    //
    // The selected-record compiler the arm delegates to has owned
    // that correlation since T4b/T4c/N5-U1: it derives the POST-transition value from
    // the where-pinned pre-value and the root SET, defers every write that must
    // reference it until after the root UPDATE, and guards the OLD slot with the
    // referential-action (CLASS IV) guard. The two witnesses below are the halves the
    // arm guard was standing in front of: the accept path, and the guard that actually
    // owns the unsafe half.
    //
    // WHAT A DECOY CAN AND CANNOT BE HERE. A primary key the arm still holds cannot be
    // owned by a second live row, so no decoy can sit on the vacated key while the
    // payload is built. The wrong-row surface that IS reachable is pinned instead:
    // `tDecoy` is a sibling arm-row with its own note, `nFreeDecoy` sits beside the
    // adopted note in the connect's race position, and a write that bound the vacated
    // key would be a `ForeignKeyError` rather than a silent landing.
    // -----------------------------------------------------------------------

    const teams = async () =>
      (await client.team.findMany({
        orderBy: { id: "asc" },
        select: { id: true, label: true, orgId: true },
      })) as { id: string; label: string; orgId: string | null }[];

    test("PK MOVE: the deeper create and connect consume the POST-transition key", async () => {
      // The old slot must be EMPTY: the CLASS IV guard rejects a transition that would
      // strand an existing member, and the seeded n1 holds the vacated key. That
      // rejection is the guard's own behavior and is pinned by the next test.
      await client.note.delete({ where: { id: "n1" } });
      await client.note.create({
        data: { id: "nFree", body: "free", tagName: "ntF", teamId: null },
      });
      await client.note.create({
        data: {
          id: "nFreeDecoy",
          body: "spare",
          tagName: "ntFD",
          teamId: null,
        },
      });
      await run(
        {
          notes: {
            create: [{ id: "nX", body: "x", tagName: "ntX" }],
            connect: [{ id: "nFree" }],
          },
        },
        { id: "t1" },
        { id: "tMoved", label: "T1b" }
      );
      // ORDERING is the whole mechanism, so it is pinned and not inferred from the
      // final state: the arm's root UPDATE writes the new key FIRST, and only then do
      // the two writes that reference it run. Reversing this pair is what the deleted
      // guard claimed the arm could not avoid.
      expect(
        driver.statements.filter((sql) => !sql.startsWith("SELECT"))
      ).toEqual([
        expect.stringContaining('UPDATE "e3_teams"'),
        expect.stringContaining('UPDATE "e3_notes"'),
        expect.stringContaining('INSERT INTO "e3_notes"'),
      ]);
      expect(await teams()).toEqual([
        { id: "tDecoy", label: "DECOY", orgId: "o1" },
        { id: "tMoved", label: "T1b", orgId: "o1" },
      ]);
      expect(await notes()).toEqual([
        // The sibling arm-row's note never moved.
        { id: "nDecoy", body: "decoy", teamId: "tDecoy" },
        // Adopted onto the key the root UPDATE had just written, not the one it
        // vacated — the N5-U1 ordering, reached through the arm.
        { id: "nFree", body: "free", teamId: "tMoved" },
        // The decoy in the connect's race position stays free.
        { id: "nFreeDecoy", body: "spare", teamId: null },
        // The fresh row's foreign key is the derived post-transition literal.
        { id: "nX", body: "x", teamId: "tMoved" },
      ]);
    });

    test("PK MOVE with an OCCUPIED old slot: the referential-action guard refuses", async () => {
      // n1 still holds the vacated key. This is the invariant the arm guard was
      // half-owning; the selected-record compiler's CLASS IV guard owns it whole, with
      // V1's message, on both substrates, and nothing is written.
      const error = await refusalOf(
        { notes: { create: [{ id: "nX", body: "x", tagName: "ntX" }] } },
        { id: "t1" },
        { id: "tMoved", label: "T1b" }
      );
      expect(error).toBeInstanceOf(NestedWriteError);
      expect((error as Error).message).toBe(
        "Cannot update relation 'notes' with onUpdate('restrict') while the current relation is occupied."
      );
      expect(await teams()).toEqual([
        { id: "t1", label: "T1", orgId: "o1" },
        { id: "tDecoy", label: "DECOY", orgId: "o1" },
      ]);
      expect(await notes()).toEqual([
        { id: "n1", body: "old", teamId: "t1" },
        { id: "nDecoy", body: "decoy", teamId: "tDecoy" },
      ]);
    });

    test("a PK-moving arm stays inert on the CREATE branch", async () => {
      // The update arm's compiler is built EAGERLY for both arms, and a transition
      // makes it allocate a referential-action probe. On the create branch none of that
      // may fire: the fresh row is inserted, the occupied slot the guard would have
      // rejected is left alone, and no deeper write runs.
      await run(
        { notes: { create: [{ id: "nX", body: "x", tagName: "ntX" }] } },
        { id: "tFresh" },
        { id: "tMoved", label: "T1b" }
      );
      expect(await teams()).toEqual([
        { id: "t1", label: "T1", orgId: "o1" },
        { id: "tDecoy", label: "DECOY", orgId: "o1" },
        { id: "tFresh", label: "T1", orgId: "o1" },
      ]);
      expect(await notes()).toEqual([
        { id: "n1", body: "old", teamId: "t1" },
        { id: "nDecoy", body: "decoy", teamId: "tDecoy" },
      ]);
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

    // -----------------------------------------------------------------------
    // B1's DOMAIN, THE REST OF IT. `assertArmPkStable` filtered on nothing but
    // "relations is non-empty", so deleting it opened three sub-domains at once. The
    // accept witness above covers ONE: a primary-key locator beside a child-held edge.
    // These three cover the others, so no corner of the opened domain is carried on
    // reasoning alone.
    // -----------------------------------------------------------------------

    const junction = async () =>
      (await client.$queryRaw(
        'SELECT "teamId", "tagId" FROM "tag_team" ORDER BY "teamId", "tagId"'
      )) as { teamId: string; tagId: string }[];

    test("PK MOVE beside a DEFAULT-CASCADE junction: ordered, then cascaded", async () => {
      // The common case, and the one with no engine-side transition classification at
      // all: `interpretRelation` returns for a junction BEFORE it classifies a
      // referenced-key transition. Correctness rests entirely on two things this pins —
      // `reorderRootUpdateAfterChildren` putting the join row's INSERT BEFORE the arm's
      // UPDATE, and the implicit `ON UPDATE CASCADE` that viborm's own junction DDL
      // emits on both sides — so the join row is written against the key the arm still
      // holds and the database carries it to the new one. (The opt-OUT pair, which has
      // no owner at either the arm or the update root, is the "B1 RESIDUE" block at the
      // bottom of this file.)
      //
      // `n1` goes first for the same reason the accept witness above empties the slot:
      // its `teamId` is an ordinary FK with the default `ON UPDATE NO ACTION`, so it
      // would refuse the transition at the constraint before the junction is reached.
      // That is the notes edge's behaviour, not the junction's, and it is pinned by the
      // occupied-guard witness above.
      await client.note.delete({ where: { id: "n1" } });
      await run(
        { tags: { connect: [{ id: "g1" }] } },
        { id: "t1" },
        { id: "tMoved", label: "T1b" }
      );
      expect(
        driver.statements.filter((sql) => !sql.startsWith("SELECT"))
      ).toEqual([
        expect.stringContaining('INSERT  INTO "tag_team"'),
        expect.stringContaining('UPDATE "e3_teams"'),
      ]);
      expect(await junction()).toEqual([{ teamId: "tMoved", tagId: "g1" }]);
      expect(await teams()).toEqual([
        { id: "tDecoy", label: "DECOY", orgId: "o1" },
        { id: "tMoved", label: "T1b", orgId: "o1" },
      ]);
    });

    test("PK MOVE under a NON-PK locator beside a non-cascading OCCUPIED edge: refused by the occupied guard", async () => {
      // RETARGETED BY PACKAGE D2. Until D, the second guard standing behind the deleted
      // `assertArmPkStable` was `assertPinnedTransitionIsCompilable`, refusing at
      // CONSTRUCTION with zero statements:
      //
      //   query-engine-v2 update for relation 'teams' transitions the target primary key
      //   'id' while writing a deeper edge whose foreign key does not cascade on update;
      //   it must locate the target by that primary key.
      //
      // D2 deleted it, because locating by the primary key is not what this payload
      // needs: `n1` sits on `t1` with an `ON UPDATE NO ACTION` foreign key, so moving
      // `t1` strands it under EITHER locator. The arm's own relation-level occupied
      // guard says so, and says it for the right reason. The two halves of the domain
      // the old refusal covered — occupied and empty — are this test and the next.
      //
      // The PUBLIC SURFACE moved with it, and not only the wording: the class is now
      // `NestedWriteError` rather than `UnsupportedOperationError`, and the verdict is
      // no longer construction-time, so the statement log is no longer empty (a
      // planning probe runs first; on a batch substrate the verdict is an in-unit
      // absence guard). No partial effect either way, asserted below. Package O's
      // ledger carries this beside Package C's two ratified message changes.
      const error = await refusalOf(
        { notes: { create: [{ id: "nX", body: "x", tagName: "ntX" }] } },
        { slug: "team-1" },
        { id: "tMoved", label: "T1b" }
      );
      expect(error).toBeInstanceOf(NestedWriteError);
      expect((error as Error).message).toBe(
        "Cannot update relation 'notes' with onUpdate('restrict') while the current relation is occupied."
      );
      expect(await teams()).toEqual([
        { id: "t1", label: "T1", orgId: "o1" },
        { id: "tDecoy", label: "DECOY", orgId: "o1" },
      ]);
      expect(await notes()).toEqual([
        { id: "n1", body: "old", teamId: "t1" },
        { id: "nDecoy", body: "decoy", teamId: "tDecoy" },
      ]);
    });

    test("D2 LIFT: the same payload with an EMPTY old slot compiles, and the fresh note takes the NEW key", async () => {
      // The half no locator could reach before D2. The arm's pre-transition key lives
      // only in the row the probe located (`slug` names a different column), and the
      // fresh note's foreign key is derived from it at COMPILE. The decoy team keeps
      // its own note, which is what separates this from "the engine wrote something".
      await client.note.delete({ where: { id: "n1" } });
      await run(
        { notes: { create: [{ id: "nX", body: "x", tagName: "ntX" }] } },
        { slug: "team-1" },
        { id: "tMoved", label: "T1b" }
      );
      expect(await teams()).toEqual([
        { id: "tDecoy", label: "DECOY", orgId: "o1" },
        { id: "tMoved", label: "T1b", orgId: "o1" },
      ]);
      expect(await notes()).toEqual([
        { id: "nDecoy", body: "decoy", teamId: "tDecoy" },
        { id: "nX", body: "x", teamId: "tMoved" },
      ]);
    });

    test("PK MOVE under a NON-PK locator beside a junction edge: accepted", async () => {
      // The guard above `continue`s junction kinds, so this is the one sub-domain B1
      // genuinely opened with no compile-time pre-value: the transition is derived from
      // the CAPTURED probe row rather than a `where` literal.
      await client.note.delete({ where: { id: "n1" } });
      await run(
        { tags: { connect: [{ id: "g1" }] } },
        { slug: "team-1" },
        { id: "tMoved", label: "T1b" }
      );
      expect(await junction()).toEqual([{ teamId: "tMoved", tagId: "g1" }]);
      expect(await teams()).toEqual([
        { id: "tDecoy", label: "DECOY", orgId: "o1" },
        { id: "tMoved", label: "T1b", orgId: "o1" },
      ]);
    });

    test("CorruptLocate: a PK move under a NON-PK locator follows the probe row", async () => {
      // …and because that transition is derived from the captured row, it is wrong-row
      // sensitive in exactly the way the selector is not. The corrupted probe says the
      // arm located `tDecoy`; a re-derivation from `slug: team-1` would move `t1`.
      const corrupted = await corruptedClient();
      await corrupted.org.update(
        armUpdate(
          { tags: { connect: [{ id: "g1" }] } },
          { slug: "team-1" },
          { id: "tMoved", label: "T1b" }
        )
      );
      expect(
        await corrupted.team.findMany({
          orderBy: { id: "asc" },
          select: { id: true },
        })
      ).toEqual([{ id: "t1" }, { id: "tMoved" }]);
      expect(
        await corrupted.$queryRaw(
          'SELECT "teamId", "tagId" FROM "tag_team" ORDER BY "teamId", "tagId"'
        )
      ).toEqual([{ teamId: "tMoved", tagId: "g1" }]);
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

/**
 * B1 RESIDUE — the transition-blind junction, measured rather than guarded.
 *
 * `RecordUpdateCompiler.interpretRelation` returns for a junction BEFORE it classifies
 * a referenced-key transition, so a junction edge never gets an occupied guard and never
 * gets a post-transition parent value: its join row is written against the LOCATED key
 * and the root UPDATE is reordered behind it, which is correct precisely because an
 * implicit junction foreign key is `ON UPDATE CASCADE` (`serializer.ts` defaults both
 * sides to cascade). A pair that opts OUT with `.onUpdate("restrict")` has no engine
 * owner for the transition — the deleted `assertArmPkStable` covered it at the arm only
 * because it filtered on nothing.
 *
 * The measurement below is what decides the disposition. The arm and the update ROOT
 * emit the SAME statements in the SAME order and reach the SAME outcome: the constraint
 * refuses the transition, atomically, with no partial effect. It does not wrong-row, and
 * the third case proves the owner is the constraint rather than anything the payload
 * says — a bare primary-key move with a pre-existing join row and NO relation payload at
 * all fails identically. So this residue is not the arm's: it is the update root's own
 * behavior for this topology, and a narrowed refusal at the arm would refuse a payload
 * the root accepts-and-fails-closed on, which is the asymmetric duplicate the one-guard
 * rule bans.
 *
 * Substrate note, recorded because it is a real boundary: a provider that does not
 * enforce foreign keys (SQLite with `PRAGMA foreign_keys=OFF`) would strand the join row
 * on the vacated key instead of raising. That is equally true of the root today; it is
 * parity, not an exposure this package opened.
 */
const junctionResidueSchema = (() => {
  const org = s
    .model({
      id: s.string().id(),
      name: s.string(),
      teams: s.oneToMany(() => team),
    })
    .map("b1_res_orgs");
  const team = s
    .model({
      id: s.string().id(),
      label: s.string(),
      slug: s.string().unique(),
      orgId: s.string().nullable(),
      org: s
        .manyToOne(() => org)
        .fields("orgId")
        .references("id")
        .optional(),
      // The opt-OUT: both sides must agree, and the pair is serialized with
      // `ON UPDATE RESTRICT` instead of the implicit cascade.
      tags: s.manyToMany(() => tag).onUpdate("restrict"),
    })
    .map("b1_res_teams");
  const tag = s
    .model({
      id: s.string().id(),
      name: s.string(),
      teams: s.manyToMany(() => team).onUpdate("restrict"),
    })
    .map("b1_res_tags");
  return { org, team, tag };
})();

hydrateSchemaNames(junctionResidueSchema);

function runJunctionResidue(
  name: string,
  make: (database: PGlite) => RecordingPGliteDriver
): void {
  describe(`B1 residue: a non-cascading junction under a moved key (${name})`, () => {
    const getFamily = usePGliteSchemaFamily(junctionResidueSchema);
    let driver: RecordingPGliteDriver;
    let client: any;

    beforeEach(async () => {
      driver = make(getFamily().database);
      client = createClient({ schema: junctionResidueSchema, driver }) as any;
      await client.org.create({ data: { id: "o1", name: "Org" } });
      await client.tag.create({ data: { id: "g1", name: "Tag" } });
      await client.team.create({
        data: { id: "t1", label: "T1", slug: "team-1", orgId: "o1" },
      });
    });

    const outcome = async (run: () => Promise<unknown>) => {
      driver.statements.length = 0;
      driver.recording = true;
      const error = await run().then(
        () => undefined,
        (thrown: unknown) => thrown
      );
      driver.recording = false;
      return {
        error: (error as Error | undefined)?.constructor.name,
        writes: driver.statements.filter((sql) => !sql.startsWith("SELECT")),
        junction: await client.$queryRaw('SELECT * FROM "tag_team"'),
        teams: await client.team.findMany({
          orderBy: { id: "asc" },
          select: { id: true },
        }),
      };
    };

    const REFUSED_BY_THE_CONSTRAINT = {
      error: "ForeignKeyError",
      writes: [
        expect.stringContaining('INSERT  INTO "tag_team"'),
        expect.stringContaining('UPDATE "b1_res_teams"'),
      ],
      junction: [],
      teams: [{ id: "t1" }],
    };

    test("the ARM's junction edge fails closed at the constraint", async () => {
      expect(
        await outcome(() =>
          client.org.update({
            where: { id: "o1" },
            data: {
              teams: {
                upsert: [
                  {
                    where: { id: "t1" },
                    create: { id: "t1", label: "T1", slug: "s-t1" },
                    update: {
                      id: "tMoved",
                      label: "T1b",
                      tags: { connect: [{ id: "g1" }] },
                    },
                  },
                ],
              },
            },
          })
        )
      ).toEqual(REFUSED_BY_THE_CONSTRAINT);
    });

    test("the update ROOT does exactly the same, statement for statement", async () => {
      expect(
        await outcome(() =>
          client.team.update({
            where: { id: "t1" },
            data: {
              id: "tMoved",
              label: "T1b",
              tags: { connect: [{ id: "g1" }] },
            },
          })
        )
      ).toEqual(REFUSED_BY_THE_CONSTRAINT);
    });

    test("the owner is the constraint: a bare key move with an existing join row fails too", async () => {
      await client.team.update({
        where: { id: "t1" },
        data: { tags: { connect: [{ id: "g1" }] } },
      });
      expect(
        await outcome(() =>
          client.team.update({
            where: { id: "t1" },
            data: { id: "tMoved", label: "T1b" },
          })
        )
      ).toEqual({
        error: "ForeignKeyError",
        // No relation payload at all — one statement, and the constraint still owns it.
        writes: [expect.stringContaining('UPDATE "b1_res_teams"')],
        junction: [{ tagId: "g1", teamId: "t1" }],
        teams: [{ id: "t1" }],
      });
    });
  });
}

runJunctionResidue(
  "PGlite transaction",
  (database) => new RecordingPGliteDriver({ client: database })
);
runJunctionResidue(
  "PGlite atomic batch",
  (database) => new BatchOnlyRecordingPGliteDriver({ client: database })
);
