import { randomUUID } from "node:crypto";
import { createClient } from "@client/client";
import type { QueryExecutionContext } from "@drivers";
import { PgDriver } from "@drivers/pg";
import { UniqueConstraintError } from "@errors";
import { s } from "@schema";
import { sql } from "@sql";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl =
  process.env.NEON_DATABASE_URL ?? process.env.NEON_TEST_DATABASE_URL;
const prefix = `viborm_race_${randomUUID().replace(/-/g, "")}`;
const ownerTable = `${prefix}_owner`;
const itemTable = `${prefix}_item`;
const owner = s
  .model({ id: s.int().id(), items: s.toMany(() => item) })
  .map(ownerTable);
const item = s
  .model({
    id: s.int().id(),
    name: s.string().unique(),
    n: s.int(),
    ownerId: s.int().nullable(),
    owner: s
      .toOne(() => owner)
      .fields("ownerId")
      .references("id"),
  })
  .map(itemTable);

// This schedules a real independently committed winner after the loser's
// absent SELECT and before its INSERT; it does not fake a provider rejection.
class ScheduledPgDriver extends PgDriver {
  winner: (() => Promise<void>) | undefined;
  protected override async execute<T>(
    client: Pool | PoolClient,
    statement: string,
    values: unknown[],
    context?: QueryExecutionContext
  ) {
    if (
      statement.startsWith("INSERT") &&
      statement.includes(`"${itemTable}"`) &&
      this.winner
    ) {
      const winner = this.winner;
      this.winner = undefined;
      await winner();
    }
    return super.execute<T>(client, statement, values, context);
  }
}

