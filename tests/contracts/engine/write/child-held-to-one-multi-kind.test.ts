import { createClient } from "@client/client";
import type { QueryExecutionContext, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { UnsupportedOperationError } from "@errors";
import { push } from "@migrations";
import { s } from "@schema";
import { beforeAll, expect, test } from "vitest";

/**
 * M8(a) — **two kinds on a CHILD-HELD to-one**.
 *
 * The parent-held to-one dispatch has always asked for exactly one kind
 * (`CreateOperation.interpretParentHeld`, `UpdateOperation.interpretRelation`'s
 * `fk.holdsFK` branch): a to-one slot holds ONE row, so `{ create, connect }` names two
 * intents for one slot and there is no order in which both are right. The CHILD-HELD
 * dispatch — where the target holds the foreign key — had no such gate at either root and
 * simply LOOPED the kinds, building every arm.
 *
 * What that produced, measured at 330d43c through the public client:
 *   · on a 1:1 leg (the child's FK carries the `FK008` unique) — an engine-emitted
 *     `UniqueConstraintError` from the second arm, a database contradiction standing in
 *     for a typed refusal;
 *   · on a leg whose child FK is NOT unique — the fields-less `manyToOne` inverse, whose
 *     FK is resolved from the target's own back-reference — **two rows in a to-one slot**,
 *     silently, with no diagnostic at all. `hub.ticket` then reads back one arbitrary row
 *     of two.
 *
 * The guard added at both child-held dispatch positions is the twin of the parent-held
 * one, and this file is its permanent witness: the refusal is typed, it happens at
 * CONSTRUCTION (no statement reaches the database), and the three neighbours it must not
 * touch — the parent-held control, the single-kind controls, and the to-MANY sibling that
 * legitimately composes many kinds — are pinned alongside it.
 */

// =============================================================================
// SCHEMA
// =============================================================================

/**
 * Four legs on one parent, so a single call can prove the guard fires on the child-held
 * dispatch and NOT on its neighbours:
 *
 *   · `hub.card`   — child-held to-one, the child's FK unique (a real 1:1);
 *   · `hub.ticket` — child-held to-one spelled with the MANY-side helper and no
 *     `.fields()`: `getFkDirection` resolves the edge from `ticket.hub`'s back-reference,
 *     so `isToOne` is true while `ticket.hubId` carries no unique. This is the leg where
 *     the missing guard wrote two rows into a to-one slot. `hub.tickets` / `ticket.hubs`
 *     exist only to satisfy the inverse-pairing rules (R003/R004) for that spelling;
 *   · `hub.owner`  — parent-held to-one, the control for the guard that already existed;
 *   · `hub.notes`  — to-many, the control that must keep composing several kinds.
 */
const hub = s
  .model({
    id: s.int().id(),
    label: s.string(),
    card: s.oneToOne(() => card).optional(),
    ticket: s.manyToOne(() => ticket).optional(),
    tickets: s.oneToMany(() => ticket),
    ownerId: s.int().nullable(),
    owner: s
      .manyToOne(() => owner)
      .fields("ownerId")
      .references("id")
      .optional(),
    notes: s.oneToMany(() => note),
  })
  .map("m8_hubs");

const card = s
  .model({
    id: s.int().id(),
    name: s.string(),
    // `.unique()` is the 1:1 occupied-slot guard (`FK008` refuses to define a 1:1
    // without it) — the reason this leg failed loudly while `ticket` failed silently.
    hubId: s.int().unique().nullable(),
    hub: s
      .oneToOne(() => hub)
      .fields("hubId")
      .references("id")
      .optional(),
  })
  .map("m8_cards");

const ticket = s
  .model({
    id: s.int().id(),
    code: s.string(),
    // NOT unique: many tickets may reference one hub. `hub.ticket` nonetheless presents
    // the edge as to-one.
    hubId: s.int().nullable(),
    hub: s
      .manyToOne(() => hub)
      .fields("hubId")
      .references("id")
      .optional(),
    hubs: s.oneToMany(() => hub),
  })
  .map("m8_tickets");

const owner = s
  .model({
    id: s.int().id(),
    name: s.string(),
    hubs: s.oneToMany(() => hub),
  })
  .map("m8_owners");

const note = s
  .model({
    id: s.int().id(),
    body: s.string(),
    hubId: s.int().nullable(),
    hub: s
      .manyToOne(() => hub)
      .fields("hubId")
      .references("id")
      .optional(),
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
  await push(client, { force: true });
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
        card: { create: { id: 11, name: "fresh" }, connect: { id: 10 } },
      },
    })
  );

  expect(error).toBeInstanceOf(UnsupportedOperationError);
  expect((error as Error).message).toBe(
    "query-engine-v2 create supports one operation on the to-one relation 'card'; it has connect, create."
  );
  // The refusal is a CONSTRUCTION decision: nothing was planned, so nothing ran.
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
        card: { create: { id: 21, name: "fresh" }, connect: { id: 20 } },
      },
    })
  );

  expect(error).toBeInstanceOf(UnsupportedOperationError);
  expect((error as Error).message).toBe(
    "query-engine-v2 update supports one mutation kind on the to-one relation 'card'; it has connect, create."
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
        ticket: { create: { id: 31, code: "fresh" }, connect: { id: 30 } },
      },
    })
  );

  // The STATE invariant first, because it is the one the missing guard violated without
  // saying anything: measured at 330d43c this call resolved successfully and left rows
  // 30 AND 31 both pointing at hub 3.
  await expect(
    client.ticket.findMany({ where: { hubId: 3 }, orderBy: { id: "asc" } })
  ).resolves.toEqual([]);
  expect(error).toBeInstanceOf(UnsupportedOperationError);
  expect((error as Error).message).toBe(
    "query-engine-v2 update supports one mutation kind on the to-one relation 'ticket'; it has connect, create."
  );
  expect(statements).toEqual([]);
});

// =============================================================================
// CONTROLS — the neighbours the guard must not move
// =============================================================================

test("the parent-held control keeps its own refusal, unchanged", async () => {
  await client.owner.create({ data: { id: 40, name: "o" } });

  await expect(
    client.hub.create({
      data: {
        id: 4,
        label: "d",
        owner: { create: { id: 41, name: "fresh" }, connect: { id: 40 } },
      },
    })
  ).rejects.toThrow(
    "query-engine-v2 create supports one operation on the to-one relation 'owner'; it has connect, create."
  );

  await client.hub.create({ data: { id: 5, label: "e" } });
  await expect(
    client.hub.update({
      where: { id: 5 },
      data: {
        owner: { create: { id: 42, name: "fresh" }, connect: { id: 40 } },
      },
    })
  ).rejects.toThrow(
    "query-engine-v2 update supports one mutation kind on the to-one relation 'owner'; it has connect, create."
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
  // The boundary of the guard's predicate (`> 1`, not `!== 1`): an empty relation payload
  // asks for nothing, which is why the child-held dispatch answers it by building
  // nothing. Pinned so a later `!== 1` "tidy-up" of the guard fails here.
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
  // The guard is keyed on to-ONE arity, not on the child-held direction: a to-many
  // relation legitimately names several kinds at once and must be untouched.
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
