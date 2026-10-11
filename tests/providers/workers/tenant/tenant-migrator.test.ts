/**
 * Plan D4's gate: the tenant migrator inside a Durable Object, in Miniflare,
 * against PostgreSQL over workerd's outbound TCP (`pg` with `nodejs_compat`).
 * Each `runInDurableObject` call is one request into the object. Covered:
 * concurrent requests, an aborted request, a migration lock another command
 * holds, the object reset before and after the change publishes, its storage
 * reset, and a destructive change with and without approval, at 10,000 rows. Every outcome is one of the five. Project
 * `provider-tenant-do` (vitest.tenant-do.config.ts):
 *
 *   PG_TEST_CONNECTION_STRING=postgresql://postgres:password@127.0.0.1:5434/<db>
 *
 * Unset, the suite skips.
 */

import { env, runInDurableObject } from "cloudflare:test";
import { Socket } from "node:net";
import type {
  DurableObjectNamespace,
  DurableObjectState,
  DurableObjectStub,
} from "@cloudflare/workers-types";
import { VibORMErrorCode } from "@src/errors";
import { createMigrationClient } from "@src/migrations/client";
import { createDurableObjectStorageWriter } from "@src/migrations/storage/durable-object";
import type { TenantChangeResult } from "@src/migrations/tenant";
import { parseSchema } from "@src/schema/json";
import {
  approveLegacyRefDrop,
  droppedLegacyRefDocument,
  MEMBER_ROWS,
  memberDocument,
  noteDocument,
  noteTagDocument,
  seedMembersSql,
  TENANT_OUTCOMES,
} from "@tests/fixtures/tenant-member";
import pg from "pg";
import type { TenantObject } from "./tenant-object";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    TENANT: DurableObjectNamespace;
    TENANT_PG_URL: string;
  }
}

const describeIfPg = env.TENANT_PG_URL ? describe : describe.skip;
/** The advisory lock every PostgreSQL migration command takes. */
const MIGRATION_LOCK_ID = 0x76_69_62_6f_72_6d;
const KINDS: readonly string[] = TENANT_OUTCOMES;

const schemaOf = (doc: object) => parseSchema(doc, { validate: true });

function kindOf(result: TenantChangeResult): string {
  return KINDS.includes(result.kind) ? result.kind : `not one: ${result.kind}`;
}

/** One request into the tenant's object. */
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
    await tenant.pool.query(`DROP SCHEMA "${tenant.namespace}" CASCADE`);
    await tenant.pool.end();
  });
}

