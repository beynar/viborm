/**
 * `viborm/ordering` typing, probed through the public surface: a key field
 * the extension appends is optional on a create (root and nested), `move`
 * and `rekey` take the model's own inputs and `move` returns what an
 * `update` with the same projection returns, and the configuration names
 * the receiving client's models.
 *
 * Nothing in this file is called. Only the types matter.
 */

import { defaultOmit } from "@src/client/exports";
import { PGliteDriver } from "@src/drivers/pglite";
import { createClient, s } from "@src/index";
import { keyBetween, ordering, orderingKey } from "@src/ordering";
import { expectTypeOf } from "vitest";

const column = s.model({
  id: s.string().id(),
  cards: s.toMany(() => card),
});
const card = s.model({
  id: s.string().id(),
  columnId: s.string(),
  rank: s.string().schema(orderingKey),
  title: s.string(),
  column: s
    .toOne(() => column)
    .fields("columnId")
    .references("id"),
});
const schema = { column, card };

const base = createClient({ schema, driver: new PGliteDriver() });
const db = ordering({ card: { key: "rank", within: ["columnId"] } })(base);

export async function probes() {
  // The key is optional on a create: the extension appends it.
  await db.card.create({ data: { id: "a", columnId: "c1", title: "a" } });
  await db.card.createMany({ data: [{ id: "b", columnId: "c1", title: "b" }] });
  await db.column.create({
    data: { id: "c", cards: { create: [{ id: "d", title: "d" }] } },
  });
  // It may still be written.
  await db.card.create({
    data: { id: "e", columnId: "c1", title: "e", rank: "10" },
  });
  // Without the extension it is required.
  // @ts-expect-error rank is required on the base client
  await base.card.create({ data: { id: "f", columnId: "c1", title: "f" } });

  const moved = await db.card.move({ where: { id: "a" }, after: { id: "b" } });
  expectTypeOf(moved.rank).toEqualTypeOf<string>();
  expectTypeOf(moved.title).toEqualTypeOf<string>();
  const picked = await db.card.move({
    where: { id: "a" },
    first: true,
    select: { title: true },
  });
  expectTypeOf(picked).toEqualTypeOf<{ title: string }>();
  await db.card.move({ where: { id: "a" }, to: { columnId: "c2" } });
  // A later rows step: move's to-one relation to a model those rows can
  // hide reads `| null`, as the client's own update does; defaultOmit may
  // follow too.
  const governed = db.$extends({
    name: "test.tenancy",
    rows: {
      control: "tenant",
      default: "own",
      models: {
        column: { own: { root: { id: "c1" }, related: { id: "c1" } } },
      },
    },
  });
  const included = await governed.card.move({
    where: { id: "a" },
    first: true,
    include: { column: true },
  });
  expectTypeOf(included.column).toEqualTypeOf<{ id: string } | null>();
  const omitted = db.$extends(
    defaultOmit<typeof schema>()({ card: { title: true } })
  );
  const bare = await omitted.card.move({ where: { id: "a" }, first: true });
  // @ts-expect-error title is omitted by the later defaultOmit
  bare.title;
  // A list field omitted before ordering is applied is still named by `to`:
  // destinations are inputs, not presented rows.
  const omittedFirst = ordering({
    card: { key: "rank", within: ["columnId"] },
  })(base.$extends(defaultOmit<typeof schema>()({ card: { columnId: true } })));
  await omittedFirst.card.move({ where: { id: "a" }, to: { columnId: "c2" } });
  // `to` names the list by its fields, with their types.
  // @ts-expect-error not a list field
  await db.card.move({ where: { id: "a" }, to: { column: "c2" } });
  // @ts-expect-error columnId is a string
  await db.card.move({ where: { id: "a" }, to: { columnId: 5 } });
  // A key the caller computed, in its list or another.
  await db.card.move({ where: { id: "a" }, key: keyBetween(null, null) });
  await db.card.move({
    where: { id: "a" },
    key: keyBetween(null, null),
    to: { columnId: "c2" },
  });
  // @ts-expect-error a key is a placement of its own
  await db.card.move({ where: { id: "a" }, key: "15", after: { id: "b" } });
  // One placement.
  // @ts-expect-error after and before together
  await db.card.move({
    where: { id: "a" },
    after: { id: "b" },
    before: { id: "c" },
  });
  // @ts-expect-error an anchor and first together
  await db.card.move({ where: { id: "a" }, after: { id: "b" }, first: true });
  // @ts-expect-error to goes with first or last, not an anchor
  await db.card.move({
    where: { id: "a" },
    after: { id: "b" },
    to: { columnId: "c2" },
  });
  await db.card.move({
    where: { id: "a" },
    last: true,
    to: { columnId: "c2" },
  });
  // @ts-expect-error the moved row is named by a unique input
  await db.card.move({ where: { nope: "a" }, first: true });
  // @ts-expect-error the anchor is named by a unique input
  await db.card.move({ where: { id: "a" }, before: { title: "b" } });

  const { count } = await db.card.rekey({ where: { columnId: "c1" } });
  expectTypeOf(count).toEqualTypeOf<number>();
  await db.card.rekey({ orderBy: { title: "asc" } });
  await db.card.rekey({ orderBy: [{ title: "desc" }, { id: "asc" }] });
  // @ts-expect-error rekey orders by the model's scalar fields
  await db.card.rekey({ orderBy: { column: "asc" } });
  // @ts-expect-error rekey's where is the model's
  await db.card.rekey({ where: { nope: 1 } });

  // A model the extension does not order has no move.
  // @ts-expect-error column is not ordered
  db.column.move;

  // @ts-expect-error the configuration names the client's models
  ordering({ nope: { key: "rank" } })(base);
}
