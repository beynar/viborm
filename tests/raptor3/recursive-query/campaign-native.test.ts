/**
 * RQ-06 — the 300 saved recursive cases on native PostgreSQL or MySQL, through
 * the shipped client. Run once per provider profile, gated on the live-provider
 * environment exactly like `provider-sql-native.test.ts`
 * (`VIBORM_RAPTOR3_PROVIDER=pg|mysql`, `VIBORM_RAPTOR3_PROVIDER_PORT`).
 *
 * The same saved cases, the same admitted schema, the same public read and the
 * same verdict as `campaign-sqlite.test.ts` (`campaign-harness.ts`); only the
 * provider changes. Each profile is one cell and one fresh live world (its own
 * namespace): the provider-neutral tables in native DDL, the profile's 100 cases
 * as the world's initial rows, then ONE public `findMany` per case. A statement
 * is attributed to a case by the world's own completion order; a statement the
 * provider never completed fails the cell. A failing seed is minimized inside
 * the same world (fresh seed keys, raw rows through the driver) before the cell
 * fails. With `VIBORM_RAPTOR3_EVIDENCE_DIRECTORY` set, the file writes the
 * replayable receipt `rq6-campaign-<pg|mysql>.json` there.
 */

import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { afterAll, describe, it } from "vitest";
import {
  type LiveBarrier,
  type LiveFixture,
  type LiveNames,
  liveProvider,
  runLiveWorld,
} from "../transitions/live-world";
import {
  CAMPAIGN_PROFILES,
  type CaseObservation,
  type CaseVerdict,
  campaignSchema,
  failureReport,
  findManyOn,
  judgeCase,
  type MinimizedFailure,
  materialize,
  materializeAll,
  minimizeFailures,
  observeOperation,
  PROFILE_WORLDS,
  profileCases,
  publicArgs,
  recordCampaignReceipt,
} from "./campaign-harness";
import {
  RQ06_FIXED_CASES,
  RQ06_FIXED_CORPUS_IDENTITY,
  recursiveCorpusIdentity,
} from "./fixed-cases";
import type { RecursiveGraphCase, RecursiveProfile } from "./graph-oracle";
import { type ColumnType, columnDefinitions } from "./provider-sql-fixture";

const NATIVE_TYPES: Readonly<Record<ColumnType, string>> = {
  integer: "INTEGER",
  text: liveProvider === "pg" ? "TEXT" : "VARCHAR(191)",
  boolean: "BOOLEAN",
  json: liveProvider === "pg" ? "JSONB" : "JSON",
};

const verdicts: CaseVerdict[] = [];
const minimized: MinimizedFailure[] = [];
const provider: Record<string, string> = { provider: liveProvider };

afterAll(() => {
  const path = recordCampaignReceipt(
    liveProvider,
    provider,
    `one vitest invocation of campaign-native.test.ts on ${liveProvider}; one cell and one live world (fresh namespace) per profile`,
    verdicts,
    minimized
  );
  if (path) process.stdout.write(`RQ-06 ${liveProvider} receipt: ${path}\n`);
});

/** The provider's own version string, read once through the world's driver. */
async function providerVersion(driver: AnyDriver): Promise<string> {
  try {
    const response = await driver._executeRaw<{ version: unknown }>(
      liveProvider === "pg"
        ? "SELECT version() AS version"
        : "SELECT VERSION() AS version"
    );
    return String(response.rows[0]?.version);
  } catch (failure) {
    return `unknown (${failure instanceof Error ? failure.name : "failure"})`;
  }
}

/** One case's candidate rows, inserted raw into the world's own tables. */
async function insertCandidate(
  driver: AnyDriver,
  names: LiveNames,
  testCase: RecursiveGraphCase,
  seed: number
): Promise<void> {
  for (const [table, rows] of Object.entries(materialize(testCase, seed)))
    for (const row of rows) {
      const columns = Object.keys(row);
      const placeholders = columns.map((_, index) =>
        liveProvider === "pg" ? `$${index + 1}` : "?"
      );
      await driver._executeRaw(
        `INSERT INTO ${names.table(table)} (${columns
          .map((column) => names.quote(column))
          .join(",")}) VALUES (${placeholders.join(",")})`,
        columns.map((column) => row[column])
      );
    }
}

interface ExecutedCase {
  readonly testCase: RecursiveGraphCase;
  readonly observed: CaseObservation;
  /** The number of completed statements before and after this case. */
  readonly from: number;
  readonly to: number;
}

/**
 * Execute one profile's saved cases in a fresh live world, minimizing every
 * failing seed inside it; the verdicts go to the caller's cell.
 */
