/**
 * MySQL2 Driver Tests — governed raw reads: `$rows` names every table it
 * reads with the bound database, so a caller's CTE cannot stand for one, and
 * an unbound client (a supplied pool) refuses it.
 *
 * NOTE: These tests require a running MySQL database.
 */

import { createClient } from "@client/client";
import { MySQL2Driver } from "@drivers/mysql2";
import { s } from "@schema";
import { permissions } from "@src/permissions";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { v } from "@validation";
import { createPool } from "mysql2/promise";
import {
  createMySQL2Driver,
  dropEveryLiveTable,
  TEST_CONNECTION_STRING,
} from "./mysql2-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

const user = s.model({
  id: s.string().id(),
  name: s.string(),
  pages: s.toMany(() => page),
});
const page = s.model({
  id: s.string().id(),
  owner: s.string(),
  author: s
    .toOne(() => user)
    .fields("owner")
    .references("id"),
});
const schema = { user, page };
const policy = permissions({
  actor: v.object({ name: v.string() }),
  models: {
    user: { read: true },
    page: { read: { author: { name: { actor: "name" } } } },
  },
});
const ids = (rows: unknown) =>
  (rows as Array<{ id: string }>).map(({ id }) => id).sort();

describeIf("MySQL2 $rows", () => {
  beforeEach(dropEveryLiveTable);
  afterAll(dropEveryLiveTable);

  test("pins its tables to the bound database: a caller's CTE cannot stand for one", async () => {
    const base = createClient({ schema, driver: createMySQL2Driver() });
    try {
      await syncLiveSchema(base);
      await base.user.createMany({
        data: [
          { id: "alice", name: "Alice" },
          { id: "bob", name: "Bob" },
        ],
      });
      await base.page.createMany({
        data: [
          { id: "a", owner: "alice" },
          { id: "c", owner: "bob" },
        ],
      });
      const bob = base.$extends(policy).$as({ name: "Bob" });
      const plain = ids(
        await bob.$queryRaw`SELECT p.id FROM ${bob.page.$rows("p")}`
      );
      expect(plain).toEqual(["c"]);
      const shadowed = await bob.$queryRaw`
        WITH user AS (SELECT u0.id AS id, ${"Bob"} AS name FROM page AS u0)
        SELECT p.id FROM ${bob.page.$rows("p")}`;
      expect(ids(shadowed)).toEqual(plain);
    } finally {
      await base.$disconnect();
    }
  });

  test("an unbound client refuses it", async () => {
    const pool = createPool(TEST_CONNECTION_STRING!);
    const base = createClient({ schema, driver: new MySQL2Driver({ pool }) });
    try {
      const bob = base.$extends(policy).$as({ name: "Bob" });
      await expect(
        bob.$queryRaw`SELECT p.id FROM ${bob.page.$rows("p")}`
      ).rejects.toThrow("$rows() needs a driver bound to its database");
    } finally {
      await base.$disconnect();
      await pool.end();
    }
  });
});
