/**
 * `findUnique` batching and the caller's async context (1.4.1).
 *
 * The driver here picks its database from the caller's `AsyncLocalStorage`,
 * as a per-request tenant router would, and takes no single-connection queue
 * (whose drainer runs queued work in its own context). In 1.4.0 the one read a
 * batch shared ran in the context of the first call of the tick, on any
 * client: another tenant's call, or another client's, read the first one's
 * database. Batching is now opt-in, and a batch's read runs in its own
 * leader's context.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createClient } from "@client/client";
import type { QueryExecutionContext } from "@drivers/driver";
import { PGliteDriver } from "@drivers/pglite";
import type { QueryResult } from "@drivers/types";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterAll, beforeAll, expect, test } from "vitest";

const member = s
  .model({ id: s.int().id(), name: s.string() })
  .map("fubc_members");
const schema = { member };

const tenant = new AsyncLocalStorage<string>();
const TENANTS = ["acme", "globex"] as const;
const databases = new Map<string, PGlite>();

/** A pool-like router: each statement goes to the caller's tenant database. */
class TenantRoutedDriver extends PGliteDriver {
  constructor(options: ConstructorParameters<typeof PGliteDriver>[0]) {
    super(options);
    // No single-connection queue: PGlite's types pin it on, a pool has none.
    Object.defineProperty(this, "serializeTransactions", { value: false });
  }
  protected override execute<T>(
    _client: PGlite | Transaction,
    statement: string,
    parameters: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const database = databases.get(tenant.getStore() ?? "acme")!;
    return super.execute<T>(database, statement, parameters, context);
  }
}

beforeAll(async () => {
  for (const name of TENANTS) {
    const database = new PGlite();
    databases.set(name, database);
    const client = createClient({
      schema,
      driver: new PGliteDriver({ client: database }),
    });
    await syncLiveSchema(client);
    await client.member.createMany({
      data: [
        { id: 1, name: `${name} one` },
        { id: 2, name: `${name} two` },
      ],
    });
  }
});
afterAll(async () => {
  for (const database of databases.values()) await database.close();
});

const routedClient = (findUniqueBatching?: boolean) =>
  createClient({
    schema,
    driver: new TenantRoutedDriver({ client: databases.get("acme")! }),
    ...(findUniqueBatching === undefined ? {} : { findUniqueBatching }),
  });

/** Each tenant's request reads ids 1 and 2 on `clientOf(tenant)`, in one tick. */
async function sameTick(clientOf: (name: (typeof TENANTS)[number]) => any) {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const requests = TENANTS.map((name) =>
    tenant.run(name, async () => {
      await opened;
      const rows = await Promise.all(
        [1, 2].map((id) => clientOf(name).member.findUnique({ where: { id } }))
      );
      return rows.map((row: { name: string } | null) => row?.name);
    })
  );
  open();
  return Promise.all(requests);
}

test("without findUniqueBatching, every call reads its own tenant", async () => {
  const db = routedClient();
  expect(await sameTick(() => db)).toEqual([
    ["acme one", "acme two"],
    ["globex one", "globex two"],
  ]);
});

test("a batch reads in its own leader's context, not another client's", async () => {
  const clients = new Map(TENANTS.map((name) => [name, routedClient(true)]));
  expect(await sameTick((name) => clients.get(name))).toEqual([
    ["acme one", "acme two"],
    ["globex one", "globex two"],
  ]);
});
