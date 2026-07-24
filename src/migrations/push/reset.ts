import type { AnyDriver } from "../../drivers/driver";
import type { MigrationDriver } from "../drivers";
import type { MigrationStorageDriver } from "../storage/driver";
import { introspectSchema } from "./planner";

/**
 * Resets the database by dropping all tables and enums.
 * If storage driver is provided, also clears migration tracking.
 */
export async function resetDatabase(
  driver: AnyDriver,
  migrationDriver: MigrationDriver,
  storageDriver?: MigrationStorageDriver
): Promise<void> {
  const current = await introspectSchema(driver, migrationDriver);

  for (const statement of migrationDriver.getPreResetStatements(current)) {
    await driver._executeRaw(`${statement};`);
  }

  const tablesToDrop = [...current.tables].reverse();
  for (const table of tablesToDrop) {
    const dropSql = migrationDriver.generateDropTableSQL(table.name, true);
    await driver._executeRaw(`${dropSql};`);
  }

  if (current.enums) {
    for (const enumDef of current.enums) {
      const dropSql = migrationDriver.generateDropEnumSQL(enumDef.name);
      if (dropSql) {
        await driver._executeRaw(`${dropSql};`);
      }
    }
  }

  if (storageDriver) {
    await storageDriver.writeJournal({
      version: "1",
      dialect: driver.dialect,
      entries: [],
    });
    await storageDriver.writeSnapshot({ tables: [], enums: [] });
  }
}
