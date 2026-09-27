/** Native mysql2 proof for the `.updatedAt()` admission contract. */

import { randomUUID } from "node:crypto";
import { createClient } from "@client/client";
import {
  createUpdatedAtSchema,
  updatedAtCells,
} from "@tests/fixtures/updated-at";
import { afterAll, beforeAll, beforeEach, describe } from "vitest";
import { createMySQL2Driver, TEST_CONNECTION_STRING } from "./mysql2-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;
const PREFIX = `issue54_updated_at_${process.pid}_${randomUUID().slice(0, 8)}`;
const TABLES = {
  records: `${PREFIX}_records`,
  children: `${PREFIX}_children`,
  logs: `${PREFIX}_logs`,
};

describeIf("mysql2 `.updatedAt()`", () => {
  const schema = createUpdatedAtSchema(PREFIX);
  const client = createClient({
    schema,
    driver: createMySQL2Driver(),
  });
  const ownedTables: string[] = [];

  const createTable = async (table: string, statement: string) => {
    await client.$executeRawUnsafe(statement);
    ownedTables.push(table);
  };

  const dropOwnedTables = async () => {
    while (ownedTables.length > 0) {
      const table = ownedTables.at(-1);
      if (!table) break;
      await client.$executeRawUnsafe(`DROP TABLE \`${table}\``);
      ownedTables.pop();
    }
  };

  beforeAll(async () => {
    await createTable(
      TABLES.records,
      `CREATE TABLE \`${TABLES.records}\` (
      \`id\` VARCHAR(191) NOT NULL,
      \`label\` TEXT NOT NULL,
      \`touchedAt\` DATETIME(3) NOT NULL,
      \`touchedOn\` DATE NOT NULL,
      \`touchedTime\` TIME(3) NOT NULL,
      \`createdAt\` DATETIME(3) NOT NULL,
      \`ordinaryAt\` DATETIME(3) NOT NULL,
      PRIMARY KEY (\`id\`)
    ) ENGINE=InnoDB`
    );
    await createTable(
      TABLES.children,
      `CREATE TABLE \`${TABLES.children}\` (
      \`id\` VARCHAR(191) NOT NULL,
      \`label\` TEXT NOT NULL,
      \`touchedAt\` DATETIME(3) NOT NULL,
      \`recordId\` VARCHAR(191) NOT NULL,
      PRIMARY KEY (\`id\`)
    ) ENGINE=InnoDB`
    );
    await createTable(
      TABLES.logs,
      `CREATE TABLE \`${TABLES.logs}\` (
      \`id\` VARCHAR(191) NOT NULL,
      \`message\` TEXT NOT NULL,
      \`childId\` VARCHAR(191) NOT NULL,
      PRIMARY KEY (\`id\`)
    ) ENGINE=InnoDB`
    );
  });

  beforeEach(async () => {
    await client.log.deleteMany({});
    await client.child.deleteMany({});
    await client.record.deleteMany({});
  });

  afterAll(async () => {
    try {
      await dropOwnedTables();
    } finally {
      await client.$disconnect();
    }
  });

  updatedAtCells(() => client);
});
