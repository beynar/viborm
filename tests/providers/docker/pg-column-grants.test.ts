/**
 * pg Driver Tests - a role granted SELECT on some columns only, on a real
 * PostgreSQL server.
 *
 * A bounded read with a to-one relation is paged first and joined after; its
 * page reads the columns the statement uses and no other, so a role without
 * the privilege on a column the read never names reads as it did when every
 * relation was a subquery.
 *
 * NOTE: These tests require a running PostgreSQL database.
 */

import { createClient } from "@drivers/pg";
import { s } from "@schema";
import pg from "pg";
import { TEST_CONNECTION_STRING } from "./pg-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

const OWNER = "column_grants_owner";
const ITEM = "column_grants_item";
const ROLE = "viborm_column_grants_reader";

const owner = s
  .model({
    id: s.string().id(),
    name: s.string(),
    items: s.toMany(() => item),
  })
  .map(OWNER);
const item = s
  .model({
    id: s.string().id(),
    title: s.string(),
    secret: s.string(),
    ownerId: s.string(),
    owner: s
      .toOne(() => owner)
      .fields("ownerId")
      .references("id"),
  })
  .map(ITEM);
const schema = { owner, item };

/** The test connection, as `ROLE`. */
const asReader = (): string => {
  const url = new URL(TEST_CONNECTION_STRING!);
  url.username = ROLE;
  url.password = "reader";
  return url.toString();
};

const read = {
  orderBy: { title: "asc" },
  take: 2,
  select: { id: true, title: true, owner: { select: { name: true } } },
} as const;

describeIf("pg column-level grants", () => {
  const admin = new pg.Pool({
    connectionString: TEST_CONNECTION_STRING,
    max: 1,
  });

  beforeAll(async () => {
    await admin.query(`DROP TABLE IF EXISTS "${ITEM}"`);
    await admin.query(`DROP TABLE IF EXISTS "${OWNER}"`);
    await admin.query(`DROP ROLE IF EXISTS ${ROLE}`);
    await admin.query(
      `CREATE TABLE "${OWNER}" ("id" text PRIMARY KEY, "name" text NOT NULL)`
    );
    await admin.query(
      `CREATE TABLE "${ITEM}" ("id" text PRIMARY KEY, "title" text NOT NULL, "secret" text NOT NULL, "ownerId" text NOT NULL REFERENCES "${OWNER}"("id"))`
    );
    await admin.query(
      `INSERT INTO "${OWNER}" VALUES ('o1', 'One'), ('o2', 'Two')`
    );
    await admin.query(
      `INSERT INTO "${ITEM}" VALUES ('i1', 'c', 's1', 'o1'), ('i2', 'a', 's2', 'o2'), ('i3', 'b', 's3', 'o1')`
    );
    await admin.query(`CREATE ROLE ${ROLE} LOGIN PASSWORD 'reader'`);
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
    await admin.query(`GRANT SELECT ON "${OWNER}" TO ${ROLE}`);
    await admin.query(
      `GRANT SELECT ("id", "title", "ownerId") ON "${ITEM}" TO ${ROLE}`
    );
  });

  afterAll(async () => {
    await admin.query(`DROP TABLE IF EXISTS "${ITEM}"`);
    await admin.query(`DROP TABLE IF EXISTS "${OWNER}"`);
    await admin.query(`DROP OWNED BY ${ROLE}`);
    await admin.query(`DROP ROLE IF EXISTS ${ROLE}`);
    await admin.end();
  });

  test("a bounded read with a to-one relation needs no column it does not name", async () => {
    const reader = new pg.Pool({ connectionString: asReader(), max: 1 });
    // The role is refused the column it was not granted.
    await expect(
      reader.query(`SELECT "secret" FROM "${ITEM}"`)
    ).rejects.toThrow();
    const db = createClient({ schema, pool: reader });
    const full = createClient({ schema, pool: admin });
    const answer = await db.item.findMany(read);
    expect(answer).toEqual([
      { id: "i2", title: "a", owner: { name: "Two" } },
      { id: "i3", title: "b", owner: { name: "One" } },
    ]);
    expect(answer).toEqual(await full.item.findMany(read));
    await reader.end();
  });
});
