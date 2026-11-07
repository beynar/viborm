import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { s } from "@schema";
import { createSurrealTestDriver } from "@tests/fixtures/drivers/surrealdb";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** What a call answers or how it fails, in a form two databases can compare. */
export const caught = async (f: () => Promise<unknown>) => {
  try {
    return { answer: await f() };
  } catch (e: any) {
    return { error: e.constructor.name, code: e.code };
  }
};
export async function compare(
  schema: any,
  scenario: (db: any, fork: () => any) => Promise<unknown>
) {
  const pg = new PGlite();
  const postgres: any = createClient({
    schema,
    driver: new PGliteDriver({ client: pg }),
  });
  const surreal: any = createClient({
    schema,
    driver: createSurrealTestDriver(),
  });
  try {
    await syncLiveSchema(postgres);
    await syncLiveSchema(surreal);
    const forks: any[] = [];
    const expected = await scenario(postgres, () =>
      createClient({ schema, driver: new PGliteDriver({ client: pg }) })
    );
    const actual = await scenario(surreal, () => {
      const db = createClient({ schema, driver: createSurrealTestDriver() });
      forks.push(db);
      return db;
    });
    for (const db of forks) await db.$disconnect();
    // biome-ignore lint/suspicious/noMisplacedAssertion: every test calls this.
    expect(actual).toEqual(expected);
  } finally {
    await surreal.$disconnect();
    await pg.close();
  }
}
export function simple() {
  const user = s.model({
    id: s.string().id(),
    email: s.string().unique(),
    n: s.int().nullable(),
    name: s.string().nullable(),
  });
  return { user };
}
export function family(
  onUpdate: "cascade" | "restrict" | "setNull",
  onDelete: "cascade" | "restrict" | "setNull"
) {
  const parent = s.model({
    id: s.string().id(),
    name: s.string(),
    children: s.toMany(() => child),
  });
  const child = s.model({
    id: s.string().id(),
    parentId: s.string().nullable(),
    parent: s
      .toOne(() => parent)
      .fields("parentId")
      .references("id")
      .onUpdate(onUpdate)
      .onDelete(onDelete),
  });
  return { parent, child };
}
export const rows = (db: any, model = "user") =>
  db[model].findMany({ orderBy: { id: "asc" } });

type Read = readonly [
  title: string,
  model: string,
  verb: string,
  input: object,
];

/** One seed on both databases, and each read must answer alike on them. */
export function reads(
  title: string,
  schema: any,
  seed: (db: any) => Promise<void>,
  cases: readonly Read[]
) {
  describe.skipIf(!process.env.SURREAL_TEST_URL)(title, () => {
    let surreal: any;
    let postgres: any;
    let pg: PGlite;
    beforeAll(async () => {
      surreal = createClient({ schema, driver: createSurrealTestDriver() });
      pg = new PGlite();
      postgres = createClient({
        schema,
        driver: new PGliteDriver({ client: pg }),
      });
      for (const db of [surreal, postgres]) {
        await syncLiveSchema(db);
        await seed(db);
      }
    }, 120_000);
    afterAll(async () => {
      await surreal?.$disconnect();
      await pg?.close();
    });
    it.each(cases)("%s", async (_title, model, verb, input) => {
      const expected = await postgres[model][verb](input);
      expect(await surreal[model][verb](input)).toEqual(expected);
    });
  });
}
