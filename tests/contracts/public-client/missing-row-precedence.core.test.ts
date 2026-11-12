/**
 * Where the row a call updates and a row its nested write names are both
 * missing, the call's own row is the one said so: `NotFoundError`, as an
 * update of a missing row always answers. A nested write's own refusal
 * (`NestedWriteError`) is for a row that is there.
 */

import { createClient, NestedWriteError, NotFoundError, s } from "@src/index";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { expect, test } from "vitest";

const schema = (() => {
  const group = s.model({
    id: s.string().id(),
    pages: s.toMany(() => page),
  });
  const tag = s.model({
    id: s.string().id(),
    pages: s.toMany(() => page),
  });
  const page = s.model({
    id: s.string().id(),
    title: s.string().nullable(),
    groupId: s.string().nullable(),
    group: s
      .toOne(() => group)
      .fields("groupId")
      .references("id"),
    tags: s.toMany(() => tag),
  });
  return { group, tag, page };
})();

const refusal = (run: Promise<unknown>) =>
  run.then(
    () => undefined,
    (error: unknown) => error
  );

test("a missing row is said missing before a missing row its nested write names", async () => {
  const db = createClient({ schema, driver: createInMemorySQLite3Driver() });
  await syncLiveSchema(db);

  // The row holds the key of the row it would connect.
  const held = () =>
    db.page.update({
      where: { id: "p1" },
      data: { group: { connect: { id: "absent" } } },
    });
  // A link holds both, and the row writes a field of its own beside it.
  const linked = () =>
    db.page.update({
      where: { id: "p1" },
      data: { title: "written", tags: { connect: { id: "absent" } } },
    });

  expect(await refusal(held())).toBeInstanceOf(NotFoundError);
  expect(await refusal(linked())).toBeInstanceOf(NotFoundError);

  await db.page.create({ data: { id: "p1" } });
  expect(await refusal(held())).toBeInstanceOf(NestedWriteError);
  expect(await refusal(linked())).toBeInstanceOf(NestedWriteError);
  // A unit a nested write refuses writes nothing of the row.
  expect(await db.page.findUnique({ where: { id: "p1" } })).toEqual({
    id: "p1",
    title: null,
    groupId: null,
  });
});
