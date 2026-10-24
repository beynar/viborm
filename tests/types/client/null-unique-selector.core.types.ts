import { createClient } from "@drivers/pglite";
import { s } from "@src/index";

// A unique selector cannot be `null` (1.4.1): a unique index holds any number
// of NULLs. Runtime refuses it in every unique position; so do the types.
const box = s
  .model({
    id: s.int().id(),
    code: s.string().nullable().unique(),
    a: s.int(),
    b: s.string().nullable(),
    notes: s.toMany(() => note),
  })
  .unique(["a", "b"]);
const note = s.model({
  id: s.int().id(),
  boxId: s.int().nullable(),
  box: s.toOne(() => box).fields("boxId").references("id"),
});
const client = createClient({ schema: { box, note } });

export async function nullUniqueSelectors() {
  await client.box.findUnique({ where: { code: "c" } });
  await client.box.findUnique({ where: { a_b: { a: 1, b: "x" } } });
  // @ts-expect-error a nullable unique spelled null names no row
  await client.box.findUnique({ where: { code: null } });
  // @ts-expect-error nor does a compound member spelled null
  await client.box.delete({ where: { a_b: { a: 1, b: null } } });
  // @ts-expect-error nor a null beside a selector that names the row
  await client.box.update({ where: { id: 1, code: null }, data: {} });
  // @ts-expect-error a cursor is a unique selector too
  await client.box.findMany({ cursor: { code: null } });
  await client.note.update({
    where: { id: 1 },
    // @ts-expect-error a nested connect target too
    data: { box: { connect: { code: null } } },
  });
}
