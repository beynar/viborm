/**
 * G4-02 closure repair — a unique `where`'s DISCRIMINATOR is the constraint's
 * question, not the text contract's.
 *
 * `Queries.prepareSelector(model, where, unique)` marks the top-level
 * addressable-key entries of an admitted unique selector as key-addressed, and
 * `lowerOperation` compares a key-addressed column with the dialect's plain
 * equality. Everything else — a filter `where` that happens to name a key, an
 * extended unique `where`'s filter half, its `AND`/`OR`/`NOT` arms — keeps the
 * case-sensitive spelling.
 *
 * This is the shipped split, not a new one: `buildWhereUnique`
 * (`src/query-engine/builders/where-unique-builder.ts:63-73`) compiles the
 * discriminator with `buildUniqueEquality` (`:213`, a bare `operators.eq`) and
 * hands only the remainder to `buildWhere`, whose text equality is
 * `operators.exactTextEq`. Asking the stricter question of a key is not merely
 * a different spelling: on a case-insensitive collation the probe can report a
 * key free and the very next INSERT be rejected for duplicating it, which is
 * what the live MySQL cells below measure.
 *
 * The native rows run only with `VIBORM_RAPTOR3_PROVIDER=mysql`; the container
 * and port of a run are recorded in the receipt beside this file.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@client/client";
import type { QueryExecutionContext, QueryResult } from "@drivers";
import { MySQL2Driver } from "@drivers/mysql2";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import type { Pool as MySQLPool, PoolConnection } from "mysql2/promise";
import { afterAll, beforeAll, describe, it } from "vitest";
import { RecordingSQLiteDriver } from "./world";

const provider = process.env.VIBORM_RAPTOR3_PROVIDER;
const port = Number(process.env.VIBORM_RAPTOR3_PROVIDER_PORT ?? "0");

const owner = s
  .model({
    id: s.string().id(),
    email: s.string().unique(),
    name: s.string(),
    notes: s.toMany(() => note),
  })
  .map("g4u2_disc_owners");
const note = s
  .model({
    id: s.string().id(),
    title: s.string(),
    ownerId: s.string(),
    owner: s
      .toOne(() => owner)
      .fields("ownerId")
      .references("id"),
  })
  .map("g4u2_disc_notes");
const schema = { owner, note };

async function sqliteWorld() {
  const database = new Database(":memory:");
  const driver = new RecordingSQLiteDriver({ client: database });
  const client = createClient({ schema, driver });
  const migration = await syncLiveSchema(client);
  if (!migration.applied) throw new Error("discriminator world did not apply");
  await client.owner.create({
    data: { id: "wanted", email: "claim@x", name: "winner" },
  });
  driver.reset();
  return {
    driver,
    client,
    engine: createCommandEngine({ schema, driver }),
    async close() {
      await client.$disconnect();
      database.close();
    },
  };
}

const KEY_COMPARISON = /"id"(\s+COLLATE\s+BINARY)?\s*=/gi;
const FILTER_SPELLING = /"name"\s+COLLATE\s+BINARY/i;
const CASE_INSENSITIVE_COLLATION = /_ci$/;

/** The one comparison this file reads: how `<column> =` is spelled for `id`. */
function keyComparisons(sql: string): string[] {
  return [...sql.matchAll(KEY_COMPARISON)].map((match) =>
    match[1] ? "exact" : "constraint"
  );
}

describe("G4-02 unique discriminator", () => {
  it("spells the discriminator with the constraint's equality and the filter half with the text contract", async () => {
    const world = await sqliteWorld();
    try {
      const spelling = async (run: () => PromiseLike<unknown>) => {
        world.driver.reset();
        await run();
        const probe = world.driver.statements[0]!;
        return { sql: probe.sql, key: keyComparisons(probe.sql) };
      };
      // findUnique: the whole `where` is the discriminator.
      const shippedUnique = await spelling(() =>
        world.client.owner.findUnique({ where: { id: "wanted" } })
      );
      const candidateUnique = await spelling(() =>
        world.engine.execute("owner", "findUnique", { where: { id: "wanted" } })
      );
      assert.deepEqual(shippedUnique.key, ["constraint"]);
      assert.deepEqual(
        candidateUnique.key,
        shippedUnique.key,
        "findUnique addresses the row through the constraint, as the shipped engine does"
      );
      // findFirst: the same object is a filter, and keeps the text contract.
      const shippedFirst = await spelling(() =>
        world.client.owner.findFirst({ where: { id: "wanted" } })
      );
      const candidateFirst = await spelling(() =>
        world.engine.execute("owner", "findFirst", { where: { id: "wanted" } })
      );
      assert.deepEqual(shippedFirst.key, ["exact"]);
      assert.deepEqual(
        candidateFirst.key,
        shippedFirst.key,
        "a filter that names a key is still a filter"
      );
      // The write-side conditional probe is a unique selector too.
      const candidateProbe = await spelling(() =>
        world.engine.execute("note", "create", {
          data: {
            id: `n-${randomUUID().slice(0, 8)}`,
            title: "T",
            owner: {
              connectOrCreate: {
                where: { id: "wanted" },
                create: { id: "wanted", email: "other@x", name: "loser" },
              },
            },
          },
        })
      );
      assert.deepEqual(
        candidateProbe.key,
        ["constraint"],
        "the connectOrCreate probe asks the index the INSERT will meet"
      );
      // An extended unique `where`: discriminator through the constraint, the
      // filter half through the text contract, in one statement.
      const candidateExtended = await spelling(() =>
        world.engine.execute("owner", "findUnique", {
          where: { id: "wanted", name: { not: "zz" } },
        })
      );
      assert.deepEqual(candidateExtended.key, ["constraint"]);
      assert.match(
        candidateExtended.sql,
        FILTER_SPELLING,
        "the extended filter half keeps the case-sensitive spelling"
      );
    } finally {
      await world.close();
    }
  });
});

