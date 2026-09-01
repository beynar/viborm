// Shared harness for the nested-write conformance oracle.
//
// The conformance estate runs every scenario twice — once on the transaction
// substrate (`PGliteDriver`) and once on the forced atomic-batch substrate
// (`BatchOnlyPGliteDriver`) — and asserts byte-identical persisted state. The
// two substrates are two DRIVERS, not two databases: both ride the worker's one
// PGlite in the group's private Postgres schema, and the schema family truncates
// between them so each run starts from the empty tables the other was given.
// The oracle lives in several sibling `nested-write-conformance-*.test.ts`
// files, each owning a coherent slice of the scenario table, and this module
// owns the machinery all of them share.

import { createClient, type VibORMClient } from "@client/client";
import type { Schema } from "@client/types";
import { PGliteDriver } from "@drivers/pglite";
import {
  BatchOnlyPGliteDriver,
  usePGliteSchemaFamily,
} from "@tests/fixtures/drivers/pglite";
import type { nestedWriteBehaviorSchema } from "@tests/fixtures/nested-write-behavior-schema";
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
  driver: PGliteDriver
): Promise<Outcome> {
  const client = createClient({ schema: group.schema, driver });
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
    // The database underneath is BORROWED from the schema family, so this
    // releases the run's own client and leaves the worker's PGlite open for the
    // other substrate and every later suite in the process.
    await client.$disconnect();
  }
}

export function registerGroup<TSchema extends Schema>(
  title: string,
  group: SchemaGroup<TSchema>
): void {
  describe(title, () => {
    // ONE PGlite for the whole worker; this group takes a private Postgres
    // schema in it. Both substrates are drivers built over that same database,
    // so each MUST carry the family's namespace — without it a driver addresses
    // `public`, where this group has no tables at all.
    const getFamily = usePGliteSchemaFamily(group.schema);

    for (const scenario of group.scenarios) {
      // A scenario runs its whole act twice against a live database, and the
      // groups sharing this worker run one after another; well over the default
      // 5s timeout.
      test(scenario.name, { timeout: 30_000 }, async () => {
        const family = getFamily();
        const driverOptions = {
          client: family.database,
          namespace: family.namespace,
        };
        const transaction = await runScenario(
          group,
          scenario,
          new PGliteDriver(driverOptions)
        );
        // The two substrates run one after the other in the SAME schema, so the
        // batch run starts from the empty tables the transaction run was given.
        await family.reset();
        const batch = await runScenario(
          group,
          scenario,
          new BatchOnlyPGliteDriver(driverOptions)
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
