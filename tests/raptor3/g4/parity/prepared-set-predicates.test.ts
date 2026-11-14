/**
 * FC-03 — a model may declare fields named like the filter combinators.
 *
 * A declared field wins the combinator key (N4): a scalar named `NOT` or
 * `OR`, a relation named `AND`. A write that reads a set of such rows and
 * writes them by their keys names those rows by prepared identities, never by
 * a public payload a declared field could capture: the closure review's
 * executed failure was `EngineInvariantError: Raptor 3 filter operator is not
 * implemented: OR` on exactly these models.
 *
 * These cells witness the answers and the effects: the review case, the
 * combinator-named scalars and relation, empty and non-empty sets, a compound
 * identity, a limited set, on batch transports with and without RETURNING.
 */

import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, describe, it } from "vitest";
import { BatchOnlyDriver } from "./batch-only-drivers";

const box = s
  .model({
    id: s.int().id(),
    label: s.string(),
    /** A RELATION named like a combinator, and the nested series' edge. */
    AND: s.toMany(() => item).name("fc03Tagged"),
    owned: s.toMany(() => item).name("fc03Owner"),
  })
  .map("fc03_boxes");

const item = s
  .model({
    id: s.int().id(),
    /** The scalars the review's failing model declared. */
    NOT: s.int(),
    OR: s.string(),
    boxId: s.int().nullable(),
    box: s
      .toOne(() => box)
      .fields("boxId")
      .references("id")
      .name("fc03Owner"),
    boxes: s.toMany(() => box).name("fc03Tagged"),
  })
  .map("fc03_items");

/** A COMPOUND identity, on a model that also declares a scalar named `NOT`. */
const ticket = s
  .model({
    tenant: s.string(),
    code: s.string(),
    NOT: s.string(),
  })
  .id(["tenant", "code"])
  .map("fc03_tickets");

const schema = { box, item, ticket };

/** A PlanetScale-shaped transport: a native batch and no RETURNING. */
class NonReturningBatchOnlyDriver extends BatchOnlyDriver {
  constructor() {
    super();
    this.adapter.capabilities.supportsReturning = false;
  }
}