class RecordingMySQLDriver extends MySQL2Driver {
  readonly seen: { sql: string; params: unknown[] }[] = [];
  protected override async execute<T>(
    client: MySQLPool | PoolConnection,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.seen.push({ sql, params: [...params] });
    return super.execute<T>(client, sql, params, context);
  }
}

describe.runIf(provider === "mysql" && port > 0)(
  "G4-02 native MySQL unique discriminator",
  () => {
    it("answers a collation-equal key exactly as the shipped engine does", async () => {
      const owners = `g4u2_disc_o_${randomUUID().replaceAll("-", "")}`;
      const notes = `g4u2_disc_n_${randomUUID().replaceAll("-", "")}`;
      const liveOwner = s
        .model({
          id: s.string().id(),
          email: s.string().unique(),
          name: s.string(),
          notes: s.toMany(() => liveNote),
        })
        .map(owners);
      const liveNote = s
        .model({
          id: s.string().id(),
          title: s.string(),
          ownerId: s.string(),
          owner: s
            .toOne(() => liveOwner)
            .fields("ownerId")
            .references("id"),
        })
        .map(notes);
      const live = { owner: liveOwner, note: liveNote };
      const connect = () =>
        new RecordingMySQLDriver({
          options: {
            host: "127.0.0.1",
            port,
            database: "raptor3_g2",
            user: "root",
            password: "",
            connectionLimit: 2,
            connectTimeout: 10_000,
          },
        });
      const setup = connect();
      await setup._executeRaw(
        `CREATE TABLE ${owners} (id VARCHAR(191) PRIMARY KEY NOT NULL, email VARCHAR(191) NOT NULL UNIQUE, name VARCHAR(191) NOT NULL)`
      );
      await setup._executeRaw(
        `CREATE TABLE ${notes} (id VARCHAR(191) PRIMARY KEY NOT NULL, title VARCHAR(191) NOT NULL, ownerId VARCHAR(191) NOT NULL, FOREIGN KEY(ownerId) REFERENCES ${owners}(id))`
      );
      try {
        const collation = await setup._executeRaw<{
          TABLE_COLLATION: string;
        }>(
          `SELECT TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_NAME = '${owners}'`
        );
        assert.match(
          collation.rows[0]!.TABLE_COLLATION,
          CASE_INSENSITIVE_COLLATION,
          "the cell needs a case-insensitive collation to be a cell at all"
        );
        await setup._executeRaw(
          `INSERT INTO ${owners} (id, email, name) VALUES ('wanted','claim@x','winner')`
        );
        const answer = async (
          run: (driver: RecordingMySQLDriver) => PromiseLike<unknown>
        ) => {
          const driver = connect();
          try {
            return { ok: await run(driver) };
          } catch (error) {
            return { err: `${(error as Error).name}` };
          } finally {
            await driver.disconnect();
          }
        };
        const rows: [
          string,
          (driver: RecordingMySQLDriver) => PromiseLike<unknown>,
          (driver: RecordingMySQLDriver) => PromiseLike<unknown>,
        ][] = [
          [
            "findUnique on a collation-equal key",
            (driver) =>
              createClient({ schema: live, driver }).owner.findUnique({
                where: { id: "WANTED" },
              }),
            (driver) =>
              createCommandEngine({ schema: live, driver }).execute(
                "owner",
                "findUnique",
                { where: { id: "WANTED" } }
              ),
          ],
          [
            "findUnique on a collation-equal unique field",
            (driver) =>
              createClient({ schema: live, driver }).owner.findUnique({
                where: { email: "CLAIM@X" },
              }),
            (driver) =>
              createCommandEngine({ schema: live, driver }).execute(
                "owner",
                "findUnique",
                { where: { email: "CLAIM@X" } }
              ),
          ],
          [
            "findFirst on a collation-equal key stays a filter",
            (driver) =>
              createClient({ schema: live, driver }).owner.findFirst({
                where: { id: "WANTED" },
              }),
            (driver) =>
              createCommandEngine({ schema: live, driver }).execute(
                "owner",
                "findFirst",
                { where: { id: "WANTED" } }
              ),
          ],
          [
            "update by a collation-equal key",
            (driver) =>
              createClient({ schema: live, driver }).owner.update({
                where: { id: "WANTED" },
                data: { name: "winner" },
              }),
            (driver) =>
              createCommandEngine({ schema: live, driver }).execute(
                "owner",
                "update",
                { where: { id: "WANTED" }, data: { name: "winner" } }
              ),
          ],
        ];
        for (const [name, shipped, candidate] of rows) {
          const expected = await answer(shipped);
          const measured = await answer(candidate);
          assert.deepEqual(measured, expected, name);
        }
        // The conditional probe and the constraint must agree: a probe that
        // reports the key free is followed by an INSERT the index rejects.
        const probe = async (
          run: (driver: RecordingMySQLDriver) => PromiseLike<unknown>
        ) => {
          const result = await answer(run);
          const after = await setup._executeRaw<{ id: string }>(
            `SELECT id FROM ${owners} ORDER BY id`
          );
          return {
            ...("err" in result ? { err: result.err } : { ok: true }),
            owners: after.rows.map((row) => row.id),
          };
        };
        const shippedProbe = await probe((driver) =>
          createClient({ schema: live, driver }).note.create({
            data: {
              id: `s-${randomUUID().slice(0, 8)}`,
              title: "T",
              owner: {
                connectOrCreate: {
                  where: { id: "WANTED" },
                  create: {
                    id: "WANTED",
                    email: `s${randomUUID().slice(0, 8)}@x`,
                    name: "loser",
                  },
                },
              },
            },
          })
        );
        const candidateProbe = await probe((driver) =>
          createCommandEngine({ schema: live, driver }).execute(
            "note",
            "create",
            {
              data: {
                id: `c-${randomUUID().slice(0, 8)}`,
                title: "T",
                owner: {
                  connectOrCreate: {
                    where: { id: "WANTED" },
                    create: {
                      id: "WANTED",
                      email: `c${randomUUID().slice(0, 8)}@x`,
                      name: "loser",
                    },
                  },
                },
              },
            }
          )
        );
        assert.deepEqual(
          shippedProbe,
          { ok: true, owners: ["wanted"] },
          "the shipped probe connects and writes no second owner"
        );
        assert.deepEqual(
          candidateProbe,
          shippedProbe,
          "connectOrCreate on a collation-equal key connects instead of losing the INSERT"
        );
      } finally {
        await setup._executeRaw(`DROP TABLE ${notes}`);
        await setup._executeRaw(`DROP TABLE ${owners}`);
        await setup.disconnect();
      }
    }, 60_000);
  }
);

