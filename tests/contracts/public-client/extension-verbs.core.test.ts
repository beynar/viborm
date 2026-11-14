/**
 * Verbs on polymorphic relations (plan K3, R3 as amended in §11.2): a row
 * carrier is written by the row that holds it, a variant join by both rows it
 * links, through the same per-model `verbs` a plain relation takes. A model
 * whose join to the carrier declares no inverse is judged at its `update`
 * verb. The plain relations are witnessed against the Permissions oracle on four
 * databases (tests/contracts/public-client/permissions-app-verbs.ts).
 *
 * Fixture: `openRowScopeFixture` (row-scope-behavior.ts). Pin 1 is on post
 * 11; board 3 holds post 10.
 */

import { createClient } from "@client/client";
import { NestedWriteError, NotFoundError } from "@errors";
import { s } from "@schema";
import {
  openRowScopeFixture,
  type RowScopeFixture,
} from "@tests/contracts/engine/query/row-scope-behavior";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { failure } from "@tests/fixtures/failure";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

/** Every row visible; `update` and the written relation each at its own name. */
const judged = (verbs: Record<string, object>) => ({
  name: "verbs",
  rows: {
    control: "as",
    default: "all",
    models: {},
    verbs: Object.fromEntries(
      Object.entries(verbs).map(([model, entry]) => [
        model,
        {
          predicates: { open: {}, locked: { id: -1 } },
          read: "open",
          update: "open",
          ...entry,
        },
      ])
    ),
  },
});

type Loose = Record<
  string,
  { update(args: object): Promise<unknown> } & {
    findUnique(args: object): Promise<Record<string, unknown> | null>;
  }
>;

describe("verbs on polymorphic relations", () => {
  let fixture: RowScopeFixture;
  beforeEach(async () => {
    fixture = await openRowScopeFixture(createInMemorySQLite3Driver());
  });
  afterEach(async () => {
    await fixture.base.$disconnect();
  });
  const governed = (verbs: Record<string, object>) =>
    Reflect.apply(Reflect.get(fixture.base, "$extends"), fixture.base, [
      judged(verbs),
    ]) as Loose;
  const subjectOf = async (pin: number) =>
    (
      await (fixture.base as unknown as Loose).pin!.findUnique({
        where: { id: pin },
        include: { subject: true },
      })
    )?.subject as { data: { id: number } } | null | undefined;

  test("a row carrier is a field of the row that holds it: its connect is judged at that field's predicate", async () => {
    const move = (db: Loose) =>
      db.pin!.update({
        where: { id: 1 },
        data: { subject: { connect: { type: "post", where: { id: 10 } } } },
      });
    expect(
      await failure(move(governed({ pin: { writes: { subject: "locked" } } })))
    ).toBeInstanceOf(NotFoundError);
    expect(await subjectOf(1)).toMatchObject({ data: { id: 11 } });
    await move(
      governed({ pin: { update: "locked", writes: { subject: "open" } } })
    );
    expect(await subjectOf(1)).toMatchObject({ data: { id: 10 } });
  });

  test("from the target's side, the carrier's row is judged at its carrier field", async () => {
    const attach = (db: Loose) =>
      db.post!.update({
        where: { id: 13 },
        data: { pins: { connect: { id: 1 } } },
      });
    expect(
      await failure(
        attach(governed({ pin: { writes: { subject: "locked" } } }))
      )
    ).toBeInstanceOf(NestedWriteError);
    expect(await subjectOf(1)).toMatchObject({ data: { id: 11 } });
    await attach(
      governed({ pin: { update: "locked", writes: { subject: "open" } } })
    );
    expect(await subjectOf(1)).toMatchObject({ data: { id: 13 } });
  });

  test("a variant join is written by both rows it links; a target with no inverse is judged at its update verb", async () => {
    const link = (db: Loose) =>
      db.board!.update({
        where: { id: 3 },
        data: { items: { connect: [{ type: "tag", where: { id: 2 } }] } },
      });
    expect(
      await failure(link(governed({ board: { writes: { items: "locked" } } })))
    ).toBeInstanceOf(NotFoundError);
    expect(
      await failure(link(governed({ board: {}, tag: { update: "locked" } })))
    ).toBeInstanceOf(NestedWriteError);
    await link(
      governed({
        board: { update: "locked", writes: { items: "open" } },
        tag: {},
      })
    );
    const items = await (fixture.base as unknown as Loose).board!.findUnique({
      where: { id: 3 },
      include: { items: true },
    });
    expect(items?.items).toHaveLength(2);
  });
});