describe("FC-03: fields named like combinators are written as any other", () => {
  let driver: BatchOnlyDriver;
  afterEach(async () => {
    await driver?.disconnect();
  });

  async function world(
    make: () => BatchOnlyDriver = () => new BatchOnlyDriver()
  ) {
    driver = make();
    const client = createClient({ schema, driver });
    await syncLiveSchema(client);
    await client.box.create({ data: { id: 1, label: "one" } });
    await client.box.create({ data: { id: 2, label: "two" } });
    await client.item.create({
      data: { id: 1, NOT: 10, OR: "keep", boxId: 1 },
    });
    await client.item.create({
      data: { id: 2, NOT: 20, OR: "drop", boxId: 1 },
    });
    await client.item.create({
      data: { id: 3, NOT: 30, OR: "drop", boxId: 2 },
    });
    driver.reset();
    return client;
  }
  const items = async (client: Awaited<ReturnType<typeof world>>) =>
    await client.item.findMany({
      orderBy: { id: "asc" },
      select: { id: true, NOT: true },
    });
  const byId = <T extends { id: number }>(rows: T[]) =>
    [...rows].sort((left, right) => left.id - right.id);

  it("the review case: a delete with a relation projection on a model whose scalars are named NOT and OR", async () => {
    const client = await world();
    assert.deepEqual(
      await client.item.delete({ where: { id: 2 }, include: { box: true } }),
      {
        id: 2,
        NOT: 20,
        OR: "drop",
        boxId: 1,
        box: { id: 1, label: "one" },
      }
    );
    // The effect, not just the answer: the row is gone and its siblings are not.
    assert.deepEqual(await items(client), [
      { id: 1, NOT: 10 },
      { id: 3, NOT: 30 },
    ]);
  });

  it("a selected bulk delete filters by the scalar named OR and removes the rows it answers with", async () => {
    const client = await world(() => new NonReturningBatchOnlyDriver());
    assert.deepEqual(
      byId(
        await client.item.deleteMany({
          where: { OR: "drop" },
          select: { id: true, NOT: true },
        })
      ),
      [
        { id: 2, NOT: 20 },
        { id: 3, NOT: 30 },
      ]
    );
    assert.deepEqual(await items(client), [{ id: 1, NOT: 10 }]);
  });

  it("a selected bulk update writes the scalar named NOT and publishes the rows it wrote", async () => {
    const client = await world(() => new NonReturningBatchOnlyDriver());
    assert.deepEqual(
      byId(
        await client.item.updateMany({
          where: { OR: "drop" },
          data: { NOT: 99 },
          select: { id: true, NOT: true },
        })
      ),
      [
        { id: 2, NOT: 99 },
        { id: 3, NOT: 99 },
      ]
    );
    assert.deepEqual(await items(client), [
      { id: 1, NOT: 10 },
      { id: 2, NOT: 99 },
      { id: 3, NOT: 99 },
    ]);
  });

  it("an empty set publishes nothing and changes nothing", async () => {
    const client = await world(() => new NonReturningBatchOnlyDriver());
    assert.deepEqual(
      await client.item.deleteMany({
        where: { OR: "absent" },
        select: { id: true },
      }),
      []
    );
    assert.deepEqual(await items(client), [
      { id: 1, NOT: 10 },
      { id: 2, NOT: 20 },
      { id: 3, NOT: 30 },
    ]);
  });

  it("a limited set takes its slice; the unlimited one takes every row", async () => {
    const client = await world(() => new NonReturningBatchOnlyDriver());
    const limited = await client.item.deleteMany({
      where: { OR: "drop" },
      limit: 1,
      select: { id: true },
    });
    assert.equal(limited.length, 1);
    assert.equal((await items(client)).length, 2);

    driver.reset();
    assert.deepEqual(
      await client.item.deleteMany({
        where: { OR: "keep" },
        select: { id: true },
      }),
      [{ id: 1 }]
    );
  });

  it("rows of a compound identity are removed by every key column", async () => {
    const client = await world(() => new NonReturningBatchOnlyDriver());
    await client.ticket.create({
      data: { tenant: "t1", code: "a", NOT: "x" },
    });
    await client.ticket.create({
      data: { tenant: "t1", code: "b", NOT: "x" },
    });
    await client.ticket.create({
      data: { tenant: "t2", code: "a", NOT: "y" },
    });
    driver.reset();
    const removed = await client.ticket.deleteMany({
      where: { NOT: "x" },
      select: { tenant: true, code: true },
    });
    assert.deepEqual(
      [...removed].sort((left, right) => left.code.localeCompare(right.code)),
      [
        { tenant: "t1", code: "a" },
        { tenant: "t1", code: "b" },
      ]
    );
    assert.deepEqual(await client.ticket.findMany(), [
      { tenant: "t2", code: "a", NOT: "y" },
    ]);
  });

  it("a nested deletion through a relation named AND removes the members its filter names", async () => {
    const client = await world();
    await client.box.update({
      where: { id: 1 },
      data: { AND: { connect: [{ id: 2 }, { id: 3 }] } },
    });
    driver.reset();
    await client.box.update({
      where: { id: 1 },
      data: { AND: { deleteMany: { OR: "drop" } } },
    });
    assert.deepEqual(await items(client), [{ id: 1, NOT: 10 }]);
  });

  it("a nested deletion through a relation named AND that names no member changes nothing", async () => {
    const client = await world();
    await client.box.update({
      where: { id: 1 },
      data: { AND: { connect: [{ id: 2 }, { id: 3 }] } },
    });
    driver.reset();
    await client.box.update({
      where: { id: 1 },
      data: { AND: { deleteMany: { OR: "absent" } } },
    });
    assert.deepEqual(await items(client), [
      { id: 1, NOT: 10 },
      { id: 2, NOT: 20 },
      { id: 3, NOT: 30 },
    ]);
  });
});
