import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { NestedWriteError } from "@errors";
import { hydrateSchemaNames, s } from "@schema";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { beforeEach, describe, expect, test } from "vitest";

/**
 * M11 → B2 — WHICH COLUMNS the upsert update arm's parent value speaks for.
 *
 * THE ORIGINAL DEFECT. `buildOneUpsertPart` used to build one parent value for its own
 * UPDATE arm — the located child's primary key — and `fkAssignData` wrote EVERY foreign
 * key column of a deeper edge from that ONE value. A grandchild edge referencing a
 * compound tuple, or a single non-primary-key column, therefore received the primary key
 * in all of them and landed on whichever row happened to hold the cross-matched tuple.
 * Measured, through the public client: a grandchild silently adopted, a grandchild
 * silently reparented onto the decoy, and a bare `ForeignKeyError`. M11 refused all three
 * at construction with `assertArmEdgeReferencesLocatedPk`, with an empty statement log:
 *
 *   query-engine-v2 does not support a compound or non-primary-key referenced edge one
 *   level deeper on the update arm of relation 'members'; the arm's parent value is the
 *   located row's primary key 'id' alone, and each referenced column needs a per-field
 *   parent source.
 *
 * WHY THE REFUSAL IS GONE. The arm no longer builds that parent value. It delegates the
 * found arm to `RecordUpdateCompiler`, which resolves each referenced column BY NAME:
 * every consumed referenced field joins `locateFields`, the arm's probe publishes them
 * (`identitySelect` unions `targetProjection.fields`, and `targetProjectionOutputs`
 * exposes them), and `finalReferenceValue` reads `row[referencedField]` per member. The
 * broadcast that made the defect possible has no caller left, so the refusal was
 * refusing a value the engine can no longer construct.
 *
 * WHAT THE WITNESSES BELOW PROVE, on both substrates, with the decoy still in place —
 * its `(region, code)` IS the cross-match of the arm's own primary key "t1" and its
 * `slug` is that key too, so any surviving broadcast lands on a LIVE row rather than
 * erroring:
 *
 *  · a compound-referenced grandchild upsert correlates per field, so the decoy's member
 *    is NOT this parent's and is refused as uncorrelated — the wrong row is named, not
 *    written;
 *  · a global-adopt grandchild lands the arm's own `(eu, alpha)`, never the decoy's
 *    `(t1, t1)`;
 *  · both create paths — the deeper upsert's create arm and the bare create leaf — file
 *    the fresh row against the same located tuple;
 *  · the arity-1 non-primary-key edge writes the arm's `slug`, not its `id`.
 *
 * PROJECTION. One witness reads the arm's probe SQL directly, because "the projection
 * carries every consumed referenced field" is the precondition for all of the above and
 * is otherwise only implied by the final state.
 *
 * KNOWN, MEASURED, AND NOT WIDENED HERE (B2 hazard 3): in batch mode the arm's found
 * guard reasserts the selector, the captured primary key, the membership, and the
 * captured private polymorphic COLUMNS (`capturedTargetColumnPredicate` iterates
 * `projection.columns`) — but NOT the captured public FIELDS. A concurrent write that
 * moves `region`/`code` between the probe and the atomic unit is therefore not caught by
 * that guard, and the deeper edge writes the captured tuple. This is exactly the update
 * root's behavior for the same shape (`locatedCreateParent` plus the root presence
 * guard; the CONTROL at the bottom of this file is that root path), so it is parity and
 * not a regression this package introduces. Widening the guard to the captured fields is
 * a decision about BOTH owners, recorded rather than taken here.
 */

