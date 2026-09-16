/**
 * G4-02 independent review, repair round — adversarial probes against the NEW
 * `OperationContext.packagedPresence` guard (review finding 1's repair).
 *
 * The repair adds production code that no round-1 probe attacked: a guard
 * statement queued ahead of the folded mutation and declared through
 * `PreparedBatchOperation.guards`, re-indexed by the array owner at the merge
 * offset and reconstructed by `attributeOperationBatchError`. These cells attack
 * the parts the author's own pin does not reach: the FULL error identity
 * (message and meta, not only class and code), the guard's index offset when the
 * packaged member is not first, a projected fold, two guards in one batch, and a
 * premise a SIBLING statement breaks.
 */

import assert from "node:assert/strict";
import { VibORM, type VibORMClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCandidateRoute } from "@query-engine/raptor3/route/client-route";
import { s } from "@schema";
import { createClient } from "@src/index";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { afterEach, describe, it } from "vitest";

const author = s
  .model({
    id: s.int().id().increment(),
    email: s.string().unique(),
    name: s.string(),
  })
  .map("rv2r_authors");

const tag = s
  .model({
    id: s.int().id().increment(),
    slug: s.string().unique(),
  })
  .map("rv2r_tags");

const schema = { author, tag };

class BatchOnlyDriver extends SQLite3Driver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    return this.transaction(client, (transaction) =>
      super.executeBatch<T>(transaction, queries)
    );
  }
}

interface World {
  readonly client: VibORMClient<{
    driver: BatchOnlyDriver;
    schema: typeof schema;
  }>;
  readonly database: Database.Database;
  readonly driver: BatchOnlyDriver;
}

const worlds: World[] = [];

afterEach(async () => {
  for (const world of worlds.splice(0)) {
    await world.client.$disconnect();
    world.database.close();
  }
});

async function createWorld(route: "shipped" | "candidate"): Promise<World> {
  const database = new Database(":memory:");
  const driver = new BatchOnlyDriver({ client: database });
  const config = { driver, schema };
  const client =
    route === "shipped"
      ? createClient(config)
      : VibORM.create(config, createCandidateRoute);
  const migration = await syncLiveSchema(client);
  if (!migration.applied) throw new Error("schema did not apply");
  await client.author.create({
    data: { email: "present@example.test", name: "Ada" },
  });
  await client.author.create({
    data: { email: "second@example.test", name: "Bo" },
  });
  await client.tag.create({ data: { slug: "present-tag" } });
  const world = { client, database, driver } as World;
  worlds.push(world);
  return world;
}

function storedAuthors(world: World): unknown[] {
  return world.database
    .prepare("SELECT email FROM rv2r_authors ORDER BY id")
    .all();
}

function storedTags(world: World): unknown[] {
  return world.database.prepare("SELECT slug FROM rv2r_tags ORDER BY id").all();
}

interface Outcome {
  readonly rejected: string;
  readonly code: unknown;
  readonly message: unknown;
  readonly meta: unknown;
  readonly authors: unknown[];
  readonly tags: unknown[];
  readonly value?: unknown;
}

async function arrayOutcome(
  world: World,
  members: (client: World["client"]) => readonly PromiseLike<unknown>[]
): Promise<Outcome> {
  let rejection: unknown;
  let value: unknown;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: the array seam is structural here.
    value = await (world.client as any).$transaction(members(world.client));
  } catch (error) {
    rejection = error;
  }
  const error = rejection as
    | { name: string; code?: unknown; message?: unknown; meta?: unknown }
    | undefined;
  return {
    rejected: error === undefined ? "none" : error.name,
    code: error?.code,
    message: error?.message,
    meta: error?.meta,
    authors: storedAuthors(world),
    tags: storedTags(world),
    value,
  };
}

/** The live (non-packaged) failure, for identity comparison with the packaged one. */
async function liveOutcome(
  world: World,
  run: (client: World["client"]) => PromiseLike<unknown>
) {
  try {
    await run(world.client);
    return { rejected: "none" as const };
  } catch (error) {
    const typed = error as {
      name: string;
      code?: unknown;
      message?: unknown;
      meta?: unknown;
    };
    return {
      rejected: typed.name,
      code: typed.code,
      message: typed.message,
      meta: typed.meta,
    };
  }
}

