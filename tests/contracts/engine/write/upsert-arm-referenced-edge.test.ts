import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { hydrateSchemaNames, s } from "@schema";
import { beforeEach, describe, expect, test } from "vitest";
import { UnsupportedOperationError } from "@src/query-engine/write-engine/shared";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";

/**
 * M11 — WHICH COLUMN the upsert update arm's parent value can speak for.
 *
 * `buildOneUpsertPart` builds one parent value for its own UPDATE arm: the located
 * child's primary key, as the `where`'s literal or a `planned` read of this part's
 * probe. `fkAssignData` then writes EVERY foreign-key column of a deeper edge from
 * that ONE value. So a grandchild edge that references a compound tuple — or a single
 * non-primary-key column — of the located child used to receive the primary key in all
 * of them, and the row it landed on was whichever row happened to hold that
 * cross-matched tuple.
 *
 * The three scenarios below are the measured consequences, all through the public
 * client on PGlite, all with the payload's own `where` naming a real row:
 *
 *  · a grandchild that ALREADY holds the cross-matched tuple is silently taken to be
 *    this parent's child and updated — a wrong-row write with no error anywhere;
 *  · a grandchild that belongs to this parent is silently REPARENTED onto the row
 *    holding the cross-matched tuple;
 *  · with no row holding it, a bare `ForeignKeyError` naming nothing the caller wrote.
 *
 * All three are now one construction-time typed refusal, and the assertions here are
 * the pair that makes that meaningful: the typed error AND an EMPTY statement log —
 * the refusal happens before a statement exists, so no arm of the tree can have
 * half-landed. The controls prove the refusal is narrow: a single-column
 * primary-key-referenced grandchild edge still composes end to end through the same
 * builder, and the compound edge still works at the UPDATE ROOT, whose locate read
 * unions every referenced column into its own projection and therefore resolves them
 * per-field.
 */

const armEdgeSchema = (() => {
  const org = s
    .model({
      id: s.string().id(),
      name: s.string(),
      teams: s.oneToMany(() => team),
    })
    .map("arm_edge_orgs");
  const team = s
    .model({
      id: s.string().id(),
      region: s.string(),
      code: s.string(),
      slug: s.string().unique(),
      label: s.string(),
      orgId: s.string().nullable(),
      org: s
        .manyToOne(() => org)
        .fields("orgId")
        .references("id")
        .optional(),
      // The COMPOUND referenced edge: member.(mRegion, mCode) -> team.(region, code).
      members: s.oneToMany(() => member),
      // The arity-1 NON-primary-key referenced edge: badge.bSlug -> team.slug.
      badges: s.oneToMany(() => badge),
      // The control edge: note.teamId -> team.id, the located child's own primary key.
      notes: s.oneToMany(() => note),
    })
    .unique(["region", "code"])
    .map("arm_edge_teams");
  const member = s
    .model({
      id: s.string().id(),
      nick: s.string(),
      mRegion: s.string().nullable(),
      mCode: s.string().nullable(),
      team: s
        .manyToOne(() => team)
        .fields("mRegion", "mCode")
        .references("region", "code")
        .optional(),
    })
    .map("arm_edge_members");
  const badge = s
    .model({
      id: s.string().id(),
      tag: s.string(),
      bSlug: s.string().nullable(),
      team: s
        .manyToOne(() => team)
        .fields("bSlug")
        .references("slug")
        .optional(),
    })
    .map("arm_edge_badges");
  const note = s
    .model({
      id: s.string().id(),
      body: s.string(),
      teamId: s.string().nullable(),
      team: s
        .manyToOne(() => team)
        .fields("teamId")
        .references("id")
        .optional(),
    })
    .map("arm_edge_notes");
  return { org, team, member, badge, note };
})();

hydrateSchemaNames(armEdgeSchema);

class RecordingPGliteDriver extends PGliteDriver {
  readonly statements: string[] = [];
  recording = false;

