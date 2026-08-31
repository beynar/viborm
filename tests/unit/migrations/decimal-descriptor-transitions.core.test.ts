/**
 * Deterministic fixed-decimal transition contracts.
 *
 * These tests render MySQL transitions and inspect authenticated migration
 * artifacts without opening a provider. Live SQLite and PGlite transitions
 * live in decimal-descriptor-transitions.test.ts.
 */

import type { AlterColumnOperation } from "@migrations/drivers/base";
import { mysqlMigrationDriver } from "@migrations/drivers/mysql";
import { generateV1 as generate } from "@migrations/generate-v1";
import { loadMigrationGraph } from "@migrations/graph";
import { invertOperations } from "@migrations/invert";
import { sliceDispatch } from "@migrations/sql-blob";
import type { MigrationOperationV1 } from "@migrations/v1-types";
import { describe, expect, it } from "vitest";
import {
  decimalLedger as ledger,
  decimalListLedger as listLedger,
} from "./_decimal-descriptor-models";
import { ddlContext, MemoryStorage, mysqlEstateDriver } from "./_estate";

async function readPublishedTransition(
  storage: MemoryStorage,
  stateId: string | null
) {
  if (stateId === null) throw new Error("missing generated state");
  const graph = await loadMigrationGraph(storage);
  const state = graph.states.get(stateId);
  if (!state) throw new Error("generated state was not published");
  const transition = state.parents[0];
  const blob = graph.sql.get(state.sqlHash);
  if (!(transition && blob))
    throw new Error("generated transition is incomplete");
  return { blob, transition };
}

function operationSql(
  blob: Uint8Array,
  operations: readonly MigrationOperationV1[]
): string[] {
  return operations.flatMap((operation) =>
    operation.steps.map((step) => sliceDispatch(blob, step.execute))
  );
}

const MYSQL_LIST_NARROWING_REFUSAL =
  /narrows its JSON list.*refused before any statement runs/s;

describe("MySQL: same-scale decimal-list transitions", () => {
  const transition = (
    fromPrecision: number,
    toPrecision: number
  ): AlterColumnOperation => ({
    type: "alterColumn",
    tableName: "ledger",
    columnName: "samples",
    from: {
      name: "samples",
      type: "JSON",
      nullable: false,
      decimal: { precision: fromPrecision, scale: 2 },
    },
    to: {
      name: "samples",
      type: "JSON",
      nullable: false,
      decimal: { precision: toPrecision, scale: 2 },
    },
  });

  it("admits widening but refuses the automatic narrowing down before DDL", () => {
    const up = transition(10, 12);
    const down = invertOperations([up], { tables: [] }).operations[0];
    expect(down).toEqual({ ...up, from: up.to, to: up.from });

    const statements = mysqlMigrationDriver
      .generateDDL(up, ddlContext("live"))
      .split(";\n");

    expect(statements).toHaveLength(3);
    expect(statements[0]).toBe(
      "ALTER TABLE `ledger` ADD CONSTRAINT `viborm_decimal_l_10_2` CHECK (`samples` IS NULL OR (LEFT(CAST(`samples` AS CHAR CHARACTER SET utf8mb4), 1) = '[' AND RIGHT(CAST(`samples` AS CHAR CHARACTER SET utf8mb4), 1) = ']' AND REGEXP_LIKE(CAST(`samples` AS CHAR CHARACTER SET utf8mb4), '^.((\"0\"|\"-?[1-9][0-9]{0,9}\")(, (\"0\"|\"-?[1-9][0-9]{0,9}\"))*)?.$', 'c')))"
    );
    expect(statements[1]).toBe(
      "ALTER TABLE `ledger` MODIFY COLUMN `samples` JSON NOT NULL COMMENT 'viborm:decimal(12,2)'"
    );
    expect(statements[2]).toBe(
      "ALTER TABLE `ledger` DROP CHECK `viborm_decimal_l_10_2`"
    );

    if (down === undefined) throw new Error("missing automatic down");
    expect(() =>
      mysqlMigrationDriver.generateDDL(down, ddlContext("live"))
    ).toThrow(MYSQL_LIST_NARROWING_REFUSAL);
  });

  it.each([
    false,
    true,
  ])("generates widening with an irreversible down (dryRun=%s)", async (dryRun) => {
    const storage = new MemoryStorage();
    const driver = mysqlEstateDriver({ namespace: "ledger_test" });
    await generate({ $schema: listLedger(10, 2), $driver: driver }, storage, {
      name: "init",
    });
    storage.writes.length = 0;

    const widened = await generate(
      { $schema: listLedger(12, 2), $driver: driver },
      storage,
      { name: "widen", dryRun }
    );

    expect(widened.outcome).toBe(dryRun ? "preview" : "published");
    expect(widened.sql.match(/ALTER TABLE/g)).toHaveLength(3);
    expect(storage.writes.length === 0).toBe(dryRun);
    if (!dryRun) {
      const { transition } = await readPublishedTransition(
        storage,
        widened.stateId
      );
      expect(transition.rollback).toEqual({
        kind: "irreversible",
        reason: expect.stringContaining(
          "MySQL cannot automatically roll back the decimal-list widening"
        ),
      });
    }
  });

  it("keeps an ordinary scalar widening rollback automatic", async () => {
    const storage = new MemoryStorage();
    const driver = mysqlEstateDriver({ namespace: "ledger_test" });
    await generate({ $schema: ledger(10, 2), $driver: driver }, storage, {
      name: "init",
    });

    const widened = await generate(
      { $schema: ledger(12, 2), $driver: driver },
      storage,
      { name: "widen" }
    );

    const { blob, transition } = await readPublishedTransition(
      storage,
      widened.stateId
    );
    expect(transition.rollback.kind).toBe("schema");
    if (transition.rollback.kind !== "schema") {
      throw new Error("expected an automatic schema rollback");
    }
    expect(operationSql(blob, transition.rollback.operations)).toEqual([
      "ALTER TABLE `dec_tx` ADD CONSTRAINT `viborm_decimal_s_10_2` CHECK (`amount` IS NULL OR `amount` = CAST(`amount` AS DECIMAL(10,2)))",
      "ALTER TABLE `dec_tx` MODIFY COLUMN `amount` DECIMAL(10,2)",
      "ALTER TABLE `dec_tx` DROP CHECK `viborm_decimal_s_10_2`",
    ]);
  });
});
