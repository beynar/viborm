import { randomUUID } from "node:crypto";
import { createClient } from "@client/client";
import { NeonHTTPDriver } from "@drivers/neon-http";
import { PgDriver } from "@drivers/pg";
import { PostgresDriver, vibormTypes } from "@drivers/postgres";
import { Decimal, s } from "@src/index";
import { Pool } from "pg";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const POOLER_PATTERN = /-pooler(?=\.)/;

const databaseUrl =
  process.env.NEON_DATABASE_URL ?? process.env.NEON_TEST_DATABASE_URL;
// Each execution owns one empty persistent fixture. No DROP/TRUNCATE runs on
// this caller's endpoint; the name is retained in the remediation report.
const table = `viborm_v1_${randomUUID().replace(/-/g, "")}`;
const evidence = s
  .model({
    id: s.string().id(),
    localAt: s.dateTime().withoutTimezone(),
    instant: s.dateTime(),
    instants: s.dateTime().array(),
    flags: s.boolean().array(),
    keys: s.bigInt().array(),
    amount: s.decimal({ precision: 20, scale: 2 }),
  })
  .map(table);

const schema = { evidence };
const localAt = new Date("2026-10-08T12:34:56.789Z");
const instant = new Date("0000-01-01T00:00:00.000Z");
const keys = [9007199254740993n, -9007199254740993n];
const instants = [
  new Date("0000-01-01T00:00:00.000Z"),
  new Date("0001-01-01T00:00:00.000Z"),
  new Date("0099-12-31T23:59:59.999Z"),
];

