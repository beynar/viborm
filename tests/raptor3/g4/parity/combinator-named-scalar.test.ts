/**
 * N4 — a declared field named like a combinator (`AND`, `OR`, `NOT`) is that
 * field, in `where` and in `having`.
 *
 * Validation builds the three combinator entries first and extends them with
 * the model's own fields, so a scalar literally named `AND` wins the key
 * (`validation/model/core/where.ts`; `validation/model/args/aggregate.ts`
 * says so for `having`). The engine read the combinator first and re-read the admitted
 * scalar filter as a nested `where`, asking the storage resolver for a field
 * named `gt` — the "physical field is not implemented" sentence the census map
 * (#48) called unreachable. The N4 review reached it with this schema; the
 * engine now reads the admitted payload as validation admitted it, and the
 * resolver's sentence is the invariant the unit says it is.
 */

import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, describe, it } from "vitest";
import { RecordingSQLiteDriver } from "../unit02/world";

const row = s
  .model({
    id: s.int().id(),
    AND: s.int(),
    OR: s.string(),
    NOT: s.int().nullable(),
    tag: s.string(),
  })
  .map("n4_combinator_rows");
const owner = s
  .model({
    id: s.int().id(),
    name: s.string(),
    AND: s.toMany(() => child).name("n4CombinatorOwner"),
  })
  .map("n4_combinator_owners");
const child = s
  .model({
    id: s.int().id(),
    ownerId: s.int(),
    label: s.string(),
    owner: s
      .toOne(() => owner)
      .fields("ownerId")
      .references("id")
      .name("n4CombinatorOwner"),
  })
  .map("n4_combinator_children");
const schema = { row, owner, child };

describe("N4: a declared field named like a combinator is that field", () => {
  let driver: RecordingSQLiteDriver;
  afterEach(async () => {
    await driver?.disconnect();
  });

  async function world() {
    driver = new RecordingSQLiteDriver();
    const client = createClient({ schema, driver });
    await syncLiveSchema(client);
    await client.row.create({
      data: { id: 1, AND: 5, OR: "a", NOT: null, tag: "x" },
    });
    await client.row.create({
      data: { id: 2, AND: 7, OR: "b", NOT: 3, tag: "x" },
    });
    await client.row.create({
      data: { id: 3, AND: 9, OR: "c", NOT: 4, tag: "y" },
    });
    await client.owner.create({ data: { id: 1, name: "o" } });
    await client.owner.create({ data: { id: 2, name: "p" } });
    await client.child.create({ data: { id: 1, ownerId: 1, label: "c" } });
    return client;
  }

  it("a RELATION named AND is that relation, in a filter and in an include", async () => {
    const client = await world();
    assert.deepEqual(
      await client.owner.findMany({
        where: { AND: { some: { label: "c" } } },
        select: { id: true },
      }),
      [{ id: 1 }]
    );
    assert.deepEqual(
      await client.owner.findMany({
        where: { id: 1 },
        include: { AND: true },
      }),
      [{ id: 1, name: "o", AND: [{ id: 1, ownerId: 1, label: "c" }] }]
    );
  });

  it("`where` filters the scalar named AND through an operator bag", async () => {
    const client = await world();
    assert.deepEqual(
      await client.row.findMany({
        where: { AND: { gt: 6 } },
        orderBy: { id: "asc" },
        select: { id: true },
      }),
      [{ id: 2 }, { id: 3 }]
    );
  });

  it("`where` filters the scalars named OR and NOT, shorthand and null alike", async () => {
    const client = await world();
    assert.deepEqual(
      await client.row.findMany({ where: { OR: "b" }, select: { id: true } }),
      [{ id: 2 }]
    );
    assert.deepEqual(
      await client.row.findMany({ where: { NOT: null }, select: { id: true } }),
      [{ id: 1 }]
    );
  });

  it("`count` and `groupBy … having` read the field the same way", async () => {
    const client = await world();
    assert.equal(await client.row.count({ where: { AND: { gte: 7 } } }), 2);
    assert.deepEqual(
      await client.row.groupBy({
        by: ["AND"],
        having: { AND: { gt: 6 } },
        orderBy: { AND: "asc" },
      }),
      [{ AND: 7 }, { AND: 9 }]
    );
  });
});
