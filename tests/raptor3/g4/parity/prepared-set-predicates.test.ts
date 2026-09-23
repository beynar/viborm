/**
 * FC-03 — a captured set's COMPLEMENT is prepared meaning, never public syntax.
 *
 * The engine states two internal premises about a set of rows it has just
 * read: "no row has JOINED this selection" (`requireNoAddedMember`, the nested
 * series capture) and "the captured rows are still the whole selection"
 * (`requireCapturedSet`, the root selected bulk mutation). Both used to spell
 * the exclusion as the PUBLIC payload `{ NOT: { OR: [identities] } }` and hand
 * it to `prepareSelector`.
 *
 * N4 makes a DECLARED field win the combinator key, so on a model that legally
 * declares a scalar named `NOT` that payload is read as that scalar, and the
 * operation died on `EngineInvariantError: Raptor 3 filter operator is not
 * implemented: OR` — the closure review's executed failure ("review: internal
 * captured-set predicates with NOT field",
 * `docs/architecture/raptor3-evidence/g4/release/closure-review/`).
 *
 * `Queries.excludeIdentities` now composes the complement from the captured
 * identities' own equalities under the one combinator owner, so the premise
 * cannot collide with a public name. These cells are the repair's witnesses:
 * the review case, the legal combinator-named scalars and relation, both
 * consumers, empty and non-empty captures, complete compound identities, the
 * limited capture's distinct policy, and the race the complement exists for.
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

/** A premise statement, as the adapter marks one. */
const PREMISE = /__viborm_assert__/;
/** The complement, as the adapter spells a negated captured set. */
const COMPLEMENT = /NOT \(/;
/** The negated half of a guard: everything the captured set excludes. */
const complementOf = (guard: string) => guard.slice(guard.indexOf("NOT ("));
/** One captured key column, as the complement excludes it. */
const excluded = (column: string) =>
  new RegExp(`"q\\d+"\\."${column}"(?: COLLATE \\w+)? = \\?`, "g");

const CHANGED = (verb: string) =>
  `${verb} selected-row cardinality changed during its locked mutation.`;

describe("FC-03: the captured set's complement is prepared, not spelled", () => {
  let driver: BatchOnlyDriver;
  afterEach(async () => {
    await driver?.disconnect();
  });

  /** The complement guards this operation emitted, one per capture. */
  const complements = () => [
    ...new Set(
      driver.statements
        .map((statement) => statement.sql)
        .filter((sql) => PREMISE.test(sql) && COMPLEMENT.test(sql))
    ),
  ];

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

  it("the review case: a captured delete with a relation projection on a model whose scalars are named NOT and OR", async () => {
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
    // The premise really ran: this is the statement that used to be refused.
    assert.equal(complements().length, 1);
    assert.equal(
      (complementOf(complements()[0]!).match(excluded("id")) ?? []).length,
      1
    );
  });

  it("a selected bulk delete filters by the scalar named OR while the complement excludes the captured identities", async () => {
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
    assert.equal(complements().length, 1);
    // Both captured rows are excluded, by their key.
    assert.equal(
      (complementOf(complements()[0]!).match(excluded("id")) ?? []).length,
      2
    );
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

  it("an empty capture publishes nothing, changes nothing and claims no complement", async () => {
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
    assert.deepEqual(complements(), []);
  });

  it("a LIMITED capture claims no complement; the unlimited one does", async () => {
    const client = await world(() => new NonReturningBatchOnlyDriver());
    const limited = await client.item.deleteMany({
      where: { OR: "drop" },
      limit: 1,
      select: { id: true },
    });
    assert.equal(limited.length, 1);
    // A slice of the selection is a valid answer even if another row joins it,
    // so the limited capture asserts presence only — the callers' policies are
    // distinct and stay distinct.
    assert.deepEqual(complements(), []);
    assert.equal((await items(client)).length, 2);

    driver.reset();
    assert.deepEqual(
      await client.item.deleteMany({
        where: { OR: "keep" },
        select: { id: true },
      }),
      [{ id: 1 }]
    );
    assert.equal(complements().length, 1);
  });

  it("a compound identity is excluded completely, by every key column", async () => {
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
    assert.equal(complements().length, 1);
    const guard = complementOf(complements()[0]!);
    // Two identities, both complete: each excluded row names BOTH key columns.
    assert.equal((guard.match(excluded("tenant")) ?? []).length, 2);
    assert.equal((guard.match(excluded("code")) ?? []).length, 2);
  });

  it("a row that JOINS a combinator-named selection after the capture aborts before the write", async () => {
    const client = await world(() => new NonReturningBatchOnlyDriver());
    driver.plant = (database) => {
      database.exec(
        `INSERT INTO "fc03_items" ("id", "NOT", "OR", "boxId") VALUES (4, 40, 'drop', 1)`
      );
    };
    await assert.rejects(
      async () => {
        await client.item.deleteMany({
          where: { OR: "drop" },
          select: { id: true },
        });
      },
      (error: unknown) =>
        (error as Error).message.includes(CHANGED("deleteMany"))
    );
    // Nothing of the unit committed: the race's row and both captured rows live.
    assert.deepEqual(await items(client), [
      { id: 1, NOT: 10 },
      { id: 2, NOT: 20 },
      { id: 3, NOT: 30 },
      { id: 4, NOT: 40 },
    ]);
  });

  it("a nested captured deletion through a relation named AND excludes its captured members", async () => {
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
    // The series' own complement: "connected ∧ filter ∧ key ∉ captured".
    assert.equal(complements().length, 1);
    assert.equal(
      (complementOf(complements()[0]!).match(excluded("id")) ?? []).length,
      2
    );
  });

  it("an EMPTY nested capture still rides its guard on the batch, stating no complement", async () => {
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
    // The series captured no member, so the set's complement states no
    // condition — and the guard that carries it still rides the batch: an
    // empty capture is a captured set, not an absent premise.
    const guards = [
      ...new Set(
        driver.statements
          .map((statement) => statement.sql)
          .filter((sql) => PREMISE.test(sql) && sql.includes("fc03_items"))
      ),
    ];
    assert.equal(guards.length, 1);
    assert.equal(driver.batchCalls, 1);
    assert.deepEqual(complements(), []);
    assert.deepEqual(await items(client), [
      { id: 1, NOT: 10 },
      { id: 2, NOT: 20 },
      { id: 3, NOT: 30 },
    ]);
  });
});
