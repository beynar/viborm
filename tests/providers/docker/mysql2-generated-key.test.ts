/**
 * M1 (D-57) — what MySQL can and cannot generate, measured on the live lane.
 *
 * MySQL is the only adapter in the tree that declares
 * `supportsReturning: false` (`mysql-adapter.ts`), so it is the only provider
 * on which the engine has to NAME an inserted row without reading it back. It
 * names it from a key the payload spelled, from the key the ORM produced in
 * JavaScript at admission, or from the ONE column the provider generated and
 * then reported for that statement (`LAST_INSERT_ID`, `insertId`).
 *
 * The two refusals `Raptor 3 interactive output requires RETURNING or one
 * generated increment field` and `Driver 'X' cannot locate one selected
 * createMany row after insertion` are reached by one shape only: a model with
 * more than one generated column among the fields the operation must know.
 * The first cell measures why no MySQL database can hold that shape — a second
 * AUTO_INCREMENT column is refused at DDL time with errno 1075 — and the rest
 * measure that every identity MySQL CAN hold is named on this lane.
 *
 * The suite owns four `m1gk_*` tables, creates them verbatim and drops only
 * those: the database is shared, so nothing here pushes a schema or drops
 * anything it did not create.
 *
 * NOTE: requires a running MySQL (docker). Set MYSQL_TEST_CONNECTION_STRING.
 */

import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { s } from "@schema";
import { afterAll, beforeAll, describe, it } from "vitest";
import { createMySQL2Driver, TEST_CONNECTION_STRING } from "./mysql2-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

/** The key the ORM produces in JavaScript at admission. */
const doc = s
  .model({ id: s.string().id(), label: s.string() })
  .map("m1gk_docs");
/** The one column the provider generates and names. */
const ticket = s
  .model({ id: s.int().id().increment(), label: s.string() })
  .map("m1gk_tickets");
/** A compound key: one part spelled, one part generated. */
const slot = s
  .model({ tenant: s.string(), seat: s.int().increment(), label: s.string() })
  .id(["tenant", "seat"])
  .map("m1gk_slots");
const schema = { doc, slot, ticket };

const TABLES = ["m1gk_docs", "m1gk_tickets", "m1gk_slots", "m1gk_pairs"];
const DDL = [
  "CREATE TABLE `m1gk_docs` (`id` VARCHAR(191) NOT NULL, `label` VARCHAR(191) NOT NULL, PRIMARY KEY (`id`))",
  "CREATE TABLE `m1gk_tickets` (`id` INT NOT NULL AUTO_INCREMENT, `label` VARCHAR(191) NOT NULL, PRIMARY KEY (`id`))",
  "CREATE TABLE `m1gk_slots` (`seat` INT NOT NULL AUTO_INCREMENT, `tenant` VARCHAR(191) NOT NULL, `label` VARCHAR(191) NOT NULL, PRIMARY KEY (`seat`), UNIQUE KEY `m1gk_slots_key` (`tenant`, `seat`))",
];

/** The shape neither sentence would be reached without. */
const TWO_GENERATED_COLUMNS =
  "CREATE TABLE `m1gk_pairs` (`left` INT NOT NULL AUTO_INCREMENT, `right` INT NOT NULL AUTO_INCREMENT, `label` VARCHAR(191) NOT NULL, PRIMARY KEY (`left`, `right`))";

describeIf("M1: the keys MySQL can generate", () => {
  const client = createClient({ schema, driver: createMySQL2Driver() });

  beforeAll(async () => {
    for (const table of TABLES)
      await client.$executeRawUnsafe(`DROP TABLE IF EXISTS \`${table}\``);
    for (const statement of DDL) await client.$executeRawUnsafe(statement);
  });

  afterAll(async () => {
    for (const table of TABLES)
      await client.$executeRawUnsafe(`DROP TABLE IF EXISTS \`${table}\``);
    await client.$disconnect();
  });

  it("refuses a second generated column, so no MySQL database holds the shape the two refusals guard", async () => {
    const failure = await client.$executeRawUnsafe(TWO_GENERATED_COLUMNS).then(
      () => undefined,
      (error: unknown) => error
    );
    assert.notEqual(
      failure,
      undefined,
      "MySQL accepted two AUTO_INCREMENT columns"
    );
    const cause = (
      failure as { originalCause?: { errno?: number; sqlState?: string } }
    ).originalCause;
    // 1075: "there can be only one auto column and it must be defined as a key".
    assert.equal(cause?.errno, 1075);
    assert.equal(cause?.sqlState, "42000");
  });

  it("names a row by the key the ORM produced at admission", async () => {
    const created = await client.doc.create({
      data: { label: "one" },
      select: { id: true, label: true },
    });
    assert.equal(typeof created.id, "string");
    assert.deepEqual(
      await client.doc.findUnique({
        where: { id: created.id },
        select: { id: true, label: true },
      }),
      created
    );
    const many = await client.doc.createMany({
      data: [{ label: "two" }, { label: "three" }],
      select: { id: true, label: true },
    });
    assert.deepEqual(
      many.map((row) => row.label),
      ["two", "three"]
    );
    for (const row of many) assert.equal(typeof row.id, "string");
  });

  it("names a row by the one column it generated, including through skipDuplicates", async () => {
    const created = await client.ticket.create({
      data: { label: "first" },
      select: { id: true, label: true },
    });
    assert.equal(created.label, "first");
    assert.equal(typeof created.id, "number");
    const many = await client.ticket.createMany({
      data: [{ label: "second" }, { label: "third" }],
      select: { id: true, label: true },
    });
    assert.deepEqual(
      many.map((row) => row.label),
      ["second", "third"]
    );
    assert.equal(many[0]!.id, created.id + 1);
    // MySQL's skipDuplicates is the recoverable-unique-error strategy, which
    // takes the same member-at-a-time arm.
    const skipped = await client.ticket.createMany({
      data: [{ label: "fourth" }],
      skipDuplicates: true,
      select: { id: true, label: true },
    });
    assert.deepEqual(
      skipped.map((row) => row.label),
      ["fourth"]
    );
  });

  it("names a compound key whose spelled part and generated part are both known", async () => {
    const created = await client.slot.create({
      data: { tenant: "acme", label: "desk" },
      select: { tenant: true, seat: true, label: true },
    });
    assert.equal(created.tenant, "acme");
    assert.equal(typeof created.seat, "number");
    const many = await client.slot.createMany({
      data: [{ tenant: "acme", label: "chair" }],
      select: { tenant: true, seat: true, label: true },
    });
    assert.deepEqual(
      many.map((row) => row.label),
      ["chair"]
    );
    assert.equal(many[0]!.seat, created.seat + 1);
  });

  it("computes a default expression in a read, but reserves no auto-increment ahead of an insert", async () => {
    // `SELECT UUID()` is an ordinary observation: the provider computes it and
    // the value is the caller's from then on.
    const [first] = await client.$queryRawUnsafe<{ u: string }>(
      "SELECT UUID() AS u"
    );
    const [second] = await client.$queryRawUnsafe<{ u: string }>(
      "SELECT UUID() AS u"
    );
    assert.notEqual(first!.u, second!.u);
    // The next AUTO_INCREMENT is not one: it is a catalog statistic, and two
    // readers are handed the same number because nothing reserved it.
    const next = async () =>
      (
        await client.$queryRawUnsafe<{ next: number }>(
          "SELECT AUTO_INCREMENT AS next FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'm1gk_tickets'"
        )
      )[0]!.next;
    assert.equal(await next(), await next());
  });
});