  protected override execute<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    if (this.recording) this.statements.push(sql);
    return super.execute<T>(client, sql, params, context);
  }

  protected override executeRaw<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    if (this.recording) this.statements.push(sql);
    return super.executeRaw<T>(client, sql, params, context);
  }
}

class BatchOnlyRecordingPGliteDriver extends RecordingPGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    return this.transaction(client, async (tx) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries) {
        results.push(await this.executeRaw<T>(tx, query.sql, query.params));
      }
      return results;
    });
  }
}

const REFUSAL =
  "query-engine-v2 does not support a compound or non-primary-key referenced edge one level deeper on the update arm of relation 'members'; the arm's parent value is the located row's primary key 'id' alone, and each referenced column needs a per-field parent source.";

/** The upsert item wrapping `inner` — an `org.update` whose `teams` upsert is located by
 *  its own primary key "t1", so the update arm's parent value is the literal "t1". */
function orgUpdate(relations: Record<string, unknown>) {
  return {
    where: { id: "o1" },
    data: {
      teams: {
        upsert: [
          {
            where: { id: "t1" },
            create: {
              id: "t1",
              region: "eu",
              code: "alpha",
              slug: "team-1",
              label: "T1",
            },
            update: { label: "T1b", ...relations },
          },
        ],
      },
    },
  };
}