/**
 * A nested delete takes its target at the target's `delete` verb (plan §5.1):
 * a member the call sees and may not delete is refused, never kept while the
 * call reports success. Both slots: a key the parent holds (`card.crew`),
 * whose member the parent's own key names, and a key the member holds
 * (`holder.badge`), whose member the call names only if it sees it. A
 * to-one `delete` takes only `true`. Every refusal is the sentence a missing
 * target gives (§5.3).
 */
describe("a nested delete judged at the target's delete verb", () => {
  const holder = s.model({
    id: s.string().id(),
    badge: s.toOne(() => badge),
  });
  const badge = s.model({
    id: s.string().id(),
    label: s.string(),
    holderId: s.string().nullable().unique(),
    holder: s
      .toOne(() => holder)
      .fields("holderId")
      .references("id"),
  });
  const card = s.model({
    id: s.string().id(),
    crewId: s.string().nullable(),
    crew: s
      .toOne(() => crew)
      .fields("crewId")
      .references("id"),
  });
  const crew = s.model({
    id: s.string().id(),
    label: s.string(),
    cards: s.toMany(() => card),
  });
  /** Each label once per slot: `open` may be deleted, `locked` is only seen, `hidden` is not seen. */
  const LABELS = ["open", "locked", "hidden"] as const;
  const labelled = {
    predicates: {
      all: {},
      seen: { label: { not: "hidden" } },
      open: { label: "open" },
    },
    read: "seen",
    update: "seen",
    delete: "open",
  };
  const opened = async () => {
    const base = createClient({
      schema: { holder, badge, card, crew },
      driver: createInMemorySQLite3Driver(),
    });
    await syncLiveSchema(base);
    for (const id of [...LABELS, "empty"]) {
      await base.holder.create({ data: { id } });
      await base.card.create({ data: { id } });
    }
    for (const label of LABELS) {
      await base.badge.create({ data: { id: label, label, holderId: label } });
      await base.crew.create({ data: { id: label, label } });
      await base.card.update({
        where: { id: label },
        data: { crewId: label },
      });
    }
    const governed = Reflect.apply(Reflect.get(base, "$extends"), base, [
      {
        name: "verbs",
        rows: {
          control: "as",
          default: "all",
          models: {},
          verbs: {
            holder: {
              predicates: { all: {} },
              read: "all",
              update: "all",
            },
            card: { predicates: { all: {} }, read: "all", update: "all" },
            badge: labelled,
            crew: labelled,
          },
        },
      },
    ]) as Record<string, { update(args: object): Promise<unknown> }>;
    return { base, governed };
  };
  let estate: Awaited<ReturnType<typeof opened>>;
  beforeEach(async () => {
    estate = await opened();
  });
  afterEach(async () => {
    await estate.base.$disconnect();
  });
  const state = async () => ({
    badges: (await estate.base.badge.findMany({ orderBy: { id: "asc" } })).map(
      (row) => `${row.id}:${row.holderId}`
    ),
    cards: (await estate.base.card.findMany({ orderBy: { id: "asc" } })).map(
      (row) => `${row.id}:${row.crewId}`
    ),
    crews: (await estate.base.crew.findMany({ orderBy: { id: "asc" } })).map(
      (row) => row.id
    ),
  });
  /** The refusal's class and sentence. */
  const refusal = async (pending: Promise<unknown>) => {
    const error = (await failure(pending)) as Error;
    return `${error.constructor.name}: ${error.message}`;
  };

  test("the parent's key names the member: one it may not delete, seen or not, is refused alike, and the key is kept", async () => {
    const remove = (id: string) =>
      estate.governed.card!.update({
        where: { id },
        data: { crew: { delete: true } },
      });
    const before = await state();
    const locked = await refusal(remove("locked"));
    expect(locked).toBe(
      "NestedWriteError: Cannot delete relation 'crew': target record was not found for this parent."
    );
    expect(await refusal(remove("hidden"))).toBe(locked);
    expect(await state()).toEqual(before);
    await remove("empty");
    await remove("open");
    expect((await state()).cards).toContain("open:null");
    expect((await state()).crews).toEqual(["hidden", "locked"]);
  });

  test("the member's key: one the call sees and may not delete is refused; one it cannot see is an empty slot", async () => {
    const remove = (id: string) =>
      estate.governed.holder!.update({
        where: { id },
        data: { badge: { delete: true } },
      });
    const before = await state();
    expect(await refusal(remove("locked"))).toBe(
      "NestedWriteError: Cannot delete relation 'badge': target record was not found for this parent."
    );
    expect(await state()).toEqual(before);
    await remove("hidden");
    await remove("empty");
    expect(await state()).toEqual(before);
    await remove("open");
    expect((await state()).badges).toEqual(["hidden:hidden", "locked:locked"]);
  });
});