describe.skipIf(!databaseUrl)("V1 real Neon HTTP and TCP contracts", () => {
  const http = new NeonHTTPDriver({ databaseUrl });
  const originalTimezone = process.env.TZ;
  beforeAll(async () => {
    process.env.TZ = "America/New_York";
    await http._executeRaw(
      `CREATE TABLE "public"."${table}" (id TEXT PRIMARY KEY, "localAt" TIMESTAMP(3) NOT NULL, instant TIMESTAMPTZ(3) NOT NULL, instants TIMESTAMPTZ(3)[] NOT NULL, flags BOOLEAN[] NOT NULL, keys BIGINT[] NOT NULL, amount NUMERIC(20,2) NOT NULL)`
    );
  });
  afterAll(async () => {
    try {
      await http._executeRaw(`DELETE FROM "public"."${table}"`);
    } finally {
      await http._disconnect();
      if (originalTimezone === undefined)
        Reflect.deleteProperty(process.env, "TZ");
      else process.env.TZ = originalTimezone;
    }
    console.info(`Retained empty Neon fixture: public.${table}`);
  });

  it("a warm postgres.js connection killed at its own PID settles BEGIN and recovers", async () => {
    // Transaction pooling can reuse the returned backend for the killer.
    // The direct endpoint keeps this isolated session attached to its own PID.
    const directUrl = new URL(databaseUrl ?? "");
    directUrl.hostname = directUrl.hostname.replace(POOLER_PATTERN, "");
    const driver = new PostgresDriver({
      databaseUrl: directUrl.toString(),
      options: { max: 1, connect_timeout: 5 },
    });
    const killer = new Pool({
      connectionString: directUrl.toString(),
      max: 1,
      connectionTimeoutMillis: 5000,
    });
    const killerErrors: string[] = [];
    killer.on("error", (error) => killerErrors.push(error.message));
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const warm = await driver._executeRaw<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid"
      );
      const pid = warm.rows[0]?.pid;
      if (!Number.isSafeInteger(pid) || pid === undefined || pid <= 0)
        throw new Error("The test-owned session did not return a valid PID");
      // The only terminated backend is the PID this isolated driver returned.
      const killed = await killer.query<{ terminated: boolean }>(
        "SELECT pg_terminate_backend($1) AS terminated",
        [pid]
      );
      expect(killed.rows[0]?.terminated).toBe(true);
      const transaction = driver
        ._transaction(async (tx) => {
          await tx.unsafe("SELECT 1");
          return "committed";
        })
        .then(
          () => "committed",
          () => "rejected"
        );
      const outcome = await Promise.race([
        transaction,
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(
            () => reject(new Error("Warm-dead transaction did not settle")),
            5000
          );
        }),
      ]);
      expect(["committed", "rejected"]).toContain(outcome);
      expect(
        (await driver._executeRaw<{ n: number }>("SELECT 1 AS n")).rows
      ).toEqual([{ n: 1 }]);
      expect(killerErrors).toEqual([]);
      console.info(`Warm-dead postgres.js transaction settled: ${outcome}`);
    } finally {
      if (deadline) clearTimeout(deadline);
      await killer.end();
      await driver._disconnect();
    }
  });

  for (const transport of [
    "neon-http",
    "pg-owned",
    "pg-supplied",
    "postgres-owned",
    "postgres-supplied",
  ] as const) {
    it(`${transport} round-trips timestamps, exact decimals, boolean lists and bigint lists`, async () => {
      const pool =
        transport === "pg-supplied"
          ? new Pool({
              connectionString: databaseUrl,
              connectionTimeoutMillis: 5000,
            })
          : undefined;
      const supplied =
        transport === "postgres-supplied"
          ? postgres(databaseUrl ?? "", {
              max: 1,
              connect_timeout: 5,
              types: vibormTypes,
            })
          : undefined;
      const driver =
        transport === "neon-http"
          ? http
          : transport.startsWith("pg-")
            ? new PgDriver({ databaseUrl, pool })
            : new PostgresDriver({
                databaseUrl,
                client: supplied,
                options: { max: 1, connect_timeout: 5 },
              });
      const client = createClient({ schema, driver });
      try {
        const row = await client.evidence.create({
          data: {
            id: transport,
            localAt,
            instant,
            instants,
            flags: [true, false],
            keys,
            amount: new Decimal("9007199254740993.01"),
          },
        });
        expect(row.localAt.toISOString()).toBe(localAt.toISOString());
        expect(row.instant.toISOString()).toBe(instant.toISOString());
        expect(row.instants.map((value) => value.toISOString())).toEqual(
          instants.map((value) => value.toISOString())
        );
        expect(row.flags).toEqual([true, false]);
        expect(row.keys).toEqual(keys);
        expect(row.amount.toString()).toBe("9007199254740993.01");
        const selected = await client.evidence.findUnique({
          where: { id: transport },
        });
        expect(selected?.instant.toISOString()).toBe(instant.toISOString());
        expect(selected?.keys).toEqual(keys);
        await client.evidence.update({
          where: { id: transport },
          data: { flags: { push: true }, keys: { push: 9007199254740995n } },
        });
        const updated = await client.evidence.findUnique({
          where: { id: transport },
        });
        expect(updated?.flags).toEqual([true, false, true]);
        expect(updated?.keys).toEqual([...keys, 9007199254740995n]);
      } finally {
        if (driver !== http) await client.$disconnect();
        await pool?.end();
        await supplied?.end({ timeout: 2 });
      }
    });
  }

  it("HTTP failed batch rolls back its prefix and committed callbacks precede subsequent reads", async () => {
    const insert = `INSERT INTO "public"."${table}" VALUES ($1, '2026-10-08 12:34:56.789', '2026-10-08T12:34:56.789Z', '{}', '{}', '{}', 1.00)`;
    await expect(
      http._executeBatch([
        { sql: insert, params: ["http-duplicate"] },
        { sql: insert, params: ["http-duplicate"] },
      ])
    ).rejects.toThrow();
    expect(
      (
        await http._executeRaw(
          `SELECT id FROM "public"."${table}" WHERE id = $1`,
          ["http-duplicate"]
        )
      ).rows
    ).toEqual([]);
    const order: string[] = [];
    await http._executeBatch(
      [{ sql: insert, params: ["http-commit"] }],
      { isolationLevel: "Serializable" },
      undefined,
      async () => {
        order.push("committed");
        const seen = await http._executeRaw(
          `SELECT id FROM "public"."${table}" WHERE id = $1`,
          ["http-commit"]
        );
        expect(seen.rows).toEqual([{ id: "http-commit" }]);
      }
    );
    order.push("returned");
    expect(order).toEqual(["committed", "returned"]);
    const originalFetch = globalThis.fetch;
    let corruptNextBatch = true;
    globalThis.fetch = Object.assign(
      async (...args: Parameters<typeof fetch>) => {
        const response = await originalFetch(...args);
        if (!(response.ok && corruptNextBatch)) return response;
        const payload: unknown = await response.json();
        if (payload !== null && typeof payload === "object") {
          const results: unknown = Reflect.get(payload, "results");
          if (
            Array.isArray(results) &&
            results[0] !== null &&
            typeof results[0] === "object"
          ) {
            // The real server committed. Corrupt only transport result metadata,
            // after the SDK can decode rows but before the driver validates it.
            Reflect.set(results[0], "rowCount", -1);
            corruptNextBatch = false;
          }
        }
        return new Response(JSON.stringify(payload), {
          status: response.status,
          headers: response.headers,
        });
      },
      { preconnect: () => undefined }
    );
    let acknowledgedPrefix = 0;
    try {
      await expect(
        http._executeBatch(
          [{ sql: insert, params: ["http-decoder-failure"] }],
          undefined,
          undefined,
          async () => {
            acknowledgedPrefix += 1;
          }
        )
      ).rejects.toMatchObject({ name: "QueryError" });
      expect(acknowledgedPrefix).toBe(1);
      expect(corruptNextBatch).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(
      (
        await http._executeRaw(
          `SELECT id FROM "public"."${table}" WHERE id = $1`,
          ["http-decoder-failure"]
        )
      ).rows
    ).toEqual([{ id: "http-decoder-failure" }]);
  });
});
