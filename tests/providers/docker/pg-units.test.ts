/**
 * pg Driver Tests - the `transaction` point on a real PostgreSQL server: a
 * setting made as the transaction opens holds for everything sent in it.
 *
 * NOTE: These tests require a running PostgreSQL database.
 */

import { PgDriver } from "@drivers/pg";
import { sql } from "@src/index";
import { openOnFixture } from "@tests/contracts/public-client/on-behavior";
import { dropEveryLiveTable, TEST_CONNECTION_STRING } from "./pg-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("pg Driver: transaction point", () => {
  beforeEach(dropEveryLiveTable);
  afterAll(dropEveryLiveTable);

  test("SET LOCAL made as a transaction opens is read by the statements of that transaction, and by no other", async () => {
    const base = await openOnFixture(
      new PgDriver({ databaseUrl: TEST_CONNECTION_STRING })
    );
    try {
      const db = base.$extends({
        name: "tenant",
        async transaction(run) {
          await run(sql`SET LOCAL app.tenant = 'acme'`);
        },
      });
      const tenant = (client: Pick<typeof db, "$queryRaw">) =>
        client.$queryRaw<
          { tenant: string | null }[]
        >`SELECT current_setting('app.tenant', true) AS tenant`;

      expect(await db.$transaction((tx) => tenant(tx))).toEqual([
        { tenant: "acme" },
      ]);
      // An array transaction opens one too.
      expect(await db.$transaction([tenant(db)])).toEqual([
        [{ tenant: "acme" }],
      ]);
      // Outside any transaction, nothing was set.
      expect((await tenant(db))[0]!.tenant ?? "").toBe("");
      // A write's own transaction opens with it as well: the write goes through.
      await db.user.update({
        where: { id: "u1" },
        data: { posts: { create: { id: "p9", title: "new" } } },
      });
      expect(await db.post.count()).toBe(4);
    } finally {
      await base.$disconnect();
    }
  });
});
