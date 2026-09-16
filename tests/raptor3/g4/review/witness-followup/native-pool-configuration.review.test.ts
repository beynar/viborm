/**
 * Independent review probes — is the native fixture repair real?
 *
 * Claim under test (note.md §14.1 A): `runLiveWorld` used to hand the driver a
 * SUPPLIED pool, discarding the driver's own transport configuration
 * (PostgreSQL `utcSafeTypes`, MySQL `timezone:"Z"` / `supportBigNumbers` /
 * `dateStrings:["DATE"]`), and the repair makes the fixture borrow the pool the
 * driver builds.
 *
 * These cells go to the recorded containers directly, without the ORM, so the
 * claim is checked against the transport rather than against either engine:
 * a pool built the repaired way must decode differently from a pool built the
 * old way, or the repair changed nothing. Run with
 * `VIBORM_RAPTOR3_PROVIDER=pg|mysql` and `VIBORM_RAPTOR3_PROVIDER_PORT=<port>`.
 */
import assert from "node:assert/strict";
import { MySQL2Driver } from "@drivers/mysql2";
import { PgDriver } from "@drivers/pg";
import { createPool, type Pool as MySQLPool } from "mysql2/promise";
import { Pool as PgPool } from "pg";
import { describe, it } from "vitest";

const provider = process.env.VIBORM_RAPTOR3_PROVIDER;
const portText = process.env.VIBORM_RAPTOR3_PROVIDER_PORT;
const port = Number(portText);

const connection = { host: "127.0.0.1", port, database: "raptor3_g2", password: "" };
const pgOptions = {
  ...connection,
  user: "postgres",
  ssl: false as const,
  max: 1,
  connectionTimeoutMillis: 10_000,
};
const mysqlOptions = {
  ...connection,
  user: "root",
  connectionLimit: 1,
  connectTimeout: 10_000,
};

class PgFactory extends PgDriver {
  own(): Promise<PgPool> {
    return this.getClient() as Promise<PgPool>;
  }
}
class MySQLFactory extends MySQL2Driver {
  own(): Promise<MySQLPool> {
    return this.getClient() as Promise<MySQLPool>;
  }
}

describe.skipIf(provider !== "pg")(
  "review probe: the repaired PostgreSQL fixture pool",
  () => {
    it("decodes DATE and TIMESTAMP as the driver does, and a bare pool does not", async () => {
      const driverPool = await new PgFactory({ options: pgOptions }).own();
      const barePool = new PgPool(pgOptions);
      try {
        const statement =
          "SELECT '2024-01-15'::date AS day, '2024-01-15 10:30:00.123'::timestamp AS moment";
        const viaDriver = (await driverPool.query(statement)).rows[0];
        const viaBare = (await barePool.query(statement)).rows[0];
        assert.equal(
          typeof viaDriver.day,
          "string",
          "the driver-built pool no longer returns DATE as text"
        );
        assert.equal(
          typeof viaDriver.moment,
          "string",
          "the driver-built pool no longer returns TIMESTAMP as text"
        );
        // The falsifier: the pool the fixture used to build decodes the same
        // columns differently, which is the defect the repair removed.
        assert.ok(
          viaBare.day instanceof Date,
          "a bare pg.Pool no longer differs from the driver's pool"
        );
        assert.ok(viaBare.moment instanceof Date);
      } finally {
        await driverPool.end();
        await barePool.end();
      }
    });
  }
);

describe.skipIf(provider !== "mysql")(
  "review probe: the repaired MySQL fixture pool",
  () => {
    it("carries the driver's DATE and big-number configuration, and a bare pool does not", async () => {
      const driverPool = await new MySQLFactory({ options: mysqlOptions }).own();
      const barePool = createPool(mysqlOptions);
      try {
        const statement =
          "SELECT CAST('2024-01-15' AS DATE) AS day, 9007199254740993 AS big";
        const [viaDriver] = (await driverPool.query(statement)) as [
          Record<string, unknown>[],
          unknown,
        ];
        const [viaBare] = (await barePool.query(statement)) as [
          Record<string, unknown>[],
          unknown,
        ];
        assert.equal(
          typeof viaDriver[0]!.day,
          "string",
          "the driver-built pool no longer returns DATE as text"
        );
        assert.equal(
          typeof viaDriver[0]!.big,
          "string",
          "the driver-built pool no longer keeps wide integers exact"
        );
        assert.ok(
          viaBare[0]!.day instanceof Date,
          "a bare mysql2 pool no longer differs from the driver's pool"
        );
        assert.equal(typeof viaBare[0]!.big, "number");
      } finally {
        await driverPool.end();
        await barePool.end();
      }
    });

    it("refuses the ISO-Z literal the old seed wrote and accepts the adapter's spelling", async () => {
      const driverPool = await new MySQLFactory({ options: mysqlOptions }).own();
      try {
        const connectionHandle = await driverPool.getConnection();
        try {
          await connectionHandle.query(
            "CREATE TEMPORARY TABLE g4_review_moment (id INT PRIMARY KEY, moment_value DATETIME(3))"
          );
          await assert.rejects(
            connectionHandle.query(
              "INSERT INTO g4_review_moment (id, moment_value) VALUES (1, ?)",
              ["2024-01-15T10:30:00.123Z"]
            ),
            /Incorrect datetime value/,
            "MySQL no longer refuses the ISO-Z literal the old seed wrote"
          );
          // The adapter's own spelling (`toMySqlDateTime`): naive UTC wall clock.
          await connectionHandle.query(
            "INSERT INTO g4_review_moment (id, moment_value) VALUES (2, ?)",
            ["2024-01-15 10:30:00.123"]
          );
          const [stored] = (await connectionHandle.query(
            "SELECT moment_value FROM g4_review_moment WHERE id = 2"
          )) as [Record<string, unknown>[], unknown];
          const moment = stored[0]!.moment_value;
          assert.ok(moment instanceof Date, "DATETIME did not decode to a Date");
          assert.equal(
            moment.toISOString(),
            "2024-01-15T10:30:00.123Z",
            "the driver-built pool did not read the stored instant back as UTC"
          );
        } finally {
          connectionHandle.release();
        }
      } finally {
        await driverPool.end();
      }
    });
  }
);
