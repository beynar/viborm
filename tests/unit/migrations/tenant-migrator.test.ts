/**
 * Plan D4: the tenant migrator, a helper over `createMigrationClient`, on
 * SQLite at 10,000 rows. Every outcome is one of five, changes run one at a
 * time per migrator, a signal stops a queued or retrying change, retryable
 * failures are retried with backoff, and `beforeDestructive` runs between
 * the preview and the first effect of a destructive change.
 *
 * The Durable Object suite (`tests/providers/workers/tenant/tenant-migrator.test.ts`)
 * runs the same helper in Miniflare against PostgreSQL.
 */

import { createClient } from "@drivers/sqlite3";
import { VibORMErrorCode } from "@errors";
import { createMigrationClient } from "@migrations/client";
import { MemoryEstateStorage } from "@migrations/storage/memory";
import {
  createTenantMigrator,
  type TenantChangeResult,
  type TenantMigrator,
} from "@migrations/tenant";
import type { MigrationDecisionV1 } from "@migrations/v1-types";
import { parseSchema } from "@schema/json";
import {
  approveLegacyRefDrop,
  droppedLegacyRefDocument,
  MEMBER_ROWS,
  memberDocument,
  noteDocument,
  noteTagDocument,
  reorderedMemberDocument,
  seedMembersSql,
  TENANT_OUTCOMES,
} from "@tests/fixtures/tenant-member";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const COMMIT = /^\s*COMMIT\b/i;
const KINDS: readonly string[] = TENANT_OUTCOMES;

const schemaOf = (doc: object) => parseSchema(doc, { validate: true });

const SEED = seedMembersSql('"member"', "'2026-10-11T00:00:00.000Z'");

/**
 * A better-sqlite3 handle that runs the first COMMIT after a statement
 * containing `armedBy` through `around`, through `exec` or a prepared
 * statement alike.
 */
function armedCommit(
  db: Database.Database,
  armedBy: string,
  around: (commit: () => unknown) => unknown
): Database.Database {
  let armed = false;
  let spent = false;
  const once = (commit: () => unknown) => {
    spent = true;
    return around(commit);
  };
  return new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (property !== "exec" && property !== "prepare") {
        return value.bind(target);
      }
      return (text: string, ...rest: unknown[]) => {
        if (text.includes(armedBy)) armed = true;
        if (spent || !(armed && COMMIT.test(text))) {
          return value.call(target, text, ...rest);
        }
        if (property === "exec") return once(() => value.call(target, text));
        const statement = value.call(target, text, ...rest);
        return new Proxy(statement, {
          get(inner, member) {
            const method = Reflect.get(inner, member, inner);
            if (typeof method !== "function") return method;
            return member === "run"
              ? (...args: unknown[]) => once(() => method.apply(inner, args))
              : method.bind(inner);
          },
        });
      };
    },
  });
}

/** A handle whose statements containing `match` throw `code` while armed. */
function failing(db: Database.Database, match: string, code: string) {
  const state = { armed: true, thrown: 0 };
  const handle = new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (property !== "exec" && property !== "prepare") {
        return value.bind(target);
      }
      return (text: string, ...rest: unknown[]) => {
        if (state.armed && text.includes(match)) {
          state.thrown += 1;
          throw Object.assign(new Error(`injected ${code}`), { code });
        }
        return value.call(target, text, ...rest);
      };
    },
  });
  return { handle, state };
}

function tenant(handle: Database.Database = new Database(":memory:")) {
  const history = new MemoryEstateStorage();
  const client = createClient({
    client: handle,
    schema: schemaOf(memberDocument),
  });
  const migrator = createTenantMigrator({ client, history });
  return { client, history, migrator };
}

/** The outcome's kind, checked to be one of the five. */
function kindOf(result: TenantChangeResult): string {
  return KINDS.includes(result.kind) ? result.kind : `not one: ${result.kind}`;
}

async function seeded(migrator: TenantMigrator, db: Database.Database) {
  const first = await migrator.change(schemaOf(memberDocument));
  if (first.kind !== "applied") throw new Error(JSON.stringify(first));
  db.exec(SEED);
}

const columns = (db: Database.Database) =>
  (db.prepare(`PRAGMA table_info("member")`).all() as { name: string }[]).map(
    ({ name }) => name
  );

