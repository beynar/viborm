import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { SQLite3Driver } from "@drivers/sqlite3";
import { PGlite } from "@electric-sql/pglite";
import { s } from "@schema";
import { syncLiveSchema as push } from "@tests/fixtures/sync-schema";
import { describe, expect, test } from "vitest";

/**
 * A row whose key is an instant is one row, whether a call names it by a
 * `Date`, by the text of that instant, or reads it back from the database.
 */
const schema = (() => {
  const stamp = s
    .model({
      at: s.dateTime().id(),
      note: s.string(),
      marks: s.toMany(() => mark),
    })
    .map("ikr_stamps");
  const mark = s
    .model({
      id: s.string().id(),
      label: s.string(),
      stampAt: s.dateTime().nullable(),
      stamp: s
        .toOne(() => stamp)
        .fields("stampAt")
        .references("at"),
    })
    .map("ikr_marks");
  return { stamp, mark };
})();

const AT = "2026-01-02T03:04:05.000Z";
const OTHER = "2027-01-02T03:04:05.000Z";

const drivers = {
  SQLite: () => new SQLite3Driver({ dataDir: ":memory:" }),
  PGlite: () => new PGliteDriver({ client: new PGlite() }),
};

for (const [name, makeDriver] of Object.entries(drivers))
  describe(`a row keyed by an instant (${name})`, () => {
    const seeded = async () => {
      const client = createClient({ schema, driver: makeDriver() });
      await push(client, { force: true });
      await client.stamp.create({
        data: {
          at: AT,
          note: "first",
          marks: { create: [{ id: "m1", label: "a" }] },
        },
      });
      await client.stamp.create({ data: { at: OTHER, note: "other" } });
      await client.mark.create({ data: { id: "m2", label: "b" } });
      return client;
    };
    const keys: [string, unknown][] = [
      ["a Date", new Date(AT)],
      ["its text", AT],
      ["its text without milliseconds", "2026-01-02T03:04:05Z"],
    ];
    for (const [label, at] of keys) {
      test(`named by ${label}: its members are written under it`, async () => {
        const client = await seeded();
        try {
          const row = await client.stamp.update({
            where: { at: at as string },
            data: {
              note: "second",
              marks: {
                update: { where: { id: "m1" }, data: { label: "A" } },
                connect: { id: "m2" },
              },
            },
            include: { marks: { orderBy: { id: "asc" } } },
          });
          expect(row.note).toBe("second");
          expect(
            row.marks.map((mark: { id: string; label: string }) => [
              mark.id,
              mark.label,
            ])
          ).toEqual([
            ["m1", "A"],
            ["m2", "b"],
          ]);
        } finally {
          await client.$disconnect();
        }
      });

      test(`named by ${label} from its member: updated once, and moved`, async () => {
        const client = await seeded();
        try {
          await client.mark.update({
            where: { id: "m1" },
            data: {
              stamp: {
                update: { where: { at: at as string }, data: { note: "seen" } },
              },
            },
          });
          expect(
            (await client.stamp.findUnique({ where: { at: AT } }))?.note
          ).toBe("seen");
          // The member leaves for another row, named the other way round.
          await client.stamp.update({
            where: { at: at as string },
            data: { marks: { disconnect: { id: "m1" } } },
          });
          await client.mark.update({
            where: { id: "m1" },
            data: { stamp: { connect: { at: new Date(OTHER) } } },
          });
          const moved = await client.stamp.findUnique({
            where: { at: OTHER },
            include: { marks: true },
          });
          expect(moved?.marks.map((mark: { id: string }) => mark.id)).toEqual([
            "m1",
          ]);
        } finally {
          await client.$disconnect();
        }
      });
    }
  });
