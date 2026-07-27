/**
 * Live-server proof for the two isolationLevel claims no in-process fake can
 * make credibly: that PostgreSQL really runs the transaction at the level we
 * asked for (a Serializable pair must actually conflict), and that MySQL's
 * pre-BEGIN placement really binds to the transaction that follows it (a
 * READ UNCOMMITTED reader must dirty-read another connection's open write).
 *
 * Requires the Docker test databases:
 *   PG_TEST_CONNECTION_STRING=postgres://postgres:password@127.0.0.1:5434/viborm
 *   MYSQL_TEST_CONNECTION_STRING=mysql://root:password@127.0.0.1:3307/viborm
 */

import { createClient } from "@client/client";
import { MySQL2Driver } from "@drivers/mysql2";
import { PgDriver } from "@drivers/pg";
import { push } from "@migrations";
import { s } from "@schema";
import { describe, expect, test } from "vitest";

const PG_CONNECTION_STRING = process.env.PG_TEST_CONNECTION_STRING;
const MYSQL_CONNECTION_STRING = process.env.MYSQL_TEST_CONNECTION_STRING;
const describeIfPg = PG_CONNECTION_STRING ? describe : describe.skip;
const describeIfMySQL = MYSQL_CONNECTION_STRING ? describe : describe.skip;

const counterSchema = (() => {
  const counter = s
    .model({
      id: s.string().id(),
      total: s.int().default(0),
    })
    .map("tx_option_counters");
  return { counter };
})();

describeIfPg("PostgreSQL honors Serializable for real", () => {
  test("two concurrent Serializable transactions produce a mapped V5004", async () => {
    const driver = new PgDriver({ databaseUrl: PG_CONNECTION_STRING });
    const client = createClient({ schema: counterSchema, driver });
    await push(client, { force: true });
    await client.$queryRaw('DELETE FROM "tx_option_counters"');
    await client.counter.create({ data: { id: "a", total: 0 } });
    await client.counter.create({ data: { id: "b", total: 0 } });

    // The classic write-skew pair: each transaction reads what the other is
    // about to write. Under Serializable exactly one must fail with the
    // dialect's serialization error (40001), mapped to V5004.
    const crossUpdate = (readId: string, writeId: string) =>
      client.$transaction(
        async (tx) => {
          const rows = await tx.counter.findMany({ where: { id: readId } });
          const seen = rows[0]?.total ?? 0;
          await new Promise((resolve) => setTimeout(resolve, 50));
          await tx.counter.update({
            where: { id: writeId },
            data: { total: seen + 1 },
          });
        },
        { isolationLevel: "Serializable" }
      );

    const outcomes = await Promise.allSettled([
      crossUpdate("a", "b"),
      crossUpdate("b", "a"),
    ]);
    const rejections = outcomes.filter(
      (outcome) => outcome.status === "rejected"
    );
    expect(rejections.length).toBeGreaterThanOrEqual(1);
    for (const rejection of rejections) {
      // Mapped through the taxonomy, not leaked raw: a serialization failure is
      // the retryable transaction error, not an anonymous driver crash.
      expect(rejection.reason).toMatchObject({
        code: "V5004",
        name: "TransactionError",
      });
    }

    await client.$disconnect();
  });

  test("the same pair commits without a conflict under ReadCommitted", async () => {
    const driver = new PgDriver({ databaseUrl: PG_CONNECTION_STRING });
    const client = createClient({ schema: counterSchema, driver });
    await push(client, { force: true });
    await client.$queryRaw('DELETE FROM "tx_option_counters"');
    await client.counter.create({ data: { id: "a", total: 0 } });
    await client.counter.create({ data: { id: "b", total: 0 } });

    // Falsification of the test above: if the level were being dropped, the
    // Serializable case would look exactly like this one.
    const crossUpdate = (readId: string, writeId: string) =>
      client.$transaction(
        async (tx) => {
          const rows = await tx.counter.findMany({ where: { id: readId } });
          const seen = rows[0]?.total ?? 0;
          await new Promise((resolve) => setTimeout(resolve, 50));
          await tx.counter.update({
            where: { id: writeId },
            data: { total: seen + 1 },
          });
        },
        { isolationLevel: "ReadCommitted" }
      );

    const outcomes = await Promise.allSettled([
      crossUpdate("a", "b"),
      crossUpdate("b", "a"),
    ]);
    expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(
      true
    );

    await client.$disconnect();
  });
});

