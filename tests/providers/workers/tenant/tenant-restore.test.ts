/**
 * Plan T3's gate: both restore directions for a tenant whose history lives in
 * its Durable Object and whose tables live in PostgreSQL, at 10,000 rows.
 *
 * - The object's history restored behind the database: the marker names a
 *   state the history lacks, so a change fails until `reanchor()` moves the
 *   marker to the state the live schema matches.
 * - The database restored behind the history: an ordinary change applies the
 *   states the database lacks.
 *
 * And plan T4 in the same object: an authored checkpoint pruned into a second,
 * prefixed history in the object's storage, onto which `reanchor()` moves the
 * marker, after which the tenant keeps changing from the checkpoint.
 *
 * Project `provider-tenant-do`; without PG_TEST_CONNECTION_STRING it skips.
 */

import { env, runInDurableObject } from "cloudflare:test";
import type {
  DurableObjectNamespace,
  DurableObjectState,
  DurableObjectStub,
} from "@cloudflare/workers-types";
import { VibORMErrorCode } from "@src/errors";
import { createMigrationClient } from "@src/migrations/client";
import { createDurableObjectStorageWriter } from "@src/migrations/storage/durable-object";
import {
  createTenantMigrator,
  type TenantChangeResult,
} from "@src/migrations/tenant";
import { parseSchema } from "@src/schema/json";
import {
  MEMBER_ROWS,
  memberDocument,
  noteDocument,
  noteTagDocument,
  seedMembersSql,
} from "@tests/fixtures/tenant-member";
import type { TenantObject } from "./tenant-object";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    TENANT: DurableObjectNamespace;
    TENANT_PG_URL: string;
  }
}

const describeIfPg = env.TENANT_PG_URL ? describe : describe.skip;
/** The history table of `createDurableObjectStorageWriter`. */
const HISTORY = "viborm_migration_estate";

const schemaOf = (doc: object) => parseSchema(doc, { validate: true });
const kindOf = (result: TenantChangeResult) => result.kind;

function request<T>(
  stub: DurableObjectStub,
  run: (tenant: TenantObject, state: DurableObjectState) => Promise<T>
): Promise<T> {
  return runInDurableObject(stub, run);
}

async function rows(tenant: TenantObject): Promise<number> {
  const result = await tenant.pool.query(
    `SELECT count(*)::int AS n FROM "${tenant.namespace}"."member"`
  );
  return result.rows[0].n;
}

async function columns(tenant: TenantObject): Promise<string[]> {
  const result = await tenant.pool.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'member'",
    [tenant.namespace]
  );
  return result.rows.map((row: { column_name: string }) => row.column_name);
}

/** A tenant with the first document applied and 10,000 members. */
async function seededTenant(): Promise<DurableObjectStub> {
  const stub = env.TENANT.get(env.TENANT.newUniqueId());
  await request(stub, async (tenant) => {
    await tenant.pool.query(`CREATE SCHEMA "${tenant.namespace}"`);
    const first = await tenant.migrator.change(schemaOf(memberDocument));
    if (first.kind !== "applied") throw new Error(JSON.stringify(first));
    await tenant.pool.query(
      seedMembersSql(`"${tenant.namespace}"."member"`, "now()")
    );
  });
  return stub;
}

async function dispose(stub: DurableObjectStub): Promise<void> {
  await request(stub, async (tenant) => {
    await tenant.pool.query(
      `DROP SCHEMA "${tenant.namespace}" CASCADE; DROP SCHEMA IF EXISTS "${tenant.namespace}_backup" CASCADE`
    );
    await tenant.pool.end();
  });
}

type HistoryRows = { key: string; bytes: ArrayBuffer }[];

/** The object's history rows, as a storage backup holds them. */
function backupHistory(stub: DurableObjectStub): Promise<HistoryRows> {
  return request(stub, async (_tenant, state) =>
    state.storage.sql
      .exec<HistoryRows[number]>(`SELECT key, bytes FROM ${HISTORY}`)
      .toArray()
  );
}

