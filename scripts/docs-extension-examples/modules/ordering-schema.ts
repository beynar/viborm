/** The schema the ordering page's blocks read. */
import { ordering, orderingKey } from "viborm/ordering";
import { createClient } from "viborm/pglite";
import { s } from "viborm/schema";

export const column = s.model({
  id: s.string().id().ulid(),
  title: s.string(),
  cards: s.toMany(() => card),
});
export const card = s
  .model({
    id: s.string().id().ulid(),
    columnId: s.string(),
    rank: s.string().schema(orderingKey),
    title: s.string(),
    createdAt: s.dateTime().nullable(),
    column: s
      .toOne(() => column)
      .fields("columnId")
      .references("id"),
  })
  .index(["columnId", "rank", "id"]);
export const base = createClient({ schema: { card, column } });
export const db = base.$extends(
  ordering({ models: { card: { key: "rank", within: ["columnId"] } } })
);