/** Resets the object, as an eviction or a crash would; its stub breaks. */
function reset(stub: DurableObjectStub): Promise<string> {
  return stub.fetch("http://tenant/reset").then(
    () => "not reset",
    (error: Error) => error.message
  );
}

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describeIfPg("tenant migrator in a Durable Object (PostgreSQL)", () => {
  it("applies a new tenant's first change given beforeDestructive, without asking", async () => {
    const stub = env.TENANT.get(env.TENANT.newUniqueId());
    const outcome = await request(stub, async (tenant) => {
      await tenant.pool.query(`CREATE SCHEMA "${tenant.namespace}"`);
      let asked = 0;
      const result = await tenant.migrator.change(schemaOf(memberDocument), {
        beforeDestructive: () => {
          asked += 1;
        },
      });
      return { kind: kindOf(result), asked, columns: await columns(tenant) };
    });
    expect(outcome).toMatchObject({ kind: "applied", asked: 0 });
    expect(outcome.columns).toContain("legacyRef");
    await dispose(stub);
  });

  it("serializes concurrent requests, so the history stays linear", async () => {
    const stub = await seededTenant();
    const results = await Promise.all(
      [noteDocument, noteTagDocument, noteTagDocument].map((doc) =>
        request(stub, (tenant) => tenant.migrator.change(schemaOf(doc)))
      )
    );
    expect(results.map(kindOf)).toEqual(["applied", "applied", "noop"]);
    await request(stub, async (tenant, state) => {
      const { leaves, states } = await createMigrationClient(tenant.client, {
        storage: createDurableObjectStorageWriter(state.storage),
      }).graph();
      expect({ leaves: leaves.length, states: states.length }).toEqual({
        leaves: 1,
        states: 3,
      });
      expect(await columns(tenant)).toEqual(
        expect.arrayContaining(["note", "tag"])
      );
      expect(await rows(tenant)).toBe(MEMBER_ROWS);
      // Outcomes and status are plain data: they cross RPC intact.
      const status = await tenant.migrator.status();
      expect(structuredClone(status)).toEqual(status);
      expect(structuredClone(results)).toEqual(results);
    });
    await dispose(stub);
  });

  it("an aborted request leaves the queue as failed and changes nothing", async () => {
    const stub = await seededTenant();
    let restorePoints = 0;
    const slow = request(stub, (tenant) =>
      tenant.migrator.change(schemaOf(droppedLegacyRefDocument), {
        decisions: [approveLegacyRefDrop],
        beforeDestructive: async () => {
          restorePoints += 1;
          await wait(300);
        },
      })
    );
    const aborted = await request(stub, (tenant) =>
      tenant.migrator.change(schemaOf(noteDocument), {
        signal: AbortSignal.timeout(50),
      })
    );
    expect(kindOf(aborted)).toBe("failed");
    expect(aborted).toMatchObject({ error: { name: "TimeoutError" } });
    expect(kindOf(await slow)).toBe("applied");
    expect(restorePoints).toBe(1);
    await request(stub, async (tenant) => {
      const present = await columns(tenant);
      expect(present).not.toContain("note");
      expect(present).not.toContain("legacyRef");
      expect(await rows(tenant)).toBe(MEMBER_ROWS);
    });
    await dispose(stub);
  });

  it("refuses an unapproved drop and applies an approved one after the restore point", async () => {
    const stub = await seededTenant();
    let restorePoints = 0;
    const beforeDestructive = () => {
      restorePoints += 1;
    };
    const refused = await request(stub, (tenant) =>
      tenant.migrator.change(schemaOf(droppedLegacyRefDocument), {
        beforeDestructive,
      })
    );
    expect(kindOf(refused)).toBe("refused");
    expect(refused).toMatchObject({
      error: { code: VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED },
    });
    expect(restorePoints).toBe(0);
    await request(stub, async (tenant) => {
      expect(await columns(tenant)).toContain("legacyRef");
    });
    const applied = await request(stub, (tenant) =>
      tenant.migrator.change(schemaOf(droppedLegacyRefDocument), {
        decisions: [approveLegacyRefDrop],
        beforeDestructive,
      })
    );
    expect(kindOf(applied)).toBe("applied");
    expect(restorePoints).toBe(1);
    await request(stub, async (tenant) => {
      expect(await columns(tenant)).not.toContain("legacyRef");
      expect(await rows(tenant)).toBe(MEMBER_ROWS);
    });
    await dispose(stub);
  });

  it("retries while another command holds the migration lock, then applies", async () => {
    const stub = await seededTenant();
    const outcome = await request(stub, async (tenant) => {
      // Another migration command on the same database: the CLI, a script.
      const other = await tenant.pool.connect();
      await other.query(`SELECT pg_advisory_lock(${MIGRATION_LOCK_ID})`);
      const started = Date.now();
      const release = wait(800).then(async () => {
        await other.query(`SELECT pg_advisory_unlock(${MIGRATION_LOCK_ID})`);
        other.release();
      });
      const result = await tenant.migrator.change(schemaOf(noteDocument));
      await release;
      return { kind: kindOf(result), waited: Date.now() - started };
    });
    // The first attempt gave up after lockWait (500 ms); a later one applied.
    expect(outcome.kind).toBe("applied");
    expect(outcome.waited).toBeGreaterThanOrEqual(800);
    await request(stub, async (tenant) => {
      expect(await columns(tenant)).toContain("note");
    });
    await dispose(stub);
  });

  it("an object reset before the change publishes loses only that request; the next one applies", async () => {
    let stub = await seededTenant();
    let reached = (): void => undefined;
    const parked = new Promise<void>((resolve) => {
      reached = resolve;
    });
    // The request dies with the object: its rejection is read at once.
    const dying = request(stub, (tenant) =>
      tenant.migrator.change(schemaOf(droppedLegacyRefDocument), {
        decisions: [approveLegacyRefDrop],
        // Parked until the reset: the restore point never finishes.
        beforeDestructive: () => {
          reached();
          return new Promise<never>(() => undefined);
        },
      })
    ).then(
      (result) => `completed ${result.kind}`,
      (error: Error) => error.message
    );
    await parked;
    expect(await reset(stub)).toBe("reset");
    expect(await dying).toBe("reset");
    // A new instance: the queue is gone, the history and the database stay.
    stub = env.TENANT.get(stub.id);
    const after = await request(stub, async (tenant) => {
      expect(await columns(tenant)).toContain("legacyRef");
      return tenant.migrator.change(schemaOf(droppedLegacyRefDocument), {
        decisions: [approveLegacyRefDrop],
      });
    });
    expect(kindOf(after)).toBe("applied");
    await request(stub, async (tenant) => {
      expect(await columns(tenant)).not.toContain("legacyRef");
      expect(await rows(tenant)).toBe(MEMBER_ROWS);
    });
    await dispose(stub);
  });

  it("an object reset during apply leaves the published state, which the next request applies", async () => {
    let stub = await seededTenant();
    const namespace = await request(stub, (tenant) =>
      Promise.resolve(tenant.namespace)
    );
    // Another session holds the table, so apply blocks under its own lock.
    const holder = new pg.Client({
      connectionString: env.TENANT_PG_URL,
      stream: () => new Socket(),
    });
    await holder.connect();
    await holder.query("BEGIN");
    await holder.query(
      `LOCK TABLE "${namespace}"."member" IN ACCESS EXCLUSIVE MODE`
    );
    const dying = request(stub, (tenant) =>
      tenant.migrator.change(schemaOf(noteDocument))
    ).then(
      (result) => `completed ${result.kind}`,
      (error: Error) => error.message
    );
    let blocked = 0;
    for (let poll = 0; poll < 100 && blocked === 0; poll += 1) {
      await wait(50);
      const waiting = await holder.query(
        "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database() AND query LIKE $1",
        [`%${namespace}%`]
      );
      blocked = waiting.rowCount ?? 0;
    }
    expect(blocked).toBe(1);
    expect(await reset(stub)).toBe("reset");
    expect(await dying).toBe("reset");
    await holder.query("ROLLBACK");
    await holder.end();
    stub = env.TENANT.get(stub.id);
    const results = await request(stub, async (tenant) => {
      const status = await tenant.migrator.status();
      // Published before the reset; the database never moved.
      expect(status.pending).toHaveLength(1);
      expect(status.unfinished).toBe(false);
      expect(await columns(tenant)).not.toContain("note");
      return [
        await tenant.migrator.change(schemaOf(noteDocument)),
        await tenant.migrator.change(schemaOf(noteDocument)),
      ];
    });
    expect(results.map(kindOf)).toEqual(["applied", "noop"]);
    await request(stub, async (tenant) => {
      expect(await columns(tenant)).toContain("note");
      expect(await rows(tenant)).toBe(MEMBER_ROWS);
    });
    await dispose(stub);
  });

  it("a storage reset fails against the database's marker, which stays", async () => {
    let stub = await seededTenant();
    const before = await request(stub, async (tenant) => {
      return (await tenant.migrator.status()).marker;
    });
    await request(stub, async (_tenant, state) => {
      await state.storage.deleteAll();
    });
    expect(await reset(stub)).toBe("reset");
    stub = env.TENANT.get(stub.id);
    const result = await request(stub, (tenant) =>
      tenant.migrator.change(schemaOf(noteDocument))
    );
    // The document was published into the empty history as a new root.
    expect(kindOf(result)).toBe("failed");
    expect(result).toMatchObject({
      error: { code: VibORMErrorCode.MIGRATION_NOT_FOUND },
      marker: before,
    });
    await request(stub, async (tenant, state) => {
      const { states } = await createMigrationClient(tenant.client, {
        storage: createDurableObjectStorageWriter(state.storage),
      }).graph();
      expect(states).toHaveLength(1);
      expect((await tenant.migrator.status()).marker).toEqual(before);
      expect(await columns(tenant)).not.toContain("note");
      expect(await rows(tenant)).toBe(MEMBER_ROWS);
    });
    await dispose(stub);
  });
});