function runSuite(
  name: string,
  createDriver: (database: PGlite) => RecordingPGliteDriver
): void {
  describe(`M11 upsert update-arm referenced edge (${name})`, () => {
    const getFamily = usePGliteSchemaFamily(armEdgeSchema);
    let driver: RecordingPGliteDriver;
    let client: any;

    beforeEach(async () => {
      driver = createDriver(getFamily().database);
      client = createClient({ schema: armEdgeSchema, driver }) as any;
      await client.org.create({ data: { id: "o1", name: "Org" } });
      // THE DECOY: its (region, code) is the cross-match of the middle upsert's own
      // primary key "t1", and its `slug` is that key too — the row the broken parent
      // value used to point every deeper foreign-key column at.
      await client.team.create({
        data: {
          id: "decoy",
          region: "t1",
          code: "t1",
          slug: "t1",
          label: "DECOY",
        },
      });
      await client.team.create({
        data: {
          id: "t1",
          region: "eu",
          code: "alpha",
          slug: "team-1",
          label: "T1",
          orgId: "o1",
        },
      });
    });

    const attempt = async (relations: Record<string, unknown>) => {
      driver.recording = true;
      const error = await client.org.update(orgUpdate(relations)).then(
        () => undefined,
        (thrown: unknown) => thrown
      );
      driver.recording = false;
      return error;
    };

    test("wrong row: a grandchild holding the cross-matched tuple is refused, not adopted", async () => {
      // m1 genuinely belongs to DECOY — its (mRegion, mCode) is ("t1", "t1").
      await client.member.create({
        data: { id: "m1", nick: "decoys-member", mRegion: "t1", mCode: "t1" },
      });
      const error = await attempt({
        members: {
          upsert: [
            {
              where: { id: "m1" },
              create: { id: "m1", nick: "created" },
              update: { nick: "STOLEN" },
            },
          ],
        },
      });
      expect(error).toBeInstanceOf(UnsupportedOperationError);
      expect((error as Error).message).toBe(REFUSAL);
      expect(driver.statements).toEqual([]);
      expect(await client.member.findMany({})).toEqual([
        { id: "m1", nick: "decoys-member", mRegion: "t1", mCode: "t1" },
      ]);
    });

    test("silent reparent: a global-adopt grandchild is refused, not moved onto the decoy", async () => {
      await client.member.create({
        data: { id: "m1", nick: "eu-member", mRegion: "eu", mCode: "alpha" },
      });
      const error = await attempt({
        members: {
          connectOrCreate: [
            { where: { id: "m1" }, create: { id: "m1", nick: "created" } },
          ],
        },
      });
      expect(error).toBeInstanceOf(UnsupportedOperationError);
      expect((error as Error).message).toBe(REFUSAL);
      expect(driver.statements).toEqual([]);
      expect(await client.member.findMany({})).toEqual([
        { id: "m1", nick: "eu-member", mRegion: "eu", mCode: "alpha" },
      ]);
    });

    test("bare ForeignKeyError: the absent-target create arm is refused before the INSERT", async () => {
      await client.team.delete({ where: { id: "decoy" } });
      const error = await attempt({
        members: {
          upsert: [
            {
              where: { id: "mNew" },
              create: { id: "mNew", nick: "fresh" },
              update: { nick: "x" },
            },
          ],
        },
      });
      expect(error).toBeInstanceOf(UnsupportedOperationError);
      expect((error as Error).message).toBe(REFUSAL);
      expect(driver.statements).toEqual([]);
      expect(await client.member.findMany({})).toEqual([]);
    });

    test("the create LEAF one level deeper is fed by the same value, and refuses too", async () => {
      const error = await attempt({
        members: { create: [{ id: "mNew", nick: "fresh" }] },
      });
      expect(error).toBeInstanceOf(UnsupportedOperationError);
      expect((error as Error).message).toBe(REFUSAL);
      expect(driver.statements).toEqual([]);
      expect(await client.member.findMany({})).toEqual([]);
    });

    test("an arity-1 NON-primary-key referenced edge refuses on identity, not arity", async () => {
      // badge.bSlug -> team.slug is one column, so an arity check alone would pass it —
      // and the value written would still be the primary key "t1", which is the DECOY's
      // slug.
      await client.badge.create({
        data: { id: "b1", tag: "gold", bSlug: "team-1" },
      });
      const error = await attempt({
        badges: {
          connectOrCreate: [
            { where: { id: "b1" }, create: { id: "b1", tag: "gold" } },
          ],
        },
      });
      expect(error).toBeInstanceOf(UnsupportedOperationError);
      expect((error as Error).message).toBe(
        REFUSAL.replace("'members'", "'badges'")
      );
      expect(driver.statements).toEqual([]);
      expect(await client.badge.findMany({})).toEqual([
        { id: "b1", tag: "gold", bSlug: "team-1" },
      ]);
    });

    const controlNoteUpsert = () =>
      orgUpdate({
        notes: {
          upsert: [
            {
              where: { id: "n1" },
              create: { id: "n1", body: "created" },
              update: { body: "updated" },
            },
          ],
        },
      });

    test("CONTROL: a single-column primary-key-referenced grandchild edge still updates", async () => {
      await client.note.create({
        data: { id: "n1", body: "old", teamId: "t1" },
      });
      driver.recording = true;
      await client.org.update(controlNoteUpsert());
      driver.recording = false;
      expect(driver.statements.length).toBeGreaterThan(0);
      expect(await client.note.findMany({})).toEqual([
        { id: "n1", body: "updated", teamId: "t1" },
      ]);
      expect(
        (await client.team.findUnique({ where: { id: "t1" } })).label
      ).toBe("T1b");
    });

    test("CONTROL: the same edge's create arm lands the located row's primary key", async () => {
      await client.org.update(controlNoteUpsert());
      expect(await client.note.findMany({})).toEqual([
        { id: "n1", body: "created", teamId: "t1" },
      ]);
    });

    test("CONTROL: the compound edge still resolves per-field at the UPDATE ROOT", async () => {
      // The regression pin for where this refusal lives. The update root's locate read
      // unions every referenced column into its own projection, so `referencedFieldValue`
      // answers (region, code) per-field there. Refusing on the incoming source's KIND
      // would have taken this working shape down with the broken one.
      await client.member.create({
        data: { id: "m1", nick: "eu-member", mRegion: "eu", mCode: "alpha" },
      });
      await client.team.update({
        where: { id: "t1" },
        data: {
          members: {
            upsert: [
              {
                where: { id: "m1" },
                create: { id: "m1", nick: "created" },
                update: { nick: "updated" },
              },
            ],
          },
        },
      });
      expect(await client.member.findMany({})).toEqual([
        { id: "m1", nick: "updated", mRegion: "eu", mCode: "alpha" },
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
