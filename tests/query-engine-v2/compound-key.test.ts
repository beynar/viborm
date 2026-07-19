import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { describe, expect, test } from "vitest";
import { compoundKeyBehaviorSchema } from "../fixtures/compound-key-behavior-schema";
import { createV2RoutedClient } from "./v2-client-proxy";

/**
 * The P3 compound-key dual-run oracle. Compound primary keys (author
 * `[tenantId, id]`) and compound foreign-key edges (post `[tenantId, authorId]`
 * → author `[tenantId, id]`) run the SAME payload through V1 and, via the
 * V2-routed proxy, through V2 (tx and forced batch), FRESH instances per arm,
 * asserting byte-identical persisted state + result + error. Every root op
 * (update/delete/upsert) is located by a compound where-unique; the nested
 * connect/disconnect writes every FK column per-field (ATOM §1's multi-field
 * produces). The two-tenants-share-id scenarios are the correctness pin: a
 * single-column correlation would leak or clobber the other tenant's row.
 */

class BatchOnlyPGliteDriver extends PGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    return this.transaction(client, async (transaction) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries) {
        results.push(
          await this.executeRaw<T>(transaction, query.sql, query.params)
        );
      }
      return results;
    });
  }
}

type RoutedModel = Record<string, (args: Record<string, unknown>) => unknown>;

interface ErrorShape {
  name: string;
  code?: string | number;
  message: string;
}

interface Scenario {
  name: string;
  seed?: (client: ReturnType<typeof makeClient>) => PromiseLike<unknown>;
  act: (client: Record<string, RoutedModel>) => unknown;
  expectReject?: boolean;
}

function makeClient(db: PGlite) {
  return createClient({
    schema: compoundKeyBehaviorSchema,
    driver: new PGliteDriver({ client: db }),
  });
}

function normalizeError(error: unknown): ErrorShape {
  if (!(error instanceof Error)) throw error;
  const code = "code" in error ? (error as { code?: unknown }).code : undefined;
  const stable =
    typeof code === "string" || typeof code === "number" ? code : undefined;
  return stable === undefined
    ? { name: error.name, message: error.message }
    : { name: error.name, code: stable, message: error.message };
}

async function dump(client: ReturnType<typeof makeClient>) {
  const [authors, posts, accounts] = await Promise.all([
    client.author.findMany({ orderBy: [{ tenantId: "asc" }, { id: "asc" }] }),
    client.post.findMany({ orderBy: { id: "asc" } }),
    client.account.findMany({ orderBy: { id: "asc" } }),
  ]);
  return { authors, posts, accounts };
}

type ArmKind = "v1" | "v2-tx" | "v2-batch";

async function runArm(kind: ArmKind, scenario: Scenario) {
  const db = new PGlite();
  const client = makeClient(db);
  await push(client, { force: true });
  await scenario.seed?.(client);

  let result: unknown;
  let error: ErrorShape | undefined;
  let routes: { engine: "v1" | "v2" }[] = [];
  try {
    if (kind === "v1") {
      result = await scenario.act(
        client as unknown as Record<string, RoutedModel>
      );
    } else {
      const driver =
        kind === "v2-tx"
          ? new PGliteDriver({ client: db })
          : new BatchOnlyPGliteDriver({ client: db });
      const routed = createV2RoutedClient({
        schema: compoundKeyBehaviorSchema,
        client: client as unknown as Record<string, RoutedModel>,
        driver,
      });
      routes = routed.routes;
      result = await scenario.act(routed.client);
    }
  } catch (thrown) {
    error = normalizeError(thrown);
  }
  const routedToV2 =
    routes.length > 0 && routes.every((r) => r.engine === "v2");
  const state = await dump(client);
  await client.$disconnect();
  return { result, error, state, routedToV2 };
}

const twoTenants = async (client: ReturnType<typeof makeClient>) => {
  await client.author.create({
    data: { tenantId: "t1", id: "a1", name: "Alice" },
  });
  await client.author.create({
    data: { tenantId: "t2", id: "a1", name: "Alicia" },
  });
};

