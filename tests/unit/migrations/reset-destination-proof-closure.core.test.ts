import { sql } from "@sql";
import { VibORMErrorCode } from "@src/errors";
import { generateV1 } from "@src/migrations/generate-v1";
import { resetV1 } from "@src/migrations/reset-v1";
import { MemoryEstateStorage } from "@src/migrations/storage/memory";
import { describe, expect, test } from "vitest";
import {
  controlCatalogAnswer,
  sqliteControlDefinitionAnswer,
  sqliteEstateDriver,
} from "./_estate";

describe("reset destination proof", () => {
  test("does not publish a marker when authenticated destination checks fail", async () => {
    const storage = new MemoryEstateStorage();
    const driver = sqliteEstateDriver();
    const client = { $driver: driver, $schema: {} };
    const generated = await generateV1(client, storage, {
      name: "checked-root",
      manualMigration: {
        transitions: [
          {
            from: null,
            execution: "transactional",
            up: [sql`SELECT 1`],
            originChecks: [],
            rollback: { kind: "irreversible", reason: "manual root" },
          },
        ],
        destinationChecks: [
          { kind: "trusted-read", query: sql`SELECT 1`, equals: true },
        ],
      },
    });
    if (!generated.stateId) throw new Error("expected a published root");

    let stateExists = false;
    let logExists = false;
    driver.respond = (statement, parameters) => {
      if (
        statement.startsWith("CREATE TABLE") &&
        statement.includes("_viborm_migration_state")
      ) {
        stateExists = true;
        return [{ changed: 1 }];
      }
      if (
        statement.startsWith("CREATE TABLE") &&
        statement.includes("_viborm_migration_log")
      ) {
        logExists = true;
        return [{ changed: 1 }];
      }
      const catalog = controlCatalogAnswer(statement, parameters, {
        state: stateExists,
        log: logExists,
      });
      if (catalog) return catalog;
      const definition = sqliteControlDefinitionAnswer(statement, {
        state: stateExists,
        log: logExists,
      });
      if (definition) return definition;
      if (statement.startsWith("INSERT")) return [{ changed: 1 }];
      if (statement === "SELECT 1") return [{ matches: 0 }];
      return [];
    };

    await expect(
      resetV1(client, storage, { to: { id: generated.stateId } })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_DRIFT,
      message: expect.stringContaining("destination checks"),
    });
    expect(
      driver.statements.some((statement) => statement.startsWith("UPDATE"))
    ).toBe(false);
  });
});
