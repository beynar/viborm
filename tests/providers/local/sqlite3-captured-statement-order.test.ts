/**
 * SQLite3 provider suite — a captured bulk mutation's statement is built
 * AFTER its premises, and the SQL says so.
 *
 * `OperationContext.capturedMutation` lowers the verb's UPDATE/DELETE only
 * once the captured set's premises are queued, so the aliases a relation
 * filter takes inside the write continue the premises' alias scope instead of
 * restarting it. On the batch route the premises are three statements over
 * `q0..q2`, so the write's two relation filters read `q3` and `q4`. Building
 * the statement before the premises would number them `q1`/`q2`: the same
 * rows, a different text, and a byte-identity promise broken.
 */

import { createClient } from "@client/client";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { describe, expect, test } from "vitest";
import { BatchOnlyDriver } from "../../raptor3/g4/parity/batch-only-drivers";

const parent = s
  .model({
    id: s.int().id(),
    label: s.string(),
    active: s.boolean(),
    children: s.toMany(() => child),
  })
  .map("order_parents");
const child = s
  .model({
    id: s.int().id(),
    label: s.string(),
    parentId: s.int(),
    parent: s
      .toOne(() => parent)
      .fields("parentId")
      .references("id")
      .onDelete("cascade"),
  })
  .map("order_children");
const schema = { parent, child };

/** The verb's own write against the parents table. */
const WRITE = /^(?:UPDATE|DELETE)\b/;

const where = {
  active: true,
  children: { some: { label: "x" } },
  NOT: { children: { none: { label: "y" } } },
};

class NonReturningBatchOnlyDriver extends BatchOnlyDriver {
  constructor() {
    super({ dataDir: ":memory:" });
    this.adapter.capabilities.supportsReturning = false;
  }
}

describe("a captured bulk mutation's write continues its premises' alias scope", () => {
  for (const verb of ["updateMany", "deleteMany"] as const) {
    test(`batch route: the captured ${verb} write reads its relation filters as q3/q4`, async () => {
      const driver = new NonReturningBatchOnlyDriver();
      const client = createClient({ schema, driver });
      await syncLiveSchema(client);
      for (const id of [1, 2])
        await client.parent.create({
          data: {
            id,
            label: `p${id}`,
            active: true,
            children: {
              create: [
                { id: id * 10, label: "x" },
                { id: id * 10 + 1, label: "y" },
              ],
            },
          },
        });
      driver.reset();

      const result =
        verb === "updateMany"
          ? await client.parent.updateMany({
              where,
              data: { label: "u" },
              select: { id: true },
            })
          : await client.parent.deleteMany({ where, select: { id: true } });
      expect(result).toEqual([{ id: 1 }, { id: 2 }]);

      const writes = driver.statements
        .map((statement) => statement.sql)
        .filter((sql) => WRITE.test(sql));
      // The recording driver logs a batch statement once as queued and once
      // as run; one text, however many times it is written down.
      expect(new Set(writes).size).toBe(1);
      const write = writes[0] ?? "";
      expect(write).toContain('"order_children" AS "q3"');
      expect(write).toContain('"order_children" AS "q4"');
      expect(write).not.toContain('AS "q1"');
      await client.$disconnect();
    });
  }
});
