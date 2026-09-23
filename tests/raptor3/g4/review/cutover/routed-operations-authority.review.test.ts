/**
 * C-01 cutover review probe (independent reviewer, not a registered mode).
 *
 * The cutover ADDS exactly one production file, `src/query-engine/routed-operations.ts`,
 * holding READ_OPERATIONS / ROUTED_OPERATIONS / isReadOperation / isWriteOperation
 * "verbatim" from the deleted `write-engine/routing.ts`. The author's note names the
 * falsifier for that claim: `raptor3/shared/schema.ts#isReadOperation` classifies
 * `findUniqueOrThrow` / `findFirstOrThrow` differently (its set omits them), so a
 * substitution would change the OBSERVABLE interception contract.
 *
 * `src/extensions/query.ts#requiresProceed` is where that classification is observable
 * through the public client: a model interceptor in `direct` mode may answer a READ
 * without calling `proceed()`, and must be refused ("completed without proceed") for
 * anything else. These cells run that seam end to end on a real sqlite3 client.
 */
import assert from "node:assert/strict";
import { QueryError } from "@errors";
import {
  isReadOperation,
  isWriteOperation,
  ROUTED_OPERATIONS,
} from "@query-engine/routed-operations";
import { isReadOperation as engineIsReadOperation } from "@query-engine/raptor3/shared/schema";
import { s } from "@schema";
import { createClient } from "@src/index";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { SQLite3Driver } from "@drivers/sqlite3";
import Database from "better-sqlite3";
import { afterEach, describe, it } from "vitest";

const author = s
  .model({
    id: s.int().id().increment(),
    email: s.string().unique(),
    name: s.string(),
  })
  .map("g4rc_authors");
const schema = { author };

const opened: { close(): void }[] = [];
const clients: { $disconnect(): Promise<unknown> }[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.$disconnect();
  for (const database of opened.splice(0)) database.close();
});

async function world() {
  const database = new Database(":memory:");
  opened.push(database);
  const driver = new SQLite3Driver({ client: database });
  const client = createClient({ driver, schema });
  clients.push(client as unknown as { $disconnect(): Promise<unknown> });
  const migration = await syncLiveSchema(client);
  assert.equal(migration.applied, true);
  await client.author.create({
    data: { email: "present@example.test", name: "Ada" },
  });
  return client;
}

describe("C-01 review — routed-operations is the one read/write authority", () => {
  it("findUniqueOrThrow is a READ at the interception seam: an interceptor may answer without proceeding", async () => {
    const base = await world();
    const short = { id: -1, email: "short@circuit", name: "not the row" };
    const client = base.$extends({
      name: "or-throw-read",
      query: {
        author: {
          findUniqueOrThrow: async () => short as never,
        },
      },
    });
    const answer = await client.author.findUniqueOrThrow({
      where: { email: "present@example.test" },
    });
    assert.deepEqual(answer, short);
  });

  it("findFirstOrThrow is a READ at the same seam", async () => {
    const base = await world();
    const short = { id: -2, email: "short@circuit", name: "not the row" };
    const client = base.$extends({
      name: "or-throw-read-first",
      query: {
        author: {
          findFirstOrThrow: async () => short as never,
        },
      },
    });
    const answer = await client.author.findFirstOrThrow({
      where: { email: "present@example.test" },
    });
    assert.deepEqual(answer, short);
  });

  it("a WRITE is still refused when the interceptor does not proceed", async () => {
    const base = await world();
    const client = base.$extends({
      name: "write-without-proceed",
      query: {
        author: {
          create: async () => ({ id: -3, email: "x@y", name: "z" }) as never,
        },
      },
    });
    let raised: unknown;
    try {
      await client.author.create({
        data: { email: "second@example.test", name: "Bo" },
      });
    } catch (error) {
      raised = error;
    }
    assert.equal(raised instanceof QueryError, true);
    assert.match(String((raised as Error).message), /completed without proceed/);
  });

  it("the retained vocabulary differs from the engine's own read set exactly on the OrThrow verbs", () => {
    for (const verb of ["findUniqueOrThrow", "findFirstOrThrow"] as const) {
      assert.equal(isReadOperation(verb), true);
      assert.equal(isWriteOperation(verb), false);
      assert.equal(ROUTED_OPERATIONS.has(verb), true);
      // The deliberate non-substitution recorded in the cutover note.
      assert.equal(
        engineIsReadOperation(verb as never),
        false,
        "raptor3/shared/schema.ts must keep its narrower set"
      );
    }
    assert.deepEqual(
      [...ROUTED_OPERATIONS].sort(),
      [
        "aggregate",
        "count",
        "create",
        "createMany",
        "delete",
        "deleteMany",
        "exist",
        "findFirst",
        "findFirstOrThrow",
        "findMany",
        "findUnique",
        "findUniqueOrThrow",
        "groupBy",
        "update",
        "updateMany",
        "upsert",
      ]
    );
  });
});
