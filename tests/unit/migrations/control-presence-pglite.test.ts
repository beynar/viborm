/**
 * Control-table presence on live PostgreSQL (PGlite). One catalog statement
 * answers presence, shape and attachments of both tables (plan D5), so a
 * command reads the control plane in three statements: that catalog read,
 * the marker and the ledger. A relation that is not an ordinary table — a
 * view named like a control table — is no control table: bootstrap refuses
 * the pair rather than adopt it. Bootstrap runs under the migration lock, so
 * it reads presence once.
 */

import type { AnyDriver } from "@drivers/driver";
import { VibORMErrorCode } from "@src/errors";
import {
  ensureControlTables,
  inspectControlPresence,
  readControlState,
} from "@src/migrations/control";
import { getMigrationDriver } from "@src/migrations/drivers";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { describe, expect, test } from "vitest";

/** The statements `producer` sends while `run` runs. */
async function statementsOf(
  driver: AnyDriver,
  run: (producer: AnyDriver) => Promise<unknown>
): Promise<string[]> {
  const sent: string[] = [];
  const producer: AnyDriver = Object.create(driver);
  Object.defineProperty(producer, "_executeRaw", {
    value: (sql: string, params?: unknown[]) => {
      sent.push(sql);
      return driver._executeRaw(sql, params);
    },
  });
  await run(producer);
  return sent;
}

describe("PostgreSQL control presence", () => {
  test("a present pair is read in three statements", async () => {
    const driver = createInMemoryPGliteDriver();
    const command = getMigrationDriver(driver);
    try {
      await ensureControlTables(driver, command);
      const sent = await statementsOf(driver, (producer) =>
        readControlState(producer, command, {
          ledger: "open",
        })
      );
      expect(sent).toHaveLength(3);
      expect(
        await statementsOf(driver, (producer) =>
          ensureControlTables(producer, command)
        )
      ).toHaveLength(1);
    } finally {
      await driver._disconnect();
    }
  });

  test("a view named like a control table is refused, never adopted", async () => {
    const driver = createInMemoryPGliteDriver();
    const command = getMigrationDriver(driver);
    try {
      await driver._executeRaw(
        `CREATE VIEW "public"."_viborm_migration_state" AS SELECT 1 AS singleton, '{}'::text AS payload`
      );
      expect(await inspectControlPresence(driver, command)).toEqual({
        kind: "missing-table",
        table: "both",
      });
      await expect(ensureControlTables(driver, command)).rejects.toMatchObject({
        code: VibORMErrorCode.MIGRATION_INVALID_STATE,
        message: "Migration control tables have an unexpected definition",
      });
    } finally {
      await driver._disconnect();
    }
  });

  test("an empty state table left by an interrupted bootstrap is completed", async () => {
    const driver = createInMemoryPGliteDriver();
    const command = getMigrationDriver(driver);
    try {
      await ensureControlTables(driver, command);
      await driver._executeRaw(`DROP TABLE "public"."_viborm_migration_log"`);
      expect(await inspectControlPresence(driver, command)).toEqual({
        kind: "recoverable-state-only",
      });
      // Presence and its proofs once, then DROP, CREATE ×2 and the catalog.
      expect(
        await statementsOf(driver, (producer) =>
          ensureControlTables(producer, command)
        )
      ).toHaveLength(6);
      expect((await readControlState(driver, command)).presence).toEqual({
        kind: "present",
      });
    } finally {
      await driver._disconnect();
    }
  });
});