const armEdgeSchema = (() => {
  const org = s
    .model({
      id: s.string().id(),
      name: s.string(),
      teams: s.toMany(() => team),
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
        .toOne(() => org)
        .fields("orgId")
        .references("id"),
      // The COMPOUND referenced edge: member.(mRegion, mCode) -> team.(region, code).
      members: s.toMany(() => member),
      // The arity-1 NON-primary-key referenced edge: badge.bSlug -> team.slug.
      badges: s.toMany(() => badge),
      // The control edge: note.teamId -> team.id, the located child's own primary key.
      notes: s.toMany(() => note),
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
        .toOne(() => team)
        .fields("mRegion", "mCode")
        .references("region", "code"),
    })
    .map("arm_edge_members");
  const badge = s
    .model({
      id: s.string().id(),
      tag: s.string(),
      bSlug: s.string().nullable(),
      team: s
        .toOne(() => team)
        .fields("bSlug")
        .references("slug"),
    })
    .map("arm_edge_badges");
  const note = s
    .model({
      id: s.string().id(),
      body: s.string(),
      teamId: s.string().nullable(),
      team: s
        .toOne(() => team)
        .fields("teamId")
        .references("id"),
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

/** V1's verbatim uncorrelated-target rejection, raised at compile once the per-field
 *  membership test says the located row is not this parent's. */
const NOT_THIS_PARENT =
  "Cannot upsert relation 'members': target record was not found for this parent.";

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
  createDriver: (database: PGlite, namespace: string) => RecordingPGliteDriver
): void {
  describe(`M11 upsert update-arm referenced edge (${name})`, () => {
    const getFamily = usePGliteSchemaFamily(armEdgeSchema);
    let driver: RecordingPGliteDriver;
    let client: any;

    beforeEach(async () => {
      const family = getFamily();
      driver = createDriver(family.database, family.namespace);
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
      driver.statements.length = 0;
      driver.recording = true;
      const error = await client.org.update(orgUpdate(relations)).then(
        () => undefined,
        (thrown: unknown) => thrown
      );
      driver.recording = false;
      return error;
    };

    const run = async (relations: Record<string, unknown>) => {
      const error = await attempt(relations);
      if (error) throw error;
    };

    test("the compound edge correlates PER FIELD: the decoy's member is not this parent's", async () => {
      // m1 genuinely belongs to DECOY — its (mRegion, mCode) is ("t1", "t1"), the
      // cross-match of the arm's own primary key. The membership test compares the
      // located member's tuple against the arm's (region, code) = ("eu", "alpha"), so
      // the row is named as another parent's instead of being silently adopted.
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
      expect(error).toBeInstanceOf(NestedWriteError);
      expect((error as Error).message).toBe(NOT_THIS_PARENT);
      expect(await client.member.findMany({})).toEqual([
        { id: "m1", nick: "decoys-member", mRegion: "t1", mCode: "t1" },
      ]);
    });

    test("a global-adopt grandchild lands the arm's tuple, not the decoy's", async () => {
      await client.member.create({
        data: { id: "m1", nick: "eu-member", mRegion: "eu", mCode: "alpha" },
      });
      await run({
        members: {
          connectOrCreate: [
            { where: { id: "m1" }, create: { id: "m1", nick: "created" } },
          ],
        },
      });
      // ("t1", "t1") — the decoy's tuple — is what the broadcast used to write here.
      expect(await client.member.findMany({})).toEqual([
        { id: "m1", nick: "eu-member", mRegion: "eu", mCode: "alpha" },
      ]);
      expect(
        (await client.team.findUnique({ where: { id: "decoy" } })).label
      ).toBe("DECOY");
    });

    test("the deeper upsert's CREATE arm files the fresh row against the located tuple", async () => {
      // The decoy stays: a broadcast would find ("t1", "t1") on a live row and the
      // INSERT would succeed silently against the wrong parent.
      await run({
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
      expect(await client.member.findMany({})).toEqual([
        { id: "mNew", nick: "fresh", mRegion: "eu", mCode: "alpha" },
      ]);
    });

    test("the create LEAF one level deeper is fed by the same per-field source", async () => {
      // A create-only relation resolves its foreign key without a located reference
      // read, through the located-parent Ref per referenced column — the other of the
      // two per-field paths.
      await run({ members: { create: [{ id: "mNew", nick: "fresh" }] } });
      expect(await client.member.findMany({})).toEqual([
        { id: "mNew", nick: "fresh", mRegion: "eu", mCode: "alpha" },
      ]);
    });

    test("an arity-1 NON-primary-key referenced edge writes the slug, not the id", async () => {
      // badge.bSlug -> team.slug is one column, so an arity check alone never described
      // this case: the value at issue is WHICH column of the located row is read. The
      // decoy's slug IS "t1", the arm's primary key, so a broadcast lands on a live row.
      await client.badge.create({
        data: { id: "b1", tag: "gold", bSlug: null },
      });
      await run({
        badges: {
          connectOrCreate: [
            { where: { id: "b1" }, create: { id: "b1", tag: "gold" } },
          ],
        },
      });
      expect(await client.badge.findMany({})).toEqual([
        { id: "b1", tag: "gold", bSlug: "team-1" },
      ]);
    });

    test("the arm's probe PROJECTION carries every consumed referenced field", async () => {
      // The precondition for all of the above, read off the statement the arm actually
      // sent rather than inferred from where the rows landed.
      await client.member.create({
        data: { id: "m1", nick: "eu-member", mRegion: "eu", mCode: "alpha" },
      });
      await run({
        members: {
          upsert: [
            {
              where: { id: "m1" },
              create: { id: "m1", nick: "created" },
              update: { nick: "updated" },
            },
          ],
        },
        badges: { create: [{ id: "b9", tag: "silver" }] },
      });
      const probe = driver.statements.find(
        (sql) => sql.startsWith("SELECT") && sql.includes("arm_edge_teams")
      );
      expect(probe).toBeDefined();
      for (const column of ['"id"', '"region"', '"code"', '"slug"']) {
        expect(probe).toContain(column);
      }
      expect(await client.member.findMany({})).toEqual([
        { id: "m1", nick: "updated", mRegion: "eu", mCode: "alpha" },
      ]);
      expect(await client.badge.findMany({})).toEqual([
        { id: "b9", tag: "silver", bSlug: "team-1" },
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
  (database, namespace) =>
    new RecordingPGliteDriver({ client: database, namespace })
);
runSuite(
  "PGlite atomic batch",
  (database, namespace) =>
    new BatchOnlyRecordingPGliteDriver({ client: database, namespace })
);