/**
 * The SCOPE of the rule, per call site — the reviewer's differential cells
 * (round-5 review, finding 1), measured here as the unit's own.
 *
 * A unique selector has two shipped spellings, not one, and which one a call
 * site gets is the shipped engine's classification, not a property of the
 * object:
 *
 * - `buildWhereUnique` (`builders/where-unique-builder.ts:63-73`) compiles the
 *   discriminator through the constraint. That is the root verbs' lookups
 *   (`findUnique` / `update` / `delete` / the `upsert` locator), the
 *   `connect` / `connectOrCreate` probe, the `set` target and the nested
 *   `upsert` probe (`RelationUpsertPart.decide` compiles it with
 *   `buildFindUnique`);
 * - `uniqueSelectorConjuncts` (`write-engine/shared.ts:671`) recombines the
 *   selector as `{ field: { equals: value } }` and hands it to `buildWhere`,
 *   whose text equality is the folded `exactTextEq` pair on MySQL. That is the
 *   nested `disconnect` / `delete` / `update` targets **of a reference-held
 *   relation**, for BOTH their planning probe and their batch guard
 *   (`RelationWritePart.ts:987` `optionalWhereFilters`,
 *   `UpdateOperation.ts:469`, `RecordUpdateCompiler.ts:3722`).
 *
 * The classification is therefore per verb AND per EDGE KIND: a JUNCTION
 * target never reaches `uniqueSelectorConjuncts` at all, because
 * `nested-target-parts.ts:226` sends `relation.position === "junction"` to
 * `RelationJunctionPart`, which spells the target selector as a discriminator
 * in both phases — `buildFindUnique` for the planning probe (`:1509`, `:1629`,
 * `:1663`) and `whereUnique` for the batch statement (`:1698`, `:2146`,
 * `:2259`, compiled by `JunctionStatements.ts:322-323` with
 * `buildWhereUnique`). The candidate states that once, in
 * `commands/selection.ts` `nestedTargetAddressesConstraint`.
 *
 * Marking the reference-held group key-addressed would delete, disconnect and
 * update child rows the shipped engine refuses to touch on a case-insensitive
 * collation; leaving the junction group a filter refuses links and targets the
 * shipped engine does touch. Both directions are measured below as the answer
 * AND the rows the provider holds.
 */
