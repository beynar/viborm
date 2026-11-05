/**
 * What the SurrealDB write scripts share: one schema, its hand-written SurrealQL
 * tables, and the comparison. Each step of a script runs on SurrealDB and on PGlite
 * in order, and every answer, every refusal and the rows left behind must match.
 * Gated on SURREAL_TEST_URL.
 */

import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { SurrealDriver } from "@drivers/surrealdb";
import { PGlite } from "@electric-sql/pglite";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { Surreal } from "surrealdb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.SURREAL_TEST_URL;

const user = s.model({
  id: s.string().id(),
  email: s.string().unique(),
  name: s.string().nullable(),
  age: s.int().nullable(),
  score: s.int().default(0),
  active: s.boolean().default(true),
  seen: s.dateTime().nullable(),
  posts: s.toMany(() => post).name("wrote"),
  reviews: s.toMany(() => post).name("reviewed"),
});
const post = s.model({
  id: s.int().id(),
  title: s.string(),
  rank: s.int(),
  authorId: s.string(),
  author: s
    .toOne(() => user)
    .name("wrote")
    .fields("authorId")
    .references("id")
    .onDelete("restrict"),
  reviewerId: s.string().nullable(),
  reviewer: s
    .toOne(() => user)
    .name("reviewed")
    .fields("reviewerId")
    .references("id")
    .onDelete("setNull"),
  comments: s.toMany(() => comment),
});
const comment = s.model({
  id: s.int().id(),
  body: s.string(),
  postId: s.int(),
  post: s
    .toOne(() => post)
    .fields("postId")
    .references("id")
    .onDelete("cascade"),
});
const schema = { user, post, comment };

// biome-ignore lint/suspicious/noExplicitAny: each step names its model and verb.
export type Client = any;
export type Step = readonly [string, (db: Client) => Promise<unknown>];

const outcome = async (run: () => Promise<unknown>) => {
  try {
    return { answer: await run() };
  } catch (error) {
    return {
      refused: (error as Error).constructor.name,
      code: (error as { code?: string }).code,
    };
  }
};

export function describeWrites(
  title: string,
  steps: readonly Step[],
  refusals: (client: () => Client) => void
): void {
  describe.skipIf(!url)(title, () => {
    let surreal: Surreal;
    let pglite: PGlite;
    let onSurreal: Client;
    let onPostgres: Client;

    beforeAll(async () => {
      surreal = new Surreal();
      const database = `write_${Date.now()}`;
      await surreal.connect(url!, {
        authentication: { username: "root", password: "root" },
      });
      await surreal.query(
        `DEFINE NAMESPACE IF NOT EXISTS viborm; USE NS viborm; DEFINE DATABASE ${database};`
      );
      await surreal.use({ namespace: "viborm", database });
      await surreal.query(`
      DEFINE TABLE user SCHEMAFULL; DEFINE FIELD email ON user TYPE string; DEFINE FIELD name ON user TYPE option<string>; DEFINE FIELD age ON user TYPE option<int>; DEFINE FIELD score ON user TYPE int; DEFINE FIELD active ON user TYPE bool; DEFINE FIELD seen ON user TYPE option<datetime>;
      DEFINE INDEX user_email ON user FIELDS email UNIQUE;
      DEFINE TABLE post SCHEMAFULL; DEFINE FIELD title ON post TYPE string; DEFINE FIELD rank ON post TYPE int;
      DEFINE FIELD authorId ON post TYPE record<user> REFERENCE ON DELETE REJECT ASSERT $value.exists();
      DEFINE FIELD reviewerId ON post TYPE option<record<user>> REFERENCE ON DELETE UNSET ASSERT $value = NONE OR $value.exists();
      DEFINE INDEX post_author ON post FIELDS authorId; DEFINE INDEX post_reviewer ON post FIELDS reviewerId;
      DEFINE TABLE comment SCHEMAFULL; DEFINE FIELD body ON comment TYPE string;
      DEFINE FIELD postId ON comment TYPE record<post> REFERENCE ON DELETE CASCADE ASSERT $value.exists();
      DEFINE INDEX comment_post ON comment FIELDS postId;
    `);
      onSurreal = createClient({ schema, driver: new SurrealDriver(surreal) });
      pglite = new PGlite();
      onPostgres = createClient({
        schema,
        driver: new PGliteDriver({ client: pglite }),
      });
      await syncLiveSchema(onPostgres);
    }, 120_000);

    afterAll(async () => {
      await surreal?.close();
      await pglite?.close();
    });

    it.each(steps)("%s", async (_, step) => {
      const expected = await outcome(() => step(onPostgres));
      const answered = await outcome(() => step(onSurreal));
      expect(answered).toEqual(expected);
    });

    it("leaves the same rows", async () => {
      for (const [model, order] of [
        ["user", { id: "asc" }],
        ["post", { id: "asc" }],
        ["comment", { id: "asc" }],
      ] as const) {
        const expected = await onPostgres[model].findMany({ orderBy: order });
        expect(await onSurreal[model].findMany({ orderBy: order })).toEqual(
          expected
        );
      }
    });

    refusals(() => onSurreal);
  });
}
