import { createClient } from "@client/client";
import type { QueryExecutionContext, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";

import { s } from "@schema";
import { beforeAll, expect, test } from "vitest";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

/**
 * A to-one create and a parent-held update have at most one active operation.
 * A child-held update additionally accepts the fixed vacate-then-supply pairs
 * covered by `vacate-then-supply.test.ts`. Other combinations fail before
 * query-engine construction, while to-many payloads keep combining kinds.
 */

// =============================================================================
// SCHEMA
// =============================================================================

/**
 * Four legs on one parent pin the boundary and its neighboring contracts:
 *
 *   · `hub.card`   — child-held to-one, the child's FK unique (a real 1:1);
 *   · `hub.ticket` — child-held to-one with no `.fields()`: the edge resolves
 *     from `ticket.hub`'s back-reference. This is the leg where an unchecked
 *     multi-operation payload could write two rows, and the payload is still
 *     refused at the parse — before any statement. The `hub.tickets` /
 *     `ticket.hubs` pair beside it is GONE: it existed only to satisfy the old
 *     inverse-pairing ladder, and a second unnamed pair between the same two
 *     models is ambiguous now (R009);
 *   · `hub.owner`  — parent-held to-one control;
 *   · `hub.notes`  — to-many, the control that must keep composing several kinds.
 */
const hub = s
  .model({
    id: s.int().id(),
    label: s.string(),
    card: s.toOne(() => card),
    ticket: s.toOne(() => ticket),
    ownerId: s.int().nullable(),
    owner: s
      .toOne(() => owner)
      .fields("ownerId")
      .references("id"),
    notes: s.toMany(() => note),
  })
  .map("m8_hubs");

const card = s
  .model({
    id: s.int().id(),
    name: s.string(),
    // The declared 1:1 unique. §9.4 deletes the rule that DEMANDED it — two paired
    // to-one slots derive the constraint — but declaring it keeps `hubId` a
    // `whereUnique` selector, which the tests below address the card by.
    hubId: s.int().unique().nullable(),
    hub: s
      .toOne(() => hub)
      .fields("hubId")
      .references("id"),
  })
  .map("m8_cards");

const ticket = s
  .model({
    id: s.int().id(),
    code: s.string(),
    // Undeclared: the paired to-one slots derive this edge's uniqueness (§9.4), so
    // the column carries no separate `.unique()` and is not a `whereUnique` key.
    hubId: s.int().nullable(),
    hub: s
      .toOne(() => hub)
      .fields("hubId")
      .references("id"),
  })
  .map("m8_tickets");

const owner = s
  .model({
    id: s.int().id(),
    name: s.string(),
    hubs: s.toMany(() => hub),
  })
  .map("m8_owners");

const note = s
  .model({
    id: s.int().id(),
    body: s.string(),
    hubId: s.int().nullable(),
    hub: s
      .toOne(() => hub)
      .fields("hubId")
      .references("id"),
  })
  .map("m8_notes");

const schema = { hub, card, ticket, owner, note };

// =============================================================================
// FIXTURE
// =============================================================================

/** Records every statement, so "no SQL" is an assertion rather than an inference. */
class RecordingPGliteDriver extends PGliteDriver {
  readonly statements: string[] = [];
  recording = false;

  protected override execute<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    if (this.recording) this.statements.push(sql);
    return super.execute<T>(client, sql, params, context);
  }

  protected override executeRaw<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    if (this.recording) this.statements.push(sql);
    return super.executeRaw<T>(client, sql, params, context);
  }
}

const driver = new RecordingPGliteDriver({ client: new PGlite() });
const client = createClient({ schema, driver });

beforeAll(async () => {
  await syncLiveSchema(client);
});

/** Runs `call` with the statement recorder on, and returns what it emitted. */
async function recorded(call: () => PromiseLike<unknown>): Promise<{
  error: unknown;
  statements: string[];
}> {
  driver.statements.length = 0;
  driver.recording = true;
  let error: unknown;
  try {
    await call();
  } catch (caught) {
    error = caught;
  } finally {
    driver.recording = false;
  }
  return { error, statements: [...driver.statements] };
}

// =============================================================================
// THE REFUSAL — both roots, both legs
// =============================================================================

test("create root refuses two kinds on a child-held to-one before any statement", async () => {
  await client.card.create({ data: { id: 10, name: "free" } });

  const { error, statements } = await recorded(() =>
    client.hub.create({
      data: {
        id: 1,
        label: "a",
        card: {
          create: { id: 11, name: "fresh" },
          // @ts-expect-error - to-one payloads accept one active operation
          connect: { id: 10 },
        },
      },
    })
  );

  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(
    "Validation failed for create: Unsupported to-one operation combination: create, connect"
  );
  // Validation rejects the payload before planning, so nothing ran.
  expect(statements).toEqual([]);
  await expect(client.hub.findUnique({ where: { id: 1 } })).resolves.toBeNull();
  await expect(
    client.card.findUnique({ where: { id: 10 } })
  ).resolves.toMatchObject({ hubId: null });
});