async function runProfile(profile: RecursiveProfile): Promise<{
  readonly verdicts: readonly CaseVerdict[];
  readonly incomplete: readonly string[];
}> {
  const world = PROFILE_WORLDS[profile];
  const cases = profileCases(profile);
  const rows = materializeAll(cases);
  // Every completed provider statement's SQL, in completion order: the world
  // hands its barrier each completion as it happens, so a case's statements
  // are readable inside the world (the minimizer judges with them) and are the
  // same sequence as `live.completions` afterwards.
  const completedSql: string[] = [];
  const recordCompletion: LiveBarrier = async (completion) => {
    completedSql.push(completion.statement.sql);
    return undefined;
  };
  let names: LiveNames | undefined;
  const executed: ExecutedCase[] = [];
  const profileMinimized: MinimizedFailure[] = [];
  const fixture: LiveFixture = {
    initial: Object.fromEntries(
      world.tables.map((table) => [
        table.name,
        (rows[table.name] ?? []).map((row) => ({ ...row })),
      ])
    ),
    tables: Object.fromEntries(
      world.tables.map((table) => [
        table.name,
        { name: table.name, order: table.primaryKey },
      ])
    ),
    async invoke(driver) {
      const client = createClient({ schema: campaignSchema, driver });
      provider[`${liveProvider}-server`] ??= await providerVersion(driver);
      for (const testCase of cases) {
        const from = completedSql.length;
        const observed = await observeOperation(() =>
          findManyOn(client, world.model, publicArgs(testCase))
        );
        executed.push({ testCase, observed, from, to: completedSql.length });
      }
      // Minimize every failing seed here, while its world still exists.
      if (names === undefined)
        throw new Error("the live world names its tables before invoking");
      const liveNames = names;
      profileMinimized.push(
        ...(await minimizeFailures(
          executed.map(({ testCase }) => testCase),
          executed.map(({ testCase, observed, from, to }) =>
            judgeCase(testCase, observed, completedSql.slice(from, to))
          ),
          {
            insert: (candidate, seed) =>
              insertCandidate(driver, liveNames, candidate, seed),
            statements: () => completedSql,
            client,
            model: world.model,
          }
        ))
      );
      return executed.length;
    },
    // The cell judges the run; the world itself only has to have answered.
    assert(observation) {
      if (observation.outcome.kind !== "success")
        throw new Error("the campaign world did not answer");
    },
  };
  const live = await runLiveWorld(
    fixture,
    (liveNames) => {
      names = liveNames;
      return Object.fromEntries(
        world.tables.map((table) => [
          table.name,
          columnDefinitions(table, NATIVE_TYPES, (identifier) =>
            liveNames.quote(identifier)
          ),
        ])
      );
    },
    undefined,
    "interactive",
    recordCompletion
  );
  if (live.terminalFailure !== undefined) throw live.terminalFailure;
  fixture.assert(live.observation);
  // Completions are sequential and the barrier recorded each one in order, so
  // a case's statements are the completions between its two readings.
  const profileVerdicts = executed.map(({ testCase, observed, from, to }) =>
    judgeCase(
      testCase,
      observed,
      live.completions
        .slice(from, to)
        .map((completion) => completion.statement.sql)
    )
  );
  verdicts.push(...profileVerdicts);
  minimized.push(
    ...profileMinimized.map((entry) => ({
      ...entry,
      verdict:
        profileVerdicts.find((verdict) => verdict.caseId === entry.caseId) ??
        entry.verdict,
    }))
  );
  live.assertHealthy();
  return {
    verdicts: profileVerdicts,
    incomplete: live.statements
      .filter((statement) => !statement.completed)
      .map((statement) => statement.sql.slice(0, 120)),
  };
}

describe(`RQ-06 saved recursive cases on native ${liveProvider}`, () => {
  it("executes exactly the reconciled corpus", () => {
    assert.deepEqual(
      recursiveCorpusIdentity(RQ06_FIXED_CASES),
      RQ06_FIXED_CORPUS_IDENTITY
    );
    for (const profile of CAMPAIGN_PROFILES)
      assert.equal(profileCases(profile).length, 100, profile);
  });

  for (const profile of CAMPAIGN_PROFILES)
    it(`${profile}: 100 saved cases, one public read each, against the oracle`, async () => {
      const executed = await runProfile(profile);
      assert.deepEqual(
        executed.incomplete,
        [],
        "a statement the provider never completed"
      );
      const failed = executed.verdicts.filter((verdict) => !verdict.match);
      assert.equal(
        failed.length,
        0,
        `${failed.length} of ${executed.verdicts.length} ${profile} seeds failed on ${liveProvider}:\n${failureReport(
          failed,
          minimized
        )}`
      );
      assert.equal(executed.verdicts.length, 100);
    }, 120_000);
});