describe("G4-02 review (repair) — packaged presence guard", () => {
  it("the packaged missing-delete error is identical to the SHIPPED packaged one, in message and meta", async () => {
    const shipped = await arrayOutcome(await createWorld("shipped"), (c) => [
      c.author.delete({ where: { email: "absent@example.test" } }),
    ]);
    const candidateWorld = await createWorld("candidate");
    const candidate = await arrayOutcome(candidateWorld, (c) => [
      c.author.delete({ where: { email: "absent@example.test" } }),
    ]);
    const live = await liveOutcome(await createWorld("candidate"), (c) =>
      c.author.delete({ where: { email: "absent@example.test" } })
    );
    const shippedLive = await liveOutcome(await createWorld("shipped"), (c) =>
      c.author.delete({ where: { email: "absent@example.test" } })
    );
    // eslint-disable-next-line no-console
    console.log(
      "GUARDIDENTITY",
      JSON.stringify({ shipped, candidate, live, shippedLive }, undefined, 1)
    );
    assert.equal(candidate.rejected, shipped.rejected);
    assert.equal(candidate.code, shipped.code);
    assert.equal(candidate.message, shipped.message);
    assert.deepEqual(candidate.meta, shipped.meta);
    // The packaged premise must reconstruct the SAME error the live postcondition
    // raises, to whatever degree the SHIPPED engine does: the shipped live path
    // adds its own progress meta that its packaged path does not, so the
    // requirement is per-route parity, not live/packaged equality.
    assert.equal(candidate.rejected, live.rejected);
    assert.equal(candidate.code, live.code);
    assert.equal(candidate.message, live.message);
  });

  // NOTE EVIDENCE CELL — red by construction. The LIVE (non-packaged) root
  // delete/update on a TRANSACTION-LESS driver wraps its NotFoundError with
  // `meta.recordSeriesProgress`, which the shipped engine does not attach. Class,
  // code and message agree; only the meta key set differs. Recorded as a note,
  // not repaired here.
  it("NOTE evidence: the LIVE root-delete meta on a batch-only driver diverges from shipped", async () => {
    const live = await liveOutcome(await createWorld("candidate"), (c) =>
      c.author.delete({ where: { email: "absent@example.test" } })
    );
    const shippedLive = await liveOutcome(await createWorld("shipped"), (c) =>
      c.author.delete({ where: { email: "absent@example.test" } })
    );
    // eslint-disable-next-line no-console
    console.log("LIVEDELETEMETA", JSON.stringify({ live, shippedLive }));
    assert.deepEqual(live.meta, shippedLive.meta);
  });

  it("the guard is attributed correctly when the packaged member is NOT first in the array", async () => {
    const members = (c: World["client"]) => [
      c.author.create({ data: { email: "sib-a@example.test", name: "Sa" } }),
      c.author.delete({ where: { email: "absent@example.test" } }),
      c.author.create({ data: { email: "sib-b@example.test", name: "Sb" } }),
    ];
    const shipped = await arrayOutcome(await createWorld("shipped"), members);
    const candidate = await arrayOutcome(
      await createWorld("candidate"),
      members
    );
    // eslint-disable-next-line no-console
    console.log("MIDDLE", JSON.stringify({ shipped, candidate }));
    assert.equal(candidate.rejected, shipped.rejected);
    assert.equal(candidate.message, shipped.message);
    assert.deepEqual(candidate.authors, shipped.authors);
  });

  it("two packaged folds of DIFFERENT models in one array keep the failing one's identity", async () => {
    const members = (c: World["client"]) => [
      c.author.delete({ where: { email: "present@example.test" } }),
      c.tag.delete({ where: { slug: "absent-tag" } }),
    ];
    const shipped = await arrayOutcome(await createWorld("shipped"), members);
    const candidate = await arrayOutcome(
      await createWorld("candidate"),
      members
    );
    // eslint-disable-next-line no-console
    console.log("TWOMODELS", JSON.stringify({ shipped, candidate }));
    assert.equal(candidate.rejected, shipped.rejected);
    assert.equal(candidate.message, shipped.message);
    assert.deepEqual(candidate.authors, shipped.authors);
    assert.deepEqual(candidate.tags, shipped.tags);
  });

  it("a premise broken by a SIBLING statement inside the same batch behaves as shipped", async () => {
    const members = (c: World["client"]) => [
      c.author.delete({ where: { email: "present@example.test" } }),
      c.author.delete({ where: { email: "present@example.test" } }),
    ];
    const shipped = await arrayOutcome(await createWorld("shipped"), members);
    const candidate = await arrayOutcome(
      await createWorld("candidate"),
      members
    );
    // eslint-disable-next-line no-console
    console.log("SIBLINGBREAK", JSON.stringify({ shipped, candidate }));
    assert.equal(candidate.rejected, shipped.rejected);
    assert.deepEqual(candidate.authors, shipped.authors);
  });

  it("a packaged fold WITH a scalar projection publishes the row and still guards", async () => {
    const present = (c: World["client"]) => [
      c.author.delete({
        where: { email: "present@example.test" },
        select: { email: true },
      }),
    ];
    const missing = (c: World["client"]) => [
      c.author.delete({
        where: { email: "absent@example.test" },
        select: { email: true },
      }),
    ];
    const shippedPresent = await arrayOutcome(
      await createWorld("shipped"),
      present
    );
    const candidatePresent = await arrayOutcome(
      await createWorld("candidate"),
      present
    );
    const shippedMissing = await arrayOutcome(
      await createWorld("shipped"),
      missing
    );
    const candidateMissing = await arrayOutcome(
      await createWorld("candidate"),
      missing
    );
    // eslint-disable-next-line no-console
    console.log(
      "PROJECTEDFOLD",
      JSON.stringify({
        shippedPresent,
        candidatePresent,
        shippedMissing,
        candidateMissing,
      })
    );
    assert.deepEqual(candidatePresent.value, shippedPresent.value);
    assert.deepEqual(candidatePresent.authors, shippedPresent.authors);
    assert.equal(candidateMissing.rejected, shippedMissing.rejected);
    assert.equal(candidateMissing.message, shippedMissing.message);
    assert.deepEqual(candidateMissing.authors, shippedMissing.authors);
  });

  it("a packaged missing root UPDATE keeps the live error identity too", async () => {
    const members = (c: World["client"]) => [
      c.author.create({ data: { email: "sib-u@example.test", name: "Su" } }),
      c.author.update({
        where: { email: "absent@example.test" },
        data: { name: "X" },
      }),
    ];
    const shipped = await arrayOutcome(await createWorld("shipped"), members);
    const candidate = await arrayOutcome(
      await createWorld("candidate"),
      members
    );
    const live = await liveOutcome(await createWorld("candidate"), (c) =>
      c.author.update({
        where: { email: "absent@example.test" },
        data: { name: "X" },
      })
    );
    // eslint-disable-next-line no-console
    console.log("UPDATEFOLD", JSON.stringify({ shipped, candidate, live }));
    assert.equal(candidate.rejected, shipped.rejected);
    assert.equal(candidate.message, shipped.message);
    assert.deepEqual(candidate.meta, shipped.meta);
    assert.deepEqual(candidate.authors, shipped.authors);
    assert.equal(candidate.message, live.message);
  });
});

