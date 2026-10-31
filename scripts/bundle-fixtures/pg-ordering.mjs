// Fixture (n) — pg-representative with `viborm/ordering` applied: its
// difference from (c) is what ordering a list costs an application.

import { ordering } from "../../dist/ordering.mjs";
import { createClient } from "../../dist/pg.mjs";
import { s } from "../../dist/schema.mjs";

const column = s.model({
  id: s.string().id(),
  cards: s.toMany(() => card),
});

const card = s.model({
  id: s.string().id(),
  title: s.string(),
  rank: s.string(),
  columnId: s.string(),
  column: s
    .toOne(() => column)
    .fields("columnId")
    .references("id"),
});

export const client = ordering({ card: { key: "rank", within: ["columnId"] } })(
  createClient({
    schema: { column, card },
    databaseUrl: "postgres://localhost:5432/app",
  })
);

export async function run() {
  const columns = await client.column.findMany({ include: { cards: true } });
  const created = await client.card.create({
    data: { title: "hello", columnId: columns[0].id },
  });
  return client.card.move({ where: { id: created.id }, first: true });
}