const SCOPE_OWNERS = "g4u2_scope_owners";
const SCOPE_NOTES = "g4u2_scope_notes";
const SCOPE_PAIRS = "g4u2_scope_pairs";
const SCOPE_TAGS = "g4u2_scope_tags";
const SCOPE_LINKS = "g4u2_scope_links";

const scopeOwner = s
  .model({
    id: s.string().id(),
    email: s.string().unique(),
    name: s.string(),
    notes: s.toMany(() => scopeNote),
    tags: s
      .toMany(() => scopeTag)
      .through(SCOPE_LINKS)
      .source("ownerId")
      .target("tagId"),
  })
  .map(SCOPE_OWNERS);
const scopeNote = s
  .model({
    id: s.string().id(),
    title: s.string(),
    ownerId: s.string().nullable(),
    owner: s
      .toOne(() => scopeOwner)
      .fields("ownerId")
      .references("id"),
  })
  .map(SCOPE_NOTES);
const scopePair = s
  .model({
    region: s.string(),
    slug: s.string(),
    label: s.string(),
  })
  .id(["region", "slug"])
  .map(SCOPE_PAIRS);
const scopeTag = s
  .model({
    id: s.string().id(),
    label: s.string(),
    owners: s.toMany(() => scopeOwner),
  })
  .map(SCOPE_TAGS);
const scopeSchema = {
  owner: scopeOwner,
  note: scopeNote,
  pair: scopePair,
  tag: scopeTag,
};

type ScopeCall = (
  model: string,
  operation: string,
  args: unknown
) => Promise<unknown>;

interface ScopeOutcome {
  readonly answer: string;
  readonly owners: unknown[];
  readonly notes: unknown[];
  readonly links: unknown[];
  readonly tags: unknown[];
}

/**
 * R-B5 on a credential-free provider. `SQLite3Driver` issues
 * `PRAGMA foreign_keys = ON` (`src/drivers/sqlite3/index.ts:131`), so a link
 * row that references its target is enforced here exactly as the live MySQL
 * table enforces it, and the junction `delete`'s statement ORDER is observable
 * without a container.
 *
 * The link table is re-created by hand, because the project's own migration
 * emits `ON DELETE CASCADE ON UPDATE CASCADE` on BOTH junction foreign keys
 * (measured: `CONSTRAINT "…_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES … ON
 * DELETE CASCADE`). A cascading link makes the order unobservable — the
 * provider removes the link for you — which is why no SQLite cell in this
 * estate ever saw R-B5. The plain foreign keys below are the ones the live
 * MySQL world in this file declares, and they are what the shipped engine's
 * ordering contract exists for.
 */
async function scopeSqliteWorld() {
  const database = new Database(":memory:");
  const driver = new SQLite3Driver({ client: database });
  const client = createClient({ schema: scopeSchema, driver });
  const migration = await syncLiveSchema(client);
  if (!migration.applied) throw new Error("scope world did not apply");
  database.exec(
    `DROP TABLE "${SCOPE_LINKS}";
     CREATE TABLE "${SCOPE_LINKS}" (
       "ownerId" TEXT NOT NULL,
       "tagId" TEXT NOT NULL,
       PRIMARY KEY ("ownerId","tagId"),
       FOREIGN KEY ("ownerId") REFERENCES "${SCOPE_OWNERS}" ("id"),
       FOREIGN KEY ("tagId") REFERENCES "${SCOPE_TAGS}" ("id")
     );
     INSERT INTO ${SCOPE_OWNERS} (id,email,name) VALUES ('wanted','claim@x','winner');
     INSERT INTO ${SCOPE_NOTES} (id,title,ownerId) VALUES ('n1','T','wanted');
     INSERT INTO ${SCOPE_TAGS} (id,label) VALUES ('g1','tag');
     INSERT INTO ${SCOPE_LINKS} (ownerId,tagId) VALUES ('wanted','g1');`
  );
  return { client, database, driver };
}

