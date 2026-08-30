/**
 * Composite foreign-key COLUMN ORDER, at the DDL.
 *
 * A composite `.references(...)` names its target key by MEMBERSHIP, so any
 * spelling of the tuple addresses the same rows. MySQL does not agree: it
 * matches a foreign key's referenced columns against an index left-prefix
 * POSITIONALLY, so `REFERENCES account(id, tenantId)` against a key declared
 * `(tenantId, id)` is errno 6125 — and MySQL commits DDL as each statement
 * runs, so that refusal lands mid-push with the parent table already created.
 *
 * `schema/validation/rules/fk.ts` publishes ONE ordered pairing for the whole
 * schema, which is what makes the emitted constraint name the target key in the
 * key's own order. The snapshot SHAPE belongs to `serializer.core.test.ts`;
 * what this file witnesses is the ORDER both sides of the constraint carry.
 */

import type { MigrationDriver } from "@src/migrations/drivers";
import { mysqlMigrationDriver } from "@src/migrations/drivers/mysql";
import { postgresMigrationDriver } from "@src/migrations/drivers/postgres";
import { sqlite3MigrationDriver } from "@src/migrations/drivers/sqlite";
import { serializeModels } from "@src/migrations/serializer";
import { s } from "@src/schema";
import { hydrateSchemaNames } from "@src/schema/hydration";
import { validateSchemaOrThrow } from "@src/schema/validation";
import { ddlContext } from "@tests/unit/migrations/_estate";
import { describe, expect, it } from "vitest";

const migrationDrivers = {
  postgres: postgresMigrationDriver,
  mysql: mysqlMigrationDriver,
  sqlite: sqlite3MigrationDriver,
};

/**
 * The same edge twice: once with the referenced tuple permuted against the
 * account key, once spelled the way that key is declared. FRESH models per
 * call, so no model object is ever hydrated under two schema keys.
 */
function buildSchema(order: "permuted" | "declared") {
  const account = s
    .model({
      id: s.string(),
      tenantId: s.string(),
      members: s.toMany(() => member),
    })
    .id(["tenantId", "id"]);
  const member = s.model({
    id: s.string().id(),
    aTenantId: s.string(),
    aId: s.string(),
    account:
      order === "permuted"
        ? s
            .toOne(() => account)
            .fields("aId", "aTenantId")
            .references("id", "tenantId")
        : s
            .toOne(() => account)
            .fields("aTenantId", "aId")
            .references("tenantId", "id"),
  });
  const schema = { account, member };
  hydrateSchemaNames(schema);
  validateSchemaOrThrow(schema);
  return schema;
}

function memberTable(order: "permuted" | "declared", driver: MigrationDriver) {
  const snapshot = serializeModels(buildSchema(order), {
    migrationDriver: driver,
  });
  const table = snapshot.tables.find(
    (candidate) => candidate.name === "member"
  );
  if (table === undefined) throw new Error("the member table was serialized");
  return table;
}

describe("composite foreign-key column order", () => {
  it("names the referenced key in the key's own order in MySQL DDL", () => {
    const ddl = mysqlMigrationDriver.generateDDL(
      {
        type: "createTable",
        table: memberTable("permuted", mysqlMigrationDriver),
      },
      ddlContext("artifact")
    );

    expect(ddl).toContain(
      "CONSTRAINT `member_aTenantId_aId_fkey` FOREIGN KEY (`aTenantId`, `aId`) REFERENCES `account` (`tenantId`, `id`)"
    );
  });

  it.each<keyof typeof migrationDrivers>([
    "postgres",
    "mysql",
    "sqlite",
  ])("converges a permuted and a declared-order reference on one %s table", (dialect) => {
    const driver = migrationDrivers[dialect];

    // Both sides of the constraint permute together, and the automatic
    // foreign-key index rides the same tuple — so the two declarations are
    // one physical artifact, not two that happen to point at the same rows.
    expect(memberTable("permuted", driver)).toEqual(
      memberTable("declared", driver)
    );
  });
});