describe("tenant migrator outcomes", () => {
  it("applies, then answers noop for the same and for a reordered document", async () => {
    const db = new Database(":memory:");
    const { history, migrator } = tenant(db);
    await seeded(migrator, db);
    expect(kindOf(await migrator.change(schemaOf(memberDocument)))).toBe(
      "noop"
    );
    const states = (await history.listStates()).length;
    // Decision 8: field order is cosmetic, and nothing is published.
    expect(
      kindOf(await migrator.change(schemaOf(reorderedMemberDocument)))
    ).toBe("noop");
    expect((await history.listStates()).length).toBe(states);
    expect(db.prepare(`SELECT count(*) AS n FROM "member"`).get()).toEqual({
      n: MEMBER_ROWS,
    });
    expect(await migrator.log()).toEqual(expect.any(Array));
    expect((await migrator.status()).pending).toEqual([]);
  });

  it("refuses an unapproved drop before any effect, and never asks beforeDestructive", async () => {
    const db = new Database(":memory:");
    const { history, migrator } = tenant(db);
    await seeded(migrator, db);
    const states = (await history.listStates()).length;
    let asked = 0;
    const result = await migrator.change(schemaOf(droppedLegacyRefDocument), {
      beforeDestructive: () => {
        asked += 1;
      },
    });
    expect(kindOf(result)).toBe("refused");
    expect(result).toMatchObject({
      error: { code: VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED },
    });
    expect(asked).toBe(0);
    expect((await history.listStates()).length).toBe(states);
    expect(columns(db)).toContain("legacyRef");
  });

  it("calls beforeDestructive once between the preview and the drop of an approved change", async () => {
    const db = new Database(":memory:");
    const { migrator } = tenant(db);
    await seeded(migrator, db);
    const seen: string[][] = [];
    const result = await migrator.change(schemaOf(droppedLegacyRefDocument), {
      decisions: [approveLegacyRefDrop],
      beforeDestructive: () => {
        seen.push(columns(db));
      },
    });
    expect(kindOf(result)).toBe("applied");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("legacyRef");
    expect(columns(db)).not.toContain("legacyRef");
    expect(db.prepare(`SELECT count(*) AS n FROM "member"`).get()).toEqual({
      n: MEMBER_ROWS,
    });
  });

  it("is refused, with nothing published, when beforeDestructive throws", async () => {
    const db = new Database(":memory:");
    const { history, migrator } = tenant(db);
    await seeded(migrator, db);
    const states = (await history.listStates()).length;
    const result = await migrator.change(schemaOf(droppedLegacyRefDocument), {
      decisions: [approveLegacyRefDrop],
      beforeDestructive: () => {
        throw new Error("no restore point");
      },
    });
    expect(result).toEqual({
      kind: "refused",
      error: { name: "Error", message: "no restore point" },
    });
    // A rejection that is not an Error is described the same way.
    expect(
      await migrator.change(schemaOf(droppedLegacyRefDocument), {
        decisions: [approveLegacyRefDrop],
        beforeDestructive: () => Promise.reject("no restore point"),
      })
    ).toEqual(result);
    expect((await history.listStates()).length).toBe(states);
    expect(columns(db)).toContain("legacyRef");
  });

  it("asks beforeDestructive for a destructive state published earlier and still pending", async () => {
    const db = new Database(":memory:");
    const { handle, state } = failing(db, "DROP COLUMN", "SQLITE_CONSTRAINT");
    const { migrator } = tenant(handle);
    await seeded(migrator, db);
    const failed = await migrator.change(schemaOf(droppedLegacyRefDocument), {
      decisions: [approveLegacyRefDrop],
    });
    expect(kindOf(failed)).toBe("failed");
    expect(state.thrown).toBe(1);
    state.armed = false;
    let asked = 0;
    // The same request again: nothing new to publish, but the drop is
    // pending. Its decisions answer nothing now, and are not refused for it.
    const result = await migrator.change(schemaOf(droppedLegacyRefDocument), {
      decisions: [approveLegacyRefDrop],
      beforeDestructive: () => {
        asked += 1;
      },
    });
    expect(kindOf(result)).toBe("applied");
    expect(asked).toBe(1);
    expect(columns(db)).not.toContain("legacyRef");
  });

  it("returns failed with the marker reached and a durable failed event", async () => {
    const db = new Database(":memory:");
    const { handle, state } = failing(
      db,
      `ADD COLUMN "note"`,
      "SQLITE_CONSTRAINT"
    );
    const { migrator } = tenant(handle);
    await seeded(migrator, db);
    const before = (await migrator.status()).marker;
    const result = await migrator.change(schemaOf(noteDocument));
    expect(kindOf(result)).toBe("failed");
    // Not retryable: one attempt.
    expect(state.thrown).toBe(1);
    expect(result).toMatchObject({
      error: { code: VibORMErrorCode.MIGRATION_FAILED },
      marker: { stateId: before?.stateId, revision: before?.revision },
    });
    const status = await migrator.status();
    expect(status.lastFailure).toMatchObject({ kind: "failed" });
    // The state stays published: the next call applies it.
    state.armed = false;
    expect(kindOf(await migrator.change(schemaOf(noteDocument)))).toBe(
      "applied"
    );
  });

  it("returns failed, not refused, when apply refuses the state this change published", async () => {
    const db = new Database(":memory:");
    const { history, migrator } = tenant(db);
    await seeded(migrator, db);
    const before = (await migrator.status()).marker;
    const states = (await history.listStates()).length;
    // Out-of-band drift, which only apply can see: generate reads no database.
    db.exec(`CREATE INDEX "oob" ON "member" ("displayName")`);
    const result = await migrator.change(schemaOf(noteDocument));
    expect(kindOf(result)).toBe("failed");
    expect(result).toMatchObject({
      error: { code: VibORMErrorCode.MIGRATION_DRIFT },
      marker: { stateId: before?.stateId, revision: before?.revision },
    });
    expect((await history.listStates()).length).toBe(states + 1);
    expect((await migrator.status()).pending).toHaveLength(1);
    expect(columns(db)).not.toContain("note");
    // Again, with nothing new to publish: this call changes nothing.
    expect(kindOf(await migrator.change(schemaOf(noteDocument)))).toBe(
      "refused"
    );
    expect((await history.listStates()).length).toBe(states + 1);
    // Once the drift is repaired, the same document applies the state.
    db.exec(`DROP INDEX "oob"`);
    expect(kindOf(await migrator.change(schemaOf(noteDocument)))).toBe(
      "applied"
    );
    expect(columns(db)).toContain("note");
  });

  it("returns ambiguous when the COMMIT's reply is lost, and a fresh migrator finds it landed", async () => {
    const db = new Database(":memory:");
    const handle = armedCommit(db, `ADD COLUMN "note"`, (commit) => {
      commit();
      throw new Error("connection lost after COMMIT");
    });
    const history = new MemoryEstateStorage();
    const migrator = createTenantMigrator({
      client: createClient({
        client: handle,
        schema: schemaOf(memberDocument),
      }),
      history,
    });
    await seeded(migrator, db);
    const result = await migrator.change(schemaOf(noteDocument));
    expect(kindOf(result)).toBe("ambiguous");
    expect(result).toMatchObject({
      error: { code: VibORMErrorCode.MIGRATION_AMBIGUOUS_COMMIT },
    });
    const fresh = createTenantMigrator({
      client: createClient({ client: db, schema: schemaOf(noteDocument) }),
      history,
    });
    // The marker read after the failure, on a new session, shows it landed.
    const landed = (await fresh.status()).marker;
    expect(result).toMatchObject({ marker: { stateId: landed?.stateId } });
    expect(kindOf(await fresh.change(schemaOf(noteDocument)))).toBe("noop");
    expect(columns(db)).toContain("note");
  });

  it("stays ambiguous, without a marker, when the connection dies with the COMMIT", async () => {
    const db = new Database(":memory:");
    const handle = armedCommit(db, `ADD COLUMN "note"`, (commit) => {
      commit();
      db.close();
      throw new Error("connection lost after COMMIT");
    });
    const { migrator } = tenant(handle);
    await seeded(migrator, db);
    const result = await migrator.change(schemaOf(noteDocument));
    expect(result).toEqual({
      kind: "ambiguous",
      error: expect.objectContaining({
        code: VibORMErrorCode.MIGRATION_AMBIGUOUS_COMMIT,
      }),
    });
  });

  it("never retries an ambiguous COMMIT, even when its cause is transient", async () => {
    const db = new Database(":memory:");
    let commits = 0;
    const handle = armedCommit(db, `ADD COLUMN "note"`, (commit) => {
      commits += 1;
      commit();
      throw Object.assign(new Error("database is locked"), {
        code: "SQLITE_BUSY",
      });
    });
    const { migrator } = tenant(handle);
    await seeded(migrator, db);
    const result = await migrator.change(schemaOf(noteDocument));
    expect(result).toMatchObject({
      kind: "ambiguous",
      error: { code: VibORMErrorCode.MIGRATION_AMBIGUOUS_COMMIT },
    });
    expect(commits).toBe(1);
  });
});