async function scopeSqliteRun(
  engine: "shipped" | "candidate",
  request: (call: ScopeCall) => Promise<unknown>
): Promise<ScopeOutcome> {
  const world = await scopeSqliteWorld();
  const candidate = createCommandEngine({
    schema: scopeSchema,
    driver: world.driver,
  });
  let answer: string;
  try {
    const call: ScopeCall = (model, operation, args) =>
      engine === "shipped"
        ? (
            world.client as unknown as Record<
              string,
              Record<string, (args: unknown) => Promise<unknown>>
            >
          )[model]![operation]!(args)
        : (
            candidate as unknown as {
              execute(
                model: string,
                operation: string,
                args: unknown
              ): Promise<unknown>;
            }
          ).execute(model, operation, args);
    answer = `ok:${JSON.stringify(await request(call))}`;
  } catch (error) {
    answer = `${(error as Error).constructor.name}: ${(error as Error).message}`;
  }
  const rows = (sql: string) => world.database.prepare(sql).all();
  const outcome: ScopeOutcome = {
    answer,
    links: rows(
      `SELECT ownerId, tagId FROM ${SCOPE_LINKS} ORDER BY ownerId, tagId`
    ),
    notes: rows(`SELECT id, ownerId FROM ${SCOPE_NOTES} ORDER BY id`),
    owners: rows(`SELECT id, email, name FROM ${SCOPE_OWNERS} ORDER BY id`),
    tags: rows(`SELECT id, label FROM ${SCOPE_TAGS} ORDER BY id`),
  };
  await world.client.$disconnect();
  world.database.close();
  return outcome;
}

describe("G4-02 — the junction delete removes the link row, then the target", () => {
  // R-B5, repaired here: the candidate used to place the target's DELETE alone,
  // so the link row still referenced the row being deleted and the provider
  // refused the whole write with a foreign-key violation. The shipped engine
  // states the order in `write-engine/RelationJunctionPart.ts:911-937`
  // (`compileDelete`: "locate the connected child, DELETE its join rows, then
  // the child"), and the candidate now states it in the one owner that places
  // a junction removal, `commands/relation-body.ts`'s `disconnect`/`delete` arm.
  for (const id of ["g1", "G1"] as const) {
    it(`deletes the link and the target, addressed by ${id === "g1" ? "exact bytes" : "a collation-equal key"}`, async () => {
      const request = (call: ScopeCall) =>
        call("owner", "update", {
          data: { tags: { delete: [{ id }] } },
          where: { id: "wanted" },
        });
      const shipped = await scopeSqliteRun("shipped", request);
      const candidate = await scopeSqliteRun("candidate", request);
      assert.deepEqual(candidate, shipped, id);
      // SQLite's default collation is binary, so the collation-equal spelling
      // addresses no row here and both engines answer their nested-write
      // refusal; the exact-byte one is the contract cell. The collation half is
      // measured on the live MySQL table below.
      if (id === "g1") {
        assert.equal(
          candidate.answer,
          'ok:{"id":"wanted","email":"claim@x","name":"winner"}'
        );
        assert.deepEqual(candidate.links, []);
        assert.deepEqual(candidate.tags, []);
      }
    });
  }

  it("still removes ONLY the link row for a junction disconnect", async () => {
    // The repair adds a statement to `delete` and to nothing else: a
    // `disconnect` places the removal alone, and the target survives.
    const request = (call: ScopeCall) =>
      call("owner", "update", {
        data: { tags: { disconnect: [{ id: "g1" }] } },
        where: { id: "wanted" },
      });
    const shipped = await scopeSqliteRun("shipped", request);
    const candidate = await scopeSqliteRun("candidate", request);
    assert.deepEqual(candidate, shipped);
    assert.deepEqual(candidate.links, []);
    assert.deepEqual(candidate.tags, [{ id: "g1", label: "tag" }]);
  });

  it("still deletes a REFERENCE-held target with one statement", async () => {
    // The other edge kind: the child row holds the foreign key, so it is
    // deleted alone — the removal the junction arm adds must not appear here.
    const request = (call: ScopeCall) =>
      call("owner", "update", {
        data: { notes: { delete: [{ id: "n1" }] } },
        where: { id: "wanted" },
      });
    const shipped = await scopeSqliteRun("shipped", request);
    const candidate = await scopeSqliteRun("candidate", request);
    assert.deepEqual(candidate, shipped);
    assert.deepEqual(candidate.notes, []);
  });
});