const scenarios: Scenario[] = [
  {
    name: "update by compound id targets only that tenant's row",
    seed: twoTenants,
    act: (c) =>
      c.author!.update!({
        where: { tenantId_id: { tenantId: "t1", id: "a1" } },
        data: { name: "Alice Updated" },
      }),
  },
  {
    name: "delete by compound id targets only that tenant's row",
    seed: twoTenants,
    act: (c) =>
      c.author!.delete!({
        where: { tenantId_id: { tenantId: "t1", id: "a1" } },
        select: { tenantId: true, id: true, name: true },
      }),
  },
  {
    name: "update of a missing compound id rejects",
    expectReject: true,
    seed: twoTenants,
    act: (c) =>
      c.author!.update!({
        where: { tenantId_id: { tenantId: "t3", id: "a1" } },
        data: { name: "nope" },
      }),
  },
  {
    name: "upsert by compound id creates the missing row",
    act: (c) =>
      c.author!.upsert!({
        where: { tenantId_id: { tenantId: "t1", id: "a1" } },
        create: { tenantId: "t1", id: "a1", name: "Created" },
        update: { name: "Updated" },
      }),
  },
  {
    name: "upsert by compound id updates the present row",
    seed: (c) =>
      c.author.create({ data: { tenantId: "t1", id: "a1", name: "Original" } }),
    act: (c) =>
      c.author!.upsert!({
        where: { tenantId_id: { tenantId: "t1", id: "a1" } },
        create: { tenantId: "t1", id: "a1", name: "Created" },
        update: { name: "Updated" },
      }),
  },
  {
    name: "nested connect writes every compound FK column from the compound parent",
    seed: async (c) => {
      await twoTenants(c);
      await c.post.create({
        data: { id: "p1", title: "Orphan", tenantId: null, authorId: null },
      });
    },
    act: (c) =>
      c.author!.update!({
        where: { tenantId_id: { tenantId: "t1", id: "a1" } },
        data: { posts: { connect: { id: "p1" } } },
      }),
  },
  {
    name: "nested connect from the other tenant writes that tenant's compound FK",
    seed: async (c) => {
      await twoTenants(c);
      await c.post.create({
        data: { id: "p1", title: "Orphan", tenantId: null, authorId: null },
      });
    },
    act: (c) =>
      c.author!.update!({
        where: { tenantId_id: { tenantId: "t2", id: "a1" } },
        data: { posts: { connect: { id: "p1" } } },
      }),
  },
  {
    name: "nested disconnect nulls every compound FK column, parent-correlated",
    seed: async (c) => {
      await c.author.create({
        data: {
          tenantId: "t1",
          id: "a1",
          name: "Alice",
          posts: { create: { id: "p1", title: "Hers" } },
        },
      });
    },
    act: (c) =>
      c.author!.update!({
        where: { tenantId_id: { tenantId: "t1", id: "a1" } },
        data: { posts: { disconnect: { id: "p1" } } },
      }),
  },
  {
    name: "account update by compound unique (non-PK) targets the right row",
    seed: async (c) => {
      await c.account.create({
        data: { id: "acc-1", provider: "github", providerId: "u1" },
      });
      await c.account.create({
        data: { id: "acc-2", provider: "gitlab", providerId: "u1" },
      });
    },
    act: (c) =>
      c.account!.update!({
        where: {
          provider_providerId: { provider: "github", providerId: "u1" },
        },
        data: { providerId: "u1-renamed" },
      }),
  },
];

describe("query-engine-v2 compound-key dual-run oracle (V1 vs V2)", () => {
  for (const scenario of scenarios) {
    test(scenario.name, { timeout: 30_000 }, async () => {
      const v1 = await runArm("v1", scenario);
      const tx = await runArm("v2-tx", scenario);
      const batch = await runArm("v2-batch", scenario);

      expect(tx.routedToV2).toBe(true);
      expect(batch.routedToV2).toBe(true);

      expect(tx.error).toEqual(v1.error);
      expect(batch.error).toEqual(v1.error);
      expect(Boolean(v1.error)).toBe(scenario.expectReject === true);

      if (!scenario.expectReject) {
        expect(tx.result).toEqual(v1.result);
        expect(batch.result).toEqual(v1.result);
      }

      expect(tx.state).toEqual(v1.state);
      expect(batch.state).toEqual(v1.state);
    });
  }
});
