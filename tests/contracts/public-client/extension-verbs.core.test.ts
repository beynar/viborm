/**
 * Verbs on polymorphic relations (plan K3, R3 as amended in §11.2): a row
 * carrier is written by the row that holds it, a variant join by both rows it
 * links, through the same per-model `verbs` a plain relation takes. A model
 * whose join to the carrier declares no inverse is judged at its `update`
 * verb. The plain relations are witnessed against the RBAC oracle on four
 * databases (tests/contracts/public-client/rbac-app-verbs.ts).
 *
 * Fixture: `openRowScopeFixture` (row-scope-behavior.ts). Pin 1 is on post
 * 11; board 3 holds post 10.
 */

import { NestedWriteError, NotFoundError } from "@errors";
import {
  openRowScopeFixture,
  type RowScopeFixture,
} from "@tests/contracts/engine/query/row-scope-behavior";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { failure } from "@tests/fixtures/failure";
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