describe.runIf(provider === "mysql" && port > 0)(
  "G4-02 native MySQL discriminator scope",
  () => {
    const connect = () =>
      new MySQL2Driver({
        options: {
          host: "127.0.0.1",
          port,
          database: "raptor3_g2",
          user: "root",
          password: "",
          connectionLimit: 2,
          connectTimeout: 10_000,
        },
      });
    let setup: MySQL2Driver;

    const dropAll = async () => {
      await setup._executeRaw(`DROP TABLE IF EXISTS ${SCOPE_LINKS}`);
      await setup._executeRaw(`DROP TABLE IF EXISTS ${SCOPE_NOTES}`);
      await setup._executeRaw(`DROP TABLE IF EXISTS ${SCOPE_OWNERS}`);
      await setup._executeRaw(`DROP TABLE IF EXISTS ${SCOPE_PAIRS}`);
      await setup._executeRaw(`DROP TABLE IF EXISTS ${SCOPE_TAGS}`);
    };

    beforeAll(async () => {
      setup = connect();
      await dropAll();
      await setup._executeRaw(
        `CREATE TABLE ${SCOPE_OWNERS} (id VARCHAR(191) PRIMARY KEY NOT NULL, email VARCHAR(191) NOT NULL UNIQUE, name VARCHAR(191) NOT NULL)`
      );
      await setup._executeRaw(
        `CREATE TABLE ${SCOPE_NOTES} (id VARCHAR(191) PRIMARY KEY NOT NULL, title VARCHAR(191) NOT NULL, ownerId VARCHAR(191) NULL, FOREIGN KEY(ownerId) REFERENCES ${SCOPE_OWNERS}(id))`
      );
      await setup._executeRaw(
        `CREATE TABLE ${SCOPE_PAIRS} (region VARCHAR(191) NOT NULL, slug VARCHAR(191) NOT NULL, label VARCHAR(191) NOT NULL, PRIMARY KEY (region, slug))`
      );
      await setup._executeRaw(
        `CREATE TABLE ${SCOPE_TAGS} (id VARCHAR(191) PRIMARY KEY NOT NULL, label VARCHAR(191) NOT NULL)`
      );
      await setup._executeRaw(
        `CREATE TABLE ${SCOPE_LINKS} (ownerId VARCHAR(191) NOT NULL, tagId VARCHAR(191) NOT NULL, PRIMARY KEY (ownerId, tagId), FOREIGN KEY(ownerId) REFERENCES ${SCOPE_OWNERS}(id), FOREIGN KEY(tagId) REFERENCES ${SCOPE_TAGS}(id))`
      );
    }, 60_000);

    afterAll(async () => {
      await dropAll();
      await setup.disconnect();
    }, 60_000);

    const seed = async () => {
      await setup._executeRaw(`DELETE FROM ${SCOPE_LINKS}`);
      await setup._executeRaw(`DELETE FROM ${SCOPE_NOTES}`);
      await setup._executeRaw(`DELETE FROM ${SCOPE_OWNERS}`);
      await setup._executeRaw(`DELETE FROM ${SCOPE_PAIRS}`);
      await setup._executeRaw(`DELETE FROM ${SCOPE_TAGS}`);
      await setup._executeRaw(
        `INSERT INTO ${SCOPE_OWNERS} (id, email, name) VALUES ('wanted','claim@x','winner')`
      );
      await setup._executeRaw(
        `INSERT INTO ${SCOPE_NOTES} (id, title, ownerId) VALUES ('n1','T','wanted')`
      );
      await setup._executeRaw(
        `INSERT INTO ${SCOPE_PAIRS} (region, slug, label) VALUES ('eu','alpha','p')`
      );
      await setup._executeRaw(
        `INSERT INTO ${SCOPE_TAGS} (id, label) VALUES ('g1','tag')`
      );
      await setup._executeRaw(
        `INSERT INTO ${SCOPE_LINKS} (ownerId, tagId) VALUES ('wanted','g1')`
      );
    };

    const run = async (
      engine: "shipped" | "candidate",
      request: (call: ScopeCall) => Promise<unknown>
    ): Promise<ScopeOutcome> => {
      await seed();
      const driver = connect();
      let answer: string;
      try {
        const client = createClient({ schema: scopeSchema, driver });
        const candidate = createCommandEngine({ schema: scopeSchema, driver });
        const call: ScopeCall = (model, operation, args) =>
          engine === "shipped"
            ? (
                client as unknown as Record<
                  string,
                  Record<string, (args: unknown) => Promise<unknown>>
                >
              )[model]![operation]!(args)
            : (
                candidate as unknown as {
                  execute(
                    model: string,
                    operation: string,
                    args: unknown
                  ): Promise<unknown>;
                }
              ).execute(model, operation, args);
        answer = `ok:${JSON.stringify(await request(call))}`;
      } catch (error) {
        answer = `${(error as Error).constructor.name}: ${(error as Error).message}`;
      } finally {
        await driver.disconnect();
      }
      const ownerRows = await setup._executeRaw<Record<string, unknown>>(
        `SELECT id, email, name FROM ${SCOPE_OWNERS} ORDER BY id`
      );
      const noteRows = await setup._executeRaw<Record<string, unknown>>(
        `SELECT id, ownerId FROM ${SCOPE_NOTES} ORDER BY id`
      );
      const linkRows = await setup._executeRaw<Record<string, unknown>>(
        `SELECT ownerId, tagId FROM ${SCOPE_LINKS} ORDER BY ownerId, tagId`
      );
      const tagRows = await setup._executeRaw<Record<string, unknown>>(
        `SELECT id, label FROM ${SCOPE_TAGS} ORDER BY id`
      );
      return {
        answer,
        owners: ownerRows.rows,
        notes: noteRows.rows,
        links: linkRows.rows,
        tags: tagRows.rows,
      };
    };

    const collationIsInsensitive = async () => {
      const collation = await setup._executeRaw<{ TABLE_COLLATION: string }>(
        `SELECT TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_NAME = '${SCOPE_OWNERS}'`
      );
      return CASE_INSENSITIVE_COLLATION.test(
        collation.rows[0]!.TABLE_COLLATION
      );
    };

    it("addresses through the constraint exactly the call sites the shipped engine compiles with buildWhereUnique", async () => {
      assert.equal(
        await collationIsInsensitive(),
        true,
        "the cells need a case-insensitive collation to be cells at all"
      );
      const cells: [string, (call: ScopeCall) => Promise<unknown>][] = [
        // Key-addressed: the shipped counterpart is `buildWhereUnique`.
        [
          "root delete by a collation-equal key",
          (call) => call("owner", "delete", { where: { id: "WANTED" } }),
        ],
        [
          "root upsert whose locator is collation-equal",
          (call) =>
            call("owner", "upsert", {
              where: { id: "WANTED" },
              create: { id: "WANTED", email: "new@x", name: "created" },
              update: { name: "updated" },
            }),
        ],
        [
          "nested set on a collation-equal key",
          (call) =>
            call("owner", "update", {
              where: { id: "wanted" },
              data: { notes: { set: [{ id: "N1" }] } },
            }),
        ],
        [
          "nested upsert on a collation-equal key",
          (call) =>
            call("owner", "update", {
              where: { id: "wanted" },
              data: {
                notes: {
                  upsert: [
                    {
                      where: { id: "N1" },
                      create: { id: "N1", title: "c" },
                      update: { title: "u" },
                    },
                  ],
                },
              },
            }),
        ],
        [
          "compound unique selector, collation-equal members",
          (call) =>
            call("pair", "findUnique", {
              where: { region_slug: { region: "EU", slug: "ALPHA" } },
            }),
        ],
        // Junction targets: the shipped engine never recombines them, so the
        // same three verbs address through the constraint on THIS edge kind and
        // touch the link row and the target the reference family refuses.
        [
          "junction disconnect on a collation-equal key",
          (call) =>
            call("owner", "update", {
              where: { id: "wanted" },
              data: { tags: { disconnect: [{ id: "G1" }] } },
            }),
        ],
        [
          "junction update on a collation-equal key",
          (call) =>
            call("owner", "update", {
              where: { id: "wanted" },
              data: {
                tags: {
                  update: [{ where: { id: "G1" }, data: { label: "u" } }],
                },
              },
            }),
        ],
        [
          "junction connect on a collation-equal key",
          (call) =>
            call("owner", "update", {
              where: { id: "wanted" },
              data: { tags: { connect: [{ id: "G1" }] } },
            }),
        ],
        // The one verb whose two shipped phases are spelled differently — the
        // probe is `buildFindUnique` (`RelationUpsertPart.ts:265`) and the
        // found guard is `uniqueSelectorConjuncts` (`:578`) — so it is the row
        // most likely to move if the edge-kind rule is ever restated. Both
        // engines agree today, and this row pins that.
        [
          "junction upsert on a collation-equal key",
          (call) =>
            call("owner", "update", {
              where: { id: "wanted" },
              data: {
                tags: {
                  upsert: [
                    {
                      where: { id: "G1" },
                      create: { id: "G1", label: "c" },
                      update: { label: "u" },
                    },
                  ],
                },
              },
            }),
        ],
        // Filters: the shipped counterpart is `uniqueSelectorConjuncts`, so the
        // target keeps the engine's case-sensitivity contract and the three
        // nested verbs refuse a row they cannot address.
        [
          "nested disconnect stays a filter",
          (call) =>
            call("owner", "update", {
              where: { id: "wanted" },
              data: { notes: { disconnect: [{ id: "N1" }] } },
            }),
        ],
        [
          "nested delete stays a filter",
          (call) =>
            call("owner", "update", {
              where: { id: "wanted" },
              data: { notes: { delete: [{ id: "N1" }] } },
            }),
        ],
        [
          "nested update stays a filter",
          (call) =>
            call("owner", "update", {
              where: { id: "wanted" },
              data: {
                notes: {
                  update: [{ where: { id: "N1" }, data: { title: "u" } }],
                },
              },
            }),
        ],
        [
          "extended unique where: the filter half stays case-sensitive",
          (call) =>
            call("owner", "findUnique", {
              where: { id: "WANTED", name: "WINNER" },
            }),
        ],
        [
          "deleteMany by a collation-equal filter",
          (call) => call("owner", "deleteMany", { where: { id: "WANTED" } }),
        ],
      ];
      for (const [name, request] of cells) {
        const shipped = await run("shipped", request);
        const candidate = await run("candidate", request);
        assert.deepEqual(candidate, shipped, name);
      }
    }, 180_000);

    it("R-B5: a junction delete removes the link row and the target, by either spelling", async () => {
      assert.equal(await collationIsInsensitive(), true);
      const request = (id: string) => (call: ScopeCall) =>
        call("owner", "update", {
          where: { id: "wanted" },
          data: { tags: { delete: [{ id }] } },
        });
      // R-B5, repaired: the candidate used to place the target's DELETE alone
      // and the live table's `FOREIGN KEY(tagId)` — declared above without an
      // `ON DELETE` clause — refused the whole write. It now removes the link
      // row first, the order the shipped engine states in
      // `write-engine/RelationJunctionPart.ts:911-937`. Both selector
      // spellings reach it: a junction target is addressed through the
      // constraint on this collation, so `G1` and `g1` name the same row.
      for (const id of ["G1", "g1"]) {
        const shipped = await run("shipped", request(id));
        const candidate = await run("candidate", request(id));
        assert.deepEqual(candidate, shipped, id);
        assert.equal(
          candidate.answer,
          'ok:{"id":"wanted","email":"claim@x","name":"winner"}',
          id
        );
        assert.deepEqual(candidate.links, [], id);
        assert.deepEqual(candidate.tags, [], id);
      }
    }, 120_000);

    it("R-D4 THE CONTRACT: a collation-equal connect stores the LOCATED row's key in the foreign-key column", async () => {
      assert.equal(await collationIsInsensitive(), true);
      // R-D4, decided by Arnaud on 2026-09-15: "accept the candidate
      // behaviour". A `connect` names a row, and the candidate writes the key
      // of the row it located (`parent.located.fields`), so the child's foreign
      // key always holds bytes that exist in the parent table.
      //
      // Legacy baseline, recorded not asserted: the shipped engine writes the
      // REQUEST's literal (`ownerId` `"WANTED"`), which references the same
      // parent under a `_ci` collation but stores bytes no parent row carries.
      // Measured in this file's receipts and, at the committed `0cc61e61`
      // baseline, in
      // `g4/unit02-closure-review-followup-2-receipts/classify-rd4-baseline-0cc61e61.log`
      // — the divergence pre-dates every G4 unit.
      //
      // Two positions, one rule. The child-held `create` writes the foreign key
      // as part of the new row; the PARENT-held `update` rewrites the foreign
      // key of the row being updated (`note.owner`, the third shipped
      // position). Both must store the located key.
      const created = await run("candidate", (call) =>
        call("note", "create", {
          data: {
            id: "n2",
            title: "T",
            owner: { connect: { id: "WANTED" } },
          },
        })
      );
      assert.equal(
        created.answer,
        'ok:{"id":"n2","title":"T","ownerId":"wanted"}'
      );
      assert.deepEqual(created.notes, [
        { id: "n1", ownerId: "wanted" },
        { id: "n2", ownerId: "wanted" },
      ]);

      const reconnected = await run("candidate", (call) =>
        call("note", "update", {
          where: { id: "n1" },
          data: { owner: { connect: { id: "WANTED" } } },
        })
      );
      assert.equal(
        reconnected.answer,
        'ok:{"id":"n1","title":"T","ownerId":"wanted"}'
      );
      assert.deepEqual(reconnected.notes, [{ id: "n1", ownerId: "wanted" }]);

      const connectedOrCreated = await run("candidate", (call) =>
        call("note", "update", {
          where: { id: "n1" },
          data: {
            owner: {
              connectOrCreate: {
                where: { id: "WANTED" },
                create: { id: "WANTED", email: "new@x", name: "created" },
              },
            },
          },
        })
      );
      assert.equal(
        connectedOrCreated.answer,
        'ok:{"id":"n1","title":"T","ownerId":"wanted"}'
      );
      // The probe found the existing row, so no parent was created.
      assert.deepEqual(connectedOrCreated.owners, [
        { id: "wanted", email: "claim@x", name: "winner" },
      ]);
    }, 120_000);
  }
);