describeIfMySQL(
  "MySQL applies the level to the transaction that follows",
  () => {
    /**
     * Two observables that look right and are not, both tried and rejected:
     *
     * - `@@transaction_isolation` reports the SESSION default. `SET TRANSACTION
     *   ISOLATION LEVEL x` without SESSION/GLOBAL binds to the next single
     *   transaction and deliberately leaves the session variable alone — which is
     *   exactly the semantics a pooled connection needs, since the alternative
     *   leaks one caller's level onto whoever gets that connection next. Reading
     *   it reports REPEATABLE-READ for every level and would fail correct code.
     * - `information_schema.innodb_trx` is served from a snapshot this server
     *   keeps handing back stale (it reports a long-finished thread as RUNNING),
     *   so it cannot tell one transaction from the next.
     *
     * What is left is the observable that cannot be faked: the isolation behavior
     * itself. READ UNCOMMITTED dirty-reads and READ COMMITTED does not, so a
     * second connection holding an uncommitted INSERT reveals exactly which level
     * the reader is running at.
     */
    const raw = async (
      driver: MySQL2Driver,
      tx: unknown,
      sql: string
    ): Promise<Record<string, unknown>[]> => {
      const result = await Reflect.apply(
        Reflect.get(driver, "executeRaw"),
        driver,
        [tx, sql, undefined, {}]
      );
      return (result as { rows: Record<string, unknown>[] }).rows;
    };

    const countProbeRows = async (driver: MySQL2Driver, tx: unknown) => {
      const rows = await raw(
        driver,
        tx,
        "SELECT COUNT(*) AS n FROM tx_option_probe"
      );
      return Number(rows[0]?.n);
    };

    /**
     * Run `body` while a second connection holds an uncommitted INSERT open. The
     * holder always rolls back, so the probe table is left as it was found.
     */
    const withUncommittedRow = async (
      body: (reader: MySQL2Driver) => Promise<void>
    ) => {
      const writer = new MySQL2Driver({ databaseUrl: MYSQL_CONNECTION_STRING });
      const reader = new MySQL2Driver({ databaseUrl: MYSQL_CONNECTION_STRING });
      await writer._executeRaw("DROP TABLE IF EXISTS tx_option_probe");
      await writer._executeRaw(
        "CREATE TABLE tx_option_probe (id INT PRIMARY KEY) ENGINE=InnoDB"
      );

      let markInserted: (() => void) | undefined;
      const inserted = new Promise<void>((resolve) => {
        markInserted = resolve;
      });
      let releaseWriter: (() => void) | undefined;
      const held = new Promise<void>((resolve) => {
        releaseWriter = resolve;
      });

      const writerRun = writer
        ._transaction(async (tx) => {
          await raw(writer, tx, "INSERT INTO tx_option_probe (id) VALUES (42)");
          markInserted?.();
          await held;
          // Rolling back keeps the row uncommitted for the whole probe and
          // leaves nothing behind afterwards.
          throw new Error("probe rollback");
        })
        .catch(() => undefined);
      await inserted;

      try {
        await body(reader);
      } finally {
        releaseWriter?.();
        await writerRun;
        await reader.disconnect();
        await writer._executeRaw("DROP TABLE IF EXISTS tx_option_probe");
        await writer.disconnect();
      }
    };

    test("ReadUncommitted really dirty-reads another connection's open write", async () => {
      await withUncommittedRow(async (reader) => {
        const seen = await reader._transaction(
          (tx) => countProbeRows(reader, tx),
          { isolationLevel: "ReadUncommitted" }
        );
        expect(seen).toBe(1);
      });
    });

    test("ReadCommitted on the same driver does not see it", async () => {
      await withUncommittedRow(async (reader) => {
        // The falsification of the test above: if the level were being dropped,
        // both transactions would read the same thing.
        const seen = await reader._transaction(
          (tx) => countProbeRows(reader, tx),
          { isolationLevel: "ReadCommitted" }
        );
        expect(seen).toBe(0);
      });
    });

    test("both levels on one driver, back to back, each in force", async () => {
      await withUncommittedRow(async (reader) => {
        const dirty = await reader._transaction(
          (tx) => countProbeRows(reader, tx),
          { isolationLevel: "ReadUncommitted" }
        );
        const clean = await reader._transaction(
          (tx) => countProbeRows(reader, tx),
          { isolationLevel: "ReadCommitted" }
        );
        expect([dirty, clean]).toEqual([1, 0]);
      });
    });

    test("the level does not leak onto the next transaction on that connection", async () => {
      await withUncommittedRow(async (reader) => {
        await reader._transaction((tx) => countProbeRows(reader, tx), {
          isolationLevel: "ReadUncommitted",
        });
        // Next-transaction-only semantics: a pooled connection must fall back to
        // the server default, or one caller's isolationLevel silently becomes
        // everyone else's. The default here is REPEATABLE READ, which does not
        // dirty-read.
        const next = await reader._transaction((tx) =>
          countProbeRows(reader, tx)
        );
        expect(next).toBe(0);
      });
    });

    test("RepeatableRead and Serializable are accepted and commit normally", async () => {
      // The two strong levels have no dirty-read signal to check; what matters is
      // that asking for them opens and commits a real transaction rather than
      // erroring on the SET statement.
      for (const level of ["RepeatableRead", "Serializable"] as const) {
        const driver = new MySQL2Driver({
          databaseUrl: MYSQL_CONNECTION_STRING,
        });
        await driver._executeRaw("DROP TABLE IF EXISTS tx_option_probe");
        await driver._executeRaw(
          "CREATE TABLE tx_option_probe (id INT PRIMARY KEY) ENGINE=InnoDB"
        );
        const seen = await driver._transaction(
          async (tx) => {
            await raw(
              driver,
              tx,
              "INSERT INTO tx_option_probe (id) VALUES (7)"
            );
            return countProbeRows(driver, tx);
          },
          { isolationLevel: level }
        );
        expect(seen).toBe(1);
        await driver._executeRaw("DROP TABLE IF EXISTS tx_option_probe");
        await driver.disconnect();
      }
    });
  }
);