/** Restores the object's history from `backup`, then resets the object. */
async function restoreHistory(
  stub: DurableObjectStub,
  backup: HistoryRows
): Promise<DurableObjectStub> {
  await request(stub, async (_tenant, state) => {
    state.storage.sql.exec(`DELETE FROM ${HISTORY}`);
    for (const { key, bytes } of backup) {
      state.storage.sql.exec(
        `INSERT INTO ${HISTORY} (key, bytes) VALUES (?, ?)`,
        key,
        bytes
      );
    }
  });
  const reason = await reset(stub);
  if (reason !== "reset") throw new Error(`object not reset: ${reason}`);
  return env.TENANT.get(stub.id);
}

/** Resets the object, as an eviction or a crash would; its stub breaks. */
function reset(stub: DurableObjectStub): Promise<string> {
  return stub.fetch("http://tenant/reset").then(
    () => "not reset",
    (error: Error) => error.message
  );
}

describeIfPg("tenant restores (PostgreSQL)", () => {
  it("history older than the database: a change fails until reanchor moves the marker", async () => {
    let stub = await seededTenant();
    // The object's storage, backed up after the first change.
    const backup = await backupHistory(stub);
    const later = await request(stub, async (tenant) => [
      await tenant.migrator.change(schemaOf(noteDocument)),
      await tenant.migrator.change(schemaOf(noteTagDocument)),
    ]);
    expect(later.map(kindOf)).toEqual(["applied", "applied"]);
    const ahead = await request(
      stub,
      async (tenant) => (await tenant.migrator.status()).marker
    );
    if (!ahead) throw new Error("expected a marker");
    // Restored from the backup: the history lacks the database's two states.
    stub = await restoreHistory(stub, backup);
    const results = await request(stub, async (tenant) => {
      const restored = await tenant.migrator.status();
      // Published as one step from the restored state: another id.
      const changed = await tenant.migrator.change(schemaOf(noteTagDocument));
      const reanchored = await tenant.migrator.reanchor();
      const status = await tenant.migrator.status();
      const again = await tenant.migrator.change(schemaOf(noteTagDocument));
      return { restored, changed, reanchored, status, again };
    });
    expect(results.restored).toMatchObject({
      marker: ahead,
      markerState: "ahead",
    });
    expect(kindOf(results.changed)).toBe("failed");
    expect(results.changed).toMatchObject({
      error: { code: VibORMErrorCode.MIGRATION_NOT_FOUND },
      marker: ahead,
    });
    expect(results.reanchored.stateId).not.toBe(ahead.stateId);
    expect(results.status.marker).toMatchObject({
      stateId: results.reanchored.stateId,
      revision: ahead.revision + 1,
    });
    expect(results.status.markerState).toBeUndefined();
    expect(results.status.pending).toEqual([]);
    expect(kindOf(results.again)).toBe("noop");
    await request(stub, async (tenant) => {
      expect(await columns(tenant)).toEqual(
        expect.arrayContaining(["note", "tag"])
      );
      expect(await rows(tenant)).toBe(MEMBER_ROWS);
      const log = await tenant.migrator.log();
      expect(log.at(-1)).toMatchObject({
        kind: "reanchored",
        fromState: ahead.stateId,
        toState: results.reanchored.stateId,
      });
    });
    await dispose(stub);
  });

  it("history older than the database: the same documents again reproduce the lost states, with no reanchor", async () => {
    let stub = await seededTenant();
    const backup = await backupHistory(stub);
    await request(stub, async (tenant) => {
      await tenant.migrator.change(schemaOf(noteDocument));
      await tenant.migrator.change(schemaOf(noteTagDocument));
    });
    const marker = await request(
      stub,
      async (tenant) => (await tenant.migrator.status()).marker
    );
    stub = await restoreHistory(stub, backup);
    const results = await request(stub, async (tenant) => [
      await tenant.migrator.change(schemaOf(noteDocument)),
      await tenant.migrator.change(schemaOf(noteTagDocument)),
      await tenant.migrator.change(schemaOf(noteTagDocument)),
    ]);
    // The first is published but the marker is still ahead of it; the second
    // reproduces the marker's state, so there is nothing left to apply.
    expect(results[0]).toMatchObject({
      kind: "failed",
      error: { code: VibORMErrorCode.MIGRATION_NOT_FOUND },
    });
    expect(results.slice(1)).toEqual([
      { kind: "applied", path: [] },
      { kind: "noop" },
    ]);
    await request(stub, async (tenant) => {
      const status = await tenant.migrator.status();
      expect(status.marker).toEqual(marker);
      expect(status.markerState).toBeUndefined();
      expect(await rows(tenant)).toBe(MEMBER_ROWS);
    });
    await dispose(stub);
  });

  it("database older than the history: an ordinary change applies the state it lacks", async () => {
    const stub = await seededTenant();
    const results = await request(stub, async (tenant) => {
      const schema = `"${tenant.namespace}"`;
      const control = ["_viborm_migration_state", "_viborm_migration_log"];
      // The database's backup after the first change: its control rows.
      await tenant.pool.query(
        `CREATE SCHEMA "${tenant.namespace}_backup"; ${control
          .map(
            (table) =>
              `CREATE TABLE "${tenant.namespace}_backup"."${table}" AS TABLE ${schema}."${table}"`
          )
          .join("; ")}`
      );
      const applied = await tenant.migrator.change(schemaOf(noteDocument));
      // Restored from the backup: the control rows, and the table without
      // the column the second change added.
      await tenant.pool.query(
        `BEGIN; ${control
          .map(
            (table) =>
              `DELETE FROM ${schema}."${table}"; INSERT INTO ${schema}."${table}" SELECT * FROM "${tenant.namespace}_backup"."${table}"`
          )
          .join(
            "; "
          )}; ALTER TABLE ${schema}."member" DROP COLUMN "note"; COMMIT`
      );
      const restored = await tenant.migrator.status();
      const caughtUp = await tenant.migrator.change(schemaOf(noteDocument));
      const status = await tenant.migrator.status();
      return { applied, restored, caughtUp, status };
    });
    expect(kindOf(results.applied)).toBe("applied");
    expect(results.restored.markerState).toBeUndefined();
    expect(results.restored.pending).toHaveLength(1);
    expect(kindOf(results.caughtUp)).toBe("applied");
    expect(results.status.pending).toEqual([]);
    expect(results.status.marker?.stateId).toBe(results.restored.pending[0]);
    await request(stub, async (tenant) => {
      expect(await columns(tenant)).toContain("note");
      expect(await rows(tenant)).toBe(MEMBER_ROWS);
    });
    await dispose(stub);
  });

  it("a checkpoint pruned into a prefixed history in the object: reanchor, then the next change", async () => {
    const stub = await seededTenant();
    const results = await request(stub, async (tenant, state) => {
      await tenant.migrator.change(schemaOf(noteDocument));
      const checkpoint = await createMigrationClient(
        { $driver: tenant.client.$driver, $schema: schemaOf(noteDocument) },
        { storage: createDurableObjectStorageWriter(state.storage) }
      ).generate({ name: "checkpoint", from: null });
      if (!checkpoint.stateId) throw new Error("no checkpoint published");
      const into = createDurableObjectStorageWriter(state.storage, {
        prefix: "h2/",
      });
      const pruned = await tenant.migrator.prune({
        checkpoint: { id: checkpoint.stateId },
        into,
      });
      const bounded = createTenantMigrator({
        client: tenant.client,
        history: into,
      });
      const before = await bounded.status();
      const reanchored = await bounded.reanchor();
      const changed = await bounded.change(schemaOf(noteTagDocument));
      const again = await bounded.change(schemaOf(noteTagDocument));
      return {
        checkpoint: checkpoint.stateId,
        pruned,
        before,
        reanchored,
        changed,
        again,
        kept: (await into.listStates()).length,
      };
    });
    expect(results.pruned.states).toEqual([results.checkpoint]);
    expect(results.before.markerState).toBe("unknown");
    expect(results.reanchored.stateId).toBe(results.checkpoint);
    expect(kindOf(results.changed)).toBe("applied");
    expect(kindOf(results.again)).toBe("noop");
    expect(results.kept).toBe(2);
    await request(stub, async (tenant) => {
      expect(await columns(tenant)).toEqual(
        expect.arrayContaining(["note", "tag"])
      );
      expect(await rows(tenant)).toBe(MEMBER_ROWS);
    });
    await dispose(stub);
  });
});