test("update root refuses two kinds on a child-held to-one before any statement", async () => {
  await client.hub.create({ data: { id: 2, label: "b" } });
  await client.card.create({ data: { id: 20, name: "free" } });

  const { error, statements } = await recorded(() =>
    client.hub.update({
      where: { id: 2 },
      data: {
        card: {
          create: { id: 21, name: "fresh" },
          // @ts-expect-error - to-one payloads accept one active operation
          connect: { id: 20 },
        },
      },
    })
  );

  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(
    "Validation failed for update: Unsupported to-one operation combination: create, connect"
  );
  expect(statements).toEqual([]);
  await expect(client.card.findMany({ where: { hubId: 2 } })).resolves.toEqual(
    []
  );
});

test("update root refuses two kinds on a NON-unique child-held to-one (the two-row hole)", async () => {
  // The leg that failed SILENTLY: `ticket.hubId` carries no unique, so both arms of
  // `{ create, connect }` used to land and the to-one slot ended up holding two rows.
  await client.hub.create({ data: { id: 3, label: "c" } });
  await client.ticket.create({ data: { id: 30, code: "free" } });

  const { error, statements } = await recorded(() =>
    client.hub.update({
      where: { id: 3 },
      data: {
        ticket: {
          create: { id: 31, code: "fresh" },
          // @ts-expect-error - to-one payloads accept one active operation
          connect: { id: 30 },
        },
      },
    })
  );

  // The STATE invariant first, because it is the one the missing guard violated without
  // saying anything: measured at 330d43c this call resolved successfully and left rows
  // 30 AND 31 both pointing at hub 3.
  await expect(
    client.ticket.findMany({ where: { hubId: 3 }, orderBy: { id: "asc" } })
  ).resolves.toEqual([]);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(
    "Validation failed for update: Unsupported to-one operation combination: create, connect"
  );
  expect(statements).toEqual([]);
});

// =============================================================================
// CONTROLS — neighboring contracts the arity boundary must not move
// =============================================================================

test("the parent-held control uses the same validation boundary", async () => {
  await client.owner.create({ data: { id: 40, name: "o" } });

  await expect(
    client.hub.create({
      data: {
        id: 4,
        label: "d",
        owner: {
          create: { id: 41, name: "fresh" },
          // @ts-expect-error - to-one payloads accept one active operation
          connect: { id: 40 },
        },
      },
    })
  ).rejects.toThrow(
    "Unsupported to-one operation combination: create, connect"
  );

  await client.hub.create({ data: { id: 5, label: "e" } });
  await expect(
    client.hub.update({
      where: { id: 5 },
      data: {
        owner: {
          create: { id: 42, name: "fresh" },
          // @ts-expect-error - to-one payloads accept one active operation
          connect: { id: 40 },
        },
      },
    })
  ).rejects.toThrow(
    "Unsupported to-one operation combination: create, connect"
  );
});

test("ONE kind on a child-held to-one still executes at both roots", async () => {
  await client.hub.create({
    data: { id: 6, label: "f", card: { create: { id: 60, name: "made" } } },
  });
  await expect(
    client.card.findUnique({ where: { id: 60 } })
  ).resolves.toMatchObject({ hubId: 6 });

  await client.card.create({ data: { id: 61, name: "adopted" } });
  await client.hub.create({ data: { id: 7, label: "g" } });
  await client.hub.update({
    where: { id: 7 },
    data: { card: { connect: { id: 61 } } },
  });
  await expect(
    client.card.findUnique({ where: { id: 61 } })
  ).resolves.toMatchObject({ hubId: 7 });

  // The non-unique leg, single kind: still one row, still written.
  await client.hub.update({
    where: { id: 7 },
    data: { ticket: { create: { id: 70, code: "made" } } },
  });
  await expect(
    client.ticket.findMany({ where: { hubId: 7 } })
  ).resolves.toMatchObject([{ id: 70 }]);
});

test("a to-one payload naming NO kind stays Prisma's no-op", async () => {
  // An empty ordinary relation payload means "no nested work" and stays valid.
  await client.hub.create({ data: { id: 9, label: "i", card: {} } });
  await expect(
    client.hub.findUnique({ where: { id: 9 } })
  ).resolves.toMatchObject({ label: "i" });
  await client.hub.update({ where: { id: 9 }, data: { card: {} } });
  await expect(client.card.findMany({ where: { hubId: 9 } })).resolves.toEqual(
    []
  );
});

test("the to-MANY sibling still composes several kinds on one relation", async () => {
  // A to-many relation legitimately combines kinds in fixed program order.
  await client.hub.create({ data: { id: 8, label: "h" } });
  await client.note.create({ data: { id: 80, body: "adopted" } });
  await client.hub.update({
    where: { id: 8 },
    data: {
      notes: { create: { id: 81, body: "made" }, connect: { id: 80 } },
    },
  });
  await expect(
    client.note.findMany({ where: { hubId: 8 }, orderBy: { id: "asc" } })
  ).resolves.toMatchObject([{ id: 80 }, { id: 81 }]);
});