describe.skipIf(!databaseUrl)(
  "V1 PostgreSQL interactive lost-race recovery",
  () => {
    const pool = new Pool({
      connectionString: databaseUrl,
      max: 2,
      connectionTimeoutMillis: 5000,
    });
    const competitor = new Pool({
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: 5000,
    });
    const driver = new ScheduledPgDriver({ pool });
    const db = createClient({ schema: { owner, item }, driver });
    beforeAll(async () => {
      await pool.query(
        `CREATE TABLE "public"."${ownerTable}"(id INTEGER PRIMARY KEY)`
      );
      await pool.query(
        `CREATE TABLE "public"."${itemTable}"(id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE,n INTEGER NOT NULL,"ownerId" INTEGER REFERENCES "public"."${ownerTable}"(id))`
      );
    });
    afterAll(async () => {
      try {
        await pool.query(`DELETE FROM "public"."${itemTable}"`);
        await pool.query(`DELETE FROM "public"."${ownerTable}"`);
      } finally {
        await db.$disconnect();
        await pool.end();
        await competitor.end();
      }
      console.info(
        `Retained empty Neon fixtures: public.${ownerTable}, public.${itemTable}`
      );
    });
    it("adopts a winner and preserves earlier/later callback writes for fallback upsert", async () => {
      driver.winner = async () => {
        await competitor.query(
          `INSERT INTO "public"."${itemTable}" VALUES(2,'upsert',5,NULL)`
        );
      };
      await db.$transaction(async (tx) => {
        await tx.owner.create({ data: { id: 10 } });
        const row = await tx.item.upsert({
          where: { name: "upsert" },
          create: { id: 1, name: "upsert", n: 0 },
          update: { n: { increment: 1 } },
        });
        expect(row.id).toBe(2);
        expect(row.n).toBe(6);
        await tx.owner.create({ data: { id: 11 } });
      });
      expect(await db.owner.count({ where: { id: { in: [10, 11] } } })).toBe(2);
    });
    it("rolls back only the lost operation's savepoint and adopts connectOrCreate", async () => {
      driver.winner = async () => {
        await competitor.query(
          `INSERT INTO "public"."${itemTable}" VALUES(4,'connect',0,NULL)`
        );
      };
      await db.$transaction(async (tx) => {
        await tx.owner.create({ data: { id: 20 } });
        const row = await tx.owner.create({
          data: {
            id: 21,
            items: {
              connectOrCreate: {
                where: { name: "connect" },
                create: { id: 3, name: "connect", n: 0 },
              },
            },
          },
          include: { items: true },
        });
        expect(row.items.map(({ id }) => id)).toEqual([4]);
        await tx.owner.create({ data: { id: 22 } });
      });
      expect(
        await db.owner.count({ where: { id: { in: [20, 21, 22] } } })
      ).toBe(3);
    });
    it("does not retry a collision on a different unique constraint", async () => {
      driver.winner = async () => {
        await competitor.query(
          `INSERT INTO "public"."${itemTable}" VALUES(5,'other',0,NULL)`
        );
      };
      await db.$transaction(async (tx) => {
        await expect(
          tx.item.upsert({
            where: { name: "missing" },
            create: { id: 5, name: "missing", n: 0 },
            update: { n: { increment: 1 } },
          })
        ).rejects.toBeInstanceOf(UniqueConstraintError);
        await tx.owner.create({ data: { id: 30 } });
      });
      expect(
        await db.item.findUnique({ where: { name: "missing" } })
      ).toBeNull();
      expect(await db.owner.count({ where: { id: 30 } })).toBe(1);
    });
    for (const operation of ["updateMany", "deleteMany"] as const) {
      it(`rechecks a limited ${operation} after the locked row leaves its filter`, async () => {
        const id = operation === "updateMany" ? 40 : 41;
        await pool.query(
          `INSERT INTO "public"."${itemTable}" VALUES($1,$2,1,NULL)`,
          [id, operation]
        );
        const holder = await competitor.connect();
        let committed = false;
        let resolvePid: (pid: number) => void = () => {
          throw new Error("PID latch was not initialized");
        };
        const pidReady = new Promise<number>((resolve) => {
          resolvePid = resolve;
        });
        let claimant: Promise<{ count: number }> | undefined;
        try {
          await holder.query("BEGIN");
          await holder.query(
            `UPDATE "public"."${itemTable}" SET n=0 WHERE id=$1`,
            [id]
          );
          claimant = db.$transaction(async (tx) => {
            const rows = await tx.$queryRaw<{ pid: number }>(
              sql`SELECT pg_backend_pid() AS pid`
            );
            const pid = rows[0]?.pid;
            if (!pid) throw new Error("Claimant transaction omitted its PID");
            resolvePid(pid);
            const where = { id, n: { gt: 0 } };
            return operation === "updateMany"
              ? tx.item.updateMany({
                  where,
                  limit: 1,
                  data: { n: { decrement: 1 } },
                })
              : tx.item.deleteMany({ where, limit: 1 });
          });
          // Observe the exact pinned claimant session blocked at the real row
          // lock. Commit timing is conditional on that server fact, never a sleep.
          const pid = await Promise.race([
            pidReady,
            claimant.then(() => {
              throw new Error(
                "Claimant completed before reaching the controlled lock"
              );
            }),
          ]);
          const deadline = Date.now() + 5000;
          let blocked = false;
          while (Date.now() < deadline) {
            const { rows } = await pool.query<{
              wait_event_type: string | null;
            }>("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [
              pid,
            ]);
            if (rows[0]?.wait_event_type === "Lock") {
              blocked = true;
              break;
            }
          }
          expect(blocked).toBe(true);
          await holder.query("COMMIT");
          committed = true;
          expect(await claimant).toEqual({ count: 0 });
          expect(await db.item.findUnique({ where: { id } })).toMatchObject({
            id,
            n: 0,
          });
        } finally {
          try {
            if (!committed) await holder.query("ROLLBACK");
          } finally {
            holder.release();
          }
          // A failed witness still releases the blocked query before fixture teardown.
          if (!committed) await claimant?.catch(() => undefined);
        }
      });
    }
  }
);
