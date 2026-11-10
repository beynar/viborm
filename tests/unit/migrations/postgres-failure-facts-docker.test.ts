/**
 * What a failure tells its caller on a real PostgreSQL through `pg`: the two
 * cases PGlite cannot stage (see `postgres-migration-failure-facts.test.ts`
 * for the rest).
 *
 * - A connection cut under a statement is a retryable `ConnectionError`, not
 *   a refused statement (`V2001` with no code, before 1.5.1).
 * - `reset()` stopped by `lock_timeout` in its clear is a `MigrationError`
 *   naming its step, target, statement and boundary, and, with the client's
 *   `instrumentation({ diagnostics })`, the provider's text and the SQL.
 *   Pyxel's production reset failed as `V2001 { driver, operation:
 *   "transaction" }`, redacted although diagnostics were on.
 *
 * Gated like every Docker suite:
 *   PG_TEST_CONNECTION_STRING=postgresql://postgres:password@127.0.0.1:5434/<db>
 */

import net from "node:net";
import { createClient } from "@drivers/pg";
import { VibORMErrorCode } from "@errors";
import { instrumentation } from "@instrumentation/extension";
import { createMigrationClient } from "@migrations";
import { MemoryEstateStorage } from "@migrations/storage/memory";
import { s } from "@schema";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PG_CONNECTION = process.env.PG_TEST_CONNECTION_STRING;
const describeIfPg = PG_CONNECTION ? describe : describe.skip;

const NAMESPACE = "viborm_failure_facts";
const legacy = {
  legacy: s.model({ id: s.string().id(), note: s.string() }).map("legacy"),
};
const current = {
  account: s.model({ id: s.string().id(), email: s.string() }).map("account"),
};

/** Every message down the cause chain, outermost first. */
function causeMessages(error: unknown): string[] {
  const messages: string[] = [];
  let link = (error as { cause?: unknown }).cause;
  while (link instanceof Error) {
    messages.push(link.message);
    link = link.cause;
  }
  return messages;
}

describeIfPg("failure facts on a real server", () => {
  const admin = new pg.Client({ connectionString: PG_CONNECTION });

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS "${NAMESPACE}" CASCADE`);
    await admin.query(`CREATE SCHEMA "${NAMESPACE}"`);
  });

  afterAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS "${NAMESPACE}" CASCADE`);
    await admin.end();
  });

  it("classifies a connection cut under a statement as a retryable ConnectionError", async () => {
    const target = new URL(PG_CONNECTION!);
    // Forwards to the server, then drops both sides while the statement runs.
    const proxy = net.createServer((socket) => {
      const upstream = net.connect(
        Number(target.port || 5432),
        target.hostname
      );
      socket.pipe(upstream).pipe(socket);
      socket.on("error", () => undefined);
      upstream.on("error", () => undefined);
      setTimeout(() => {
        socket.destroy();
        upstream.destroy();
      }, 500);
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const { port } = proxy.address() as net.AddressInfo;
    const via = new URL(PG_CONNECTION!);
    via.hostname = "127.0.0.1";
    via.port = String(port);
    const client = createClient({ databaseUrl: via.toString(), schema: {} });
    try {
      const failure = await client.$queryRawUnsafe("SELECT pg_sleep(5)").then(
        () => undefined,
        (error: unknown) => error
      );
      expect(failure).toMatchObject({
        name: "ConnectionError",
        code: VibORMErrorCode.CONNECTION_FAILED,
      });
      expect((failure as { isRetryable(): boolean }).isRetryable()).toBe(true);
    } finally {
      await client.$disconnect().catch(() => undefined);
      await new Promise((resolve) => proxy.close(resolve));
    }
  });

  it("names a reset's clear stopped by lock_timeout, and discloses it per the client's diagnostics", async () => {
    const old = createClient({
      databaseUrl: PG_CONNECTION,
      namespace: NAMESPACE,
      schema: legacy,
    });
    const base = createClient({
      databaseUrl: PG_CONNECTION,
      namespace: NAMESPACE,
      schema: current,
    });
    const instrumented = base.$extends(
      instrumentation({
        diagnostics: { includeProviderDetails: true, includeSql: true },
      })
    );
    const blocker = new pg.Client({ connectionString: PG_CONNECTION });
    try {
      const retired = createMigrationClient(old, {
        storage: new MemoryEstateStorage(),
      });
      await retired.generate({ name: "retired" });
      await retired.apply();
      // A fresh history: reset clears the retired one, then replays this.
      const fresh = createMigrationClient(instrumented, {
        storage: new MemoryEstateStorage(),
        limits: { lockTimeout: 500 },
      });
      const target = (await fresh.generate({ name: "fresh-root" })).stateId!;
      await blocker.connect();
      await blocker.query("BEGIN");
      await blocker.query(
        `LOCK TABLE "${NAMESPACE}"."legacy" IN ACCESS SHARE MODE`
      );

      const failure = await fresh.reset().then(
        () => undefined,
        (error: unknown) => error
      );
      expect(failure).toMatchObject({
        name: "MigrationError",
        code: VibORMErrorCode.MIGRATION_FAILED,
        meta: {
          step: "reset-clear",
          stateId: target,
          statementIndex: expect.any(Number),
          strategy: "transactional",
          providerSqlState: "55P03",
        },
        cause: { code: VibORMErrorCode.TRANSACTION_CONTENTION },
      });
      expect(causeMessages(failure).join(" | ")).toContain("lock timeout");
      // With includeSql, the statement: a wrapped cause keeps no meta.
      expect((failure as { meta: { query?: string } }).meta.query).toContain(
        "DROP TABLE"
      );

      await blocker.query("ROLLBACK");
      await expect(fresh.reset()).resolves.toMatchObject({ preview: false });
    } finally {
      await blocker.end().catch(() => undefined);
      await old.$disconnect();
      await base.$disconnect();
    }
  });
});