describe("tenant migrator concurrency, deadline and retry", () => {
  it("runs concurrent changes one at a time, so history stays linear", async () => {
    const db = new Database(":memory:");
    const { client, history, migrator } = tenant(db);
    await seeded(migrator, db);
    const results = await Promise.all([
      migrator.change(schemaOf(noteDocument)),
      migrator.change(schemaOf(noteTagDocument)),
      migrator.change(schemaOf(noteTagDocument)),
    ]);
    expect(results.map(({ kind }) => kind)).toEqual([
      "applied",
      "applied",
      "noop",
    ]);
    // Concurrent generates from one leaf would fork it: apply then refuses.
    const { leaves, states } = await createMigrationClient(client, {
      storage: history,
    }).graph();
    expect({ leaves: leaves.length, states: states.length }).toEqual({
      leaves: 1,
      states: 3,
    });
    expect(columns(db)).toEqual(expect.arrayContaining(["note", "tag"]));
  });

  it("a queued change whose signal aborts leaves as failed and touches nothing", async () => {
    const db = new Database(":memory:");
    const { history, migrator } = tenant(db);
    await seeded(migrator, db);
    let open = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let parked = (): void => undefined;
    const reached = new Promise<void>((resolve) => {
      parked = resolve;
    });
    const first = migrator.change(schemaOf(droppedLegacyRefDocument), {
      decisions: [approveLegacyRefDrop],
      beforeDestructive: () => {
        parked();
        return gate;
      },
    });
    await reached;
    const controller = new AbortController();
    const queued = migrator.change(schemaOf(noteDocument), {
      signal: controller.signal,
    });
    // Unqueued, the change would finish here; queued, it is still waiting.
    const settled = await Promise.race([
      queued.then(() => "settled"),
      new Promise((resolve) => setTimeout(resolve, 200, "waiting")),
    ]);
    expect(settled).toBe("waiting");
    controller.abort(new Error("request closed"));
    const aborted = await queued;
    expect(aborted).toEqual({
      kind: "failed",
      error: { name: "Error", message: "request closed" },
    });
    const states = (await history.listStates()).length;
    open();
    expect(kindOf(await first)).toBe("applied");
    expect((await history.listStates()).length).toBe(states + 1);
    expect(columns(db)).not.toContain("note");
    // An already-aborted signal never starts.
    expect(
      kindOf(
        await migrator.change(schemaOf(noteDocument), {
          signal: AbortSignal.abort(),
        })
      )
    ).toBe("failed");
    expect(columns(db)).not.toContain("note");
  });

  it("retries a COMMIT refused under contention with backoff, then applies", async () => {
    const db = new Database(":memory:");
    let refused = 0;
    const handle = armedCommit(db, `ADD COLUMN "note"`, () => {
      refused += 1;
      throw Object.assign(new Error("database is locked"), {
        code: "SQLITE_BUSY",
      });
    });
    const { migrator } = tenant(handle);
    await seeded(migrator, db);
    const result = await migrator.change(schemaOf(noteDocument));
    expect(kindOf(result)).toBe("applied");
    expect(refused).toBe(1);
    expect(columns(db)).toContain("note");
  });

  it("stops retrying after four attempts, or when the signal aborts the backoff", async () => {
    const db = new Database(":memory:");
    const { handle, state } = failing(db, `ADD COLUMN "note"`, "SQLITE_BUSY");
    const { migrator } = tenant(handle);
    await seeded(migrator, db);
    const exhausted = await migrator.change(schemaOf(noteDocument));
    expect(kindOf(exhausted)).toBe("failed");
    expect(state.thrown).toBe(4);
    expect(exhausted).toMatchObject({
      error: { code: VibORMErrorCode.MIGRATION_FAILED },
      marker: { stateId: expect.any(String) },
    });
    state.thrown = 0;
    const started = Date.now();
    const bounded = await migrator.change(schemaOf(noteDocument), {
      signal: AbortSignal.timeout(50),
    });
    expect(kindOf(bounded)).toBe("failed");
    expect(state.thrown).toBeLessThan(4);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("refuses invalid decisions as data", async () => {
    const { migrator } = tenant();
    const result = await migrator.change(schemaOf(memberDocument), {
      decisions: [{ type: "rename" } as unknown as MigrationDecisionV1],
    });
    expect(kindOf(result)).toBe("refused");
    expect(result).toMatchObject({
      error: { code: VibORMErrorCode.INVALID_INPUT },
    });
  });

  it("runs resolve and down in the same queue as change", async () => {
    const db = new Database(":memory:");
    const { migrator } = tenant(db);
    await seeded(migrator, db);
    const order: string[] = [];
    let open = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const change = migrator
      .change(schemaOf(droppedLegacyRefDocument), {
        decisions: [approveLegacyRefDrop],
        beforeDestructive: () => gate,
      })
      .then(() => order.push("change"));
    const down = migrator.down({ dryRun: true }).then(() => order.push("down"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    open();
    await Promise.all([change, down]);
    expect(order).toEqual(["change", "down"]);
    await expect(migrator.resolve({ outcome: "complete" })).rejects.toThrow();
  });
});