/**
 * Control: is the extra `meta.recordSeriesProgress` the candidate's LIVE root
 * delete/update carries on a batch-only driver specific to the verbs THIS unit
 * folded, or a pre-existing candidate/shipped difference for every write on a
 * transaction-less driver? `create` and `createMany` are untouched by this unit.
 */
describe("G4-02 review (repair) — live error meta on a batch-only driver", () => {
  // NOTE EVIDENCE CELL — red by construction, and its POINT is the control:
  // `create`/`createMany` (untouched by this unit) ALREADY diverge from shipped
  // in their meta key set on a transaction-less driver (`statementIndex`), so the
  // difference is a pre-existing candidate trait, not one this unit introduced.
  it("NOTE evidence: candidate and shipped meta differ for verbs this unit did NOT change", async () => {
    const rows: Record<string, unknown>[] = [];
    for (const route of ["shipped", "candidate"] as const) {
      const world = await createWorld(route);
      const create = await liveOutcome(world, (c) =>
        c.author.create({ data: { email: "present@example.test", name: "Dup" } })
      );
      const createMany = await liveOutcome(world, (c) =>
        c.author.createMany({
          data: [{ email: "present@example.test", name: "Dup2" }],
        })
      );
      const del = await liveOutcome(world, (c) =>
        c.author.delete({ where: { email: "absent@example.test" } })
      );
      const upd = await liveOutcome(world, (c) =>
        c.author.update({
          where: { email: "absent@example.test" },
          data: { name: "X" },
        })
      );
      rows.push({
        route,
        create: Object.keys((create as { meta?: object }).meta ?? {}),
        createMany: Object.keys((createMany as { meta?: object }).meta ?? {}),
        delete: Object.keys((del as { meta?: object }).meta ?? {}),
        update: Object.keys((upd as { meta?: object }).meta ?? {}),
      });
    }
    // eslint-disable-next-line no-console
    console.log("LIVEMETA", JSON.stringify(rows, undefined, 1));
    assert.deepEqual(rows[1]!.delete, rows[0]!.delete);
    assert.deepEqual(rows[1]!.update, rows[0]!.update);
  });
});
