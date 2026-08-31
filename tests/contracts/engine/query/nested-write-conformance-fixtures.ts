// Shared harness for the nested-write conformance oracle.
//
// The conformance estate runs every scenario twice — once on the transaction
// substrate (`PGliteDriver`) and once on the forced atomic-batch substrate
// (`BatchOnlyPGliteDriver`) — and asserts byte-identical persisted state. Each
// run opens its OWN PGlite database, so a single test costs two databases and a
// file's peak RSS tracks its scenario count. The oracle therefore lives in
// several sibling `nested-write-conformance-*.test.ts` files, each owning a
// coherent slice of the scenario table, and this module owns the machinery all
// of them share.

import { createClient, type VibORMClient } from "@client/client";
import type { Schema } from "@client/types";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import type { nestedWriteBehaviorSchema } from "@tests/fixtures/nested-write-behavior-schema";
import {
  closeTestPGlite,
  openTestPGlite,
} from "@tests/fixtures/pglite-lifecycle";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { describe, expect, test } from "vitest";

export type SchemaClient<TSchema extends Schema> = VibORMClient<{
  schema: TSchema;
  driver: PGliteDriver;
}>;

export type PersistedState = Record<string, unknown[]>;

// The observable result of running a scenario on one mode: whether the act
// rejected, plus the persisted state afterwards.
interface ErrorOutcome {
  name: string;
  code?: string | number;
  message: string;
}

interface Outcome {
  rejected: boolean;
  error?: ErrorOutcome;
  state: PersistedState;
}

export interface Scenario<TSchema extends Schema> {
  name: string;
  seed?: (client: SchemaClient<TSchema>) => PromiseLike<unknown>;
  act: (client: SchemaClient<TSchema>) => PromiseLike<unknown>;
  // If set, the act is expected to reject in both modes. State must still be
  // byte-identical across modes and equal to `expected` (rolled-back state).
  expectReject?: boolean;
  expectedError?: string;
  expected: PersistedState;
}

interface SchemaGroup<TSchema extends Schema> {
  schema: TSchema;
  // Dump every table in a stable order so tx-vs-batch state is comparable.
  dump: (client: SchemaClient<TSchema>) => Promise<PersistedState>;
  scenarios: Scenario<TSchema>[];
}

function normalizeErrorOutcome(error: unknown): ErrorOutcome {
  if (!(error instanceof Error)) throw error;
  const code = "code" in error ? error.code : undefined;
  const stableCode =
    typeof code === "string" || typeof code === "number" ? code : undefined;
  return stableCode === undefined
    ? { name: error.name, message: error.message }
    : { name: error.name, code: stableCode, message: error.message };
}

async function runScenario<TSchema extends Schema>(
  group: SchemaGroup<TSchema>,
  scenario: Scenario<TSchema>,
  createDriver: (db: PGlite) => PGliteDriver
): Promise<Outcome> {
  const db = openTestPGlite();
  const setupClient = createClient({
    schema: group.schema,
    driver: new PGliteDriver({ client: db }),
  });
  await syncLiveSchema(setupClient);

  const client = createClient({
    schema: group.schema,
    driver: createDriver(db),
  });
  try {
    // Seed stays OUTSIDE the act try/catch (a seed failure is a test error, not a
    // scenario reject).
    await scenario.seed?.(client);
    let rejected = false;
    let errorOutcome: ErrorOutcome | undefined;
    try {
      await scenario.act(client);
    } catch (error) {
      rejected = true;
      errorOutcome = normalizeErrorOutcome(error);
    }
    return {
      rejected,
      error: errorOutcome,
      state: await group.dump(client),
    };
  } finally {
    await client.$disconnect();
    // Disconnecting a client does NOT release a borrowed Wasm database (see
    // pglite-lifecycle.ts). This harness opens one per scenario per mode, so
    // without an explicit close every instance the file ever booted stays
    // resident at once.
    await closeTestPGlite(db);
  }
}

export function registerGroup<TSchema extends Schema>(
  title: string,
  group: SchemaGroup<TSchema>
): void {
  describe(title, () => {
    for (const scenario of group.scenarios) {
      // Each scenario boots two PGlite instances; well over the default 5s
      // timeout when the full suite runs in parallel.
      test(scenario.name, { timeout: 30_000 }, async () => {
        const transaction = await runScenario(
          group,
          scenario,
          (db) => new PGliteDriver({ client: db })
        );
        const batch = await runScenario(
          group,
          scenario,
          (db) => new BatchOnlyPGliteDriver({ client: db })
        );

        // Both modes must agree on whether the act rejected.
        expect(batch.rejected).toBe(transaction.rejected);
        expect(transaction.rejected).toBe(scenario.expectReject === true);
        // Every rejected scenario must expose the same stable error contract.
        // `expectedError` below is only an additional semantic substring pin.
        expect(batch.error).toEqual(transaction.error);
        if (scenario.expectedError) {
          expect(transaction.error?.message).toContain(scenario.expectedError);
        }
        // The load-bearing oracle assertion: the two substrates persist
        // byte-identical state for the same scenario.
        expect(batch.state).toEqual(transaction.state);
        // Both must also match the intended end state (guards against both
        // engines being wrong the same way).
        expect(transaction.state).toEqual(scenario.expected);
        expect(batch.state).toEqual(scenario.expected);
      });
    }
  });
}

// ---------------------------------------------------------------------------
// The nested-write behavior schema dump, shared by the FK-relation slice and
// the to-one slice.
// user 1—* post (nullable FK), user 1—1 profile, post 1—* postTag *—1 tag.
// ---------------------------------------------------------------------------

export type NestedWriteSchema = typeof nestedWriteBehaviorSchema;

export async function dumpNestedWrite(
  client: SchemaClient<NestedWriteSchema>
): Promise<PersistedState> {
  const [users, posts, profiles, tags, postTags] = await Promise.all([
    client.user.findMany({ orderBy: { id: "asc" } }),
    client.post.findMany({ orderBy: { id: "asc" } }),
    client.profile.findMany({ orderBy: { id: "asc" } }),
    client.tag.findMany({ orderBy: { id: "asc" } }),
    client.postTag.findMany({ orderBy: { id: "asc" } }),
  ]);
  return { users, posts, profiles, tags, postTags };
}
