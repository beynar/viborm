/**
 * `named` on clients without named statements (PGlite, SQLite): accepted and
 * without effect, so code written for pg runs here unchanged. Each call
 * answers what it answers without the option, and sends the same statements.
 */
import { createClient as createPGliteClient } from "@drivers/pglite";
import { createClient as createSQLite3Client } from "@drivers/sqlite3";
import { s } from "@schema";
import { extension, parameters, text, unit } from "@src/index";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { expect, test } from "vitest";

const owner = s.model({
  id: s.string().id(),
  name: s.string(),
  pets: s.toMany(() => pet),
});
const pet = s.model({
  id: s.string().id(),
  name: s.string(),
  ownerId: s.string(),
  owner: s
    .toOne(() => owner)
    .fields("ownerId")
    .references("id"),
});
const schema = { owner, pet };

/** Each statement's text and values, as the driver is handed them. */
const recorder = (sent: string[]) =>
  extension(
    "recorder",
    unit(
      (u, next) => {
        sent.push(JSON.stringify([text(u), parameters(u)]));
        return next();
      },
      ["statement"]
    )
  );

const pglite = () => createPGliteClient({ schema });
type Db = ReturnType<typeof pglite>;

const work = async (db: Db, named: boolean | undefined) => [
  await db.owner.create({
    data: {
      id: "o1",
      name: "one",
      pets: { create: [{ id: "p1", name: "a" }] },
    },
    include: { pets: true },
    named,
  }),
  await db.owner.findMany({ include: { pets: true }, named }),
  await db.$transaction([
    db.owner.findUnique({ where: { id: "o1" }, named }),
    db.pet.count({ named }),
  ]),
  await db.$transaction((tx) =>
    tx.owner.update({ where: { id: "o1" }, data: { name: "uno" }, named })
  ),
  await db.pet.deleteMany({ named }),
  await db.owner.delete({ where: { id: "o1" }, named }),
];

for (const [label, make] of [
  ["PGlite", pglite],
  ["SQLite", () => createSQLite3Client({ schema })],
] as const) {
  test(`${label}: named is accepted and changes nothing`, async () => {
    const answers: unknown[] = [];
    const statements: string[][] = [];
    const base = make();
    await syncLiveSchema(base);
    // Each run ends with the tables as it found them: empty.
    for (const named of [undefined, true, false]) {
      const sent: string[] = [];
      answers.push(await work(base.$extends(recorder(sent)), named));
      statements.push(sent);
    }
    await base.$disconnect();
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
    expect(statements[0]?.length).toBeGreaterThan(0);
    expect(statements[1]).toEqual(statements[0]);
    expect(statements[2]).toEqual(statements[0]);
  });
}
