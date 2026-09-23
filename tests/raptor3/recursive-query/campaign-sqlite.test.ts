/**
 * RQ-06 — the 300 saved recursive cases on SQLite, through the shipped client.
 *
 * Each profile is one cell and one in-memory database: the admitted schema's
 * own tables (created from that schema by the migration owner), the profile's
 * 100 cases materialised under their seeds, then ONE public `findMany` per case
 * judged against the independent oracle (`campaign-harness.ts`). A failing
 * seed is minimized on the same database before the cell fails, and the cell's
 * message names every failing seed, its smallest failing graph and the owner
 * it points at. With `VIBORM_RAPTOR3_EVIDENCE_DIRECTORY` set, the file writes
 * the replayable receipt `rq6-campaign-sqlite.json` there.
 *
 * The CM002 reconciliation is pinned here too: the corpus executes no required
 * singular case, and the schema such a case would need is refused before any
 * projection is prepared — the oracle's `required-singular-missing` outcome is
 * oracle-only.
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import type { QueryResult } from "@drivers/types";
import { SchemaValidationError } from "@schema/validation";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { afterAll, describe, it } from "vitest";
import {
  CAMPAIGN_PROFILES,
  type CampaignRow,
  type CaseVerdict,
  campaignSchema,
  failureReport,
  findManyOn,
  judgeCase,
  judgeOutcome,
  type MinimizedFailure,
  materialize,
  materializeAll,
  minimizeFailingCase,
  minimizeFailures,
  observeOperation,
  PROFILE_WORLDS,
  profileCases,
  publicArgs,
  recordCampaignReceipt,
  requiredSingularSchema,
  requireExecutable,
} from "./campaign-harness";
import {
  RQ06_FIXED_CASES,
  RQ06_FIXED_CORPUS_IDENTITY,
  recursiveCorpusIdentity,
} from "./fixed-cases";
import {
  evaluateRecursiveCase,
  type RecursiveGraphCase,
  type RecursiveProfile,
} from "./graph-oracle";

const LOWERING_OR_DECODING = /recursive lowering or carrier decoding/;
const SIBLING_ORDER = /sibling order/;

/**
 * Every statement the provider received. The stock batch path runs its members
 * through `execute` too, so this one hook sees batched statements as well.
 */
class CampaignSQLiteDriver extends SQLite3Driver {
  readonly statements: string[] = [];

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[]
  ): Promise<QueryResult<T>> {
    this.statements.push(statement);
    return super.execute<T>(client, statement, parameters);
  }
}

/** Raw rows into the admitted tables; every stored reference must resolve. */
function insertRows(
  database: Database.Database,
  rows: Readonly<Record<string, readonly CampaignRow[]>>
): void {
  // Rings and cycles are legal data for a nullable reference; they are simply
  // not insertable one row at a time under immediate checking.
  database.pragma("foreign_keys = OFF");
  try {
    database.transaction(() => {
      for (const [table, tableRows] of Object.entries(rows))
        for (const row of tableRows) {
          const columns = Object.keys(row);
          database
            .prepare(
              `INSERT INTO "${table}"(${columns
                .map((column) => `"${column}"`)
                .join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`
            )
            // better-sqlite3 binds no booleans: SQLite's physical spelling.
            .run(
              ...columns.map((column) => {
                const value = row[column];
                return typeof value === "boolean" ? Number(value) : value;
              })
            );
        }
    })();
  } finally {
    database.pragma("foreign_keys = ON");
  }
  const dangling = database.pragma("foreign_key_check");
  if (Array.isArray(dangling) && dangling.length > 0)
    throw new Error(
      `Unresolved stored references: ${JSON.stringify(dangling)}`
    );
}

async function openProfileWorld(cases: readonly RecursiveGraphCase[]) {
  const database = new Database(":memory:");
  const driver = new CampaignSQLiteDriver({ client: database });
  const client = createClient({ schema: campaignSchema, driver });
  if (!(await syncLiveSchema(client)).applied)
    throw new Error("the admitted schema was not applied");
  insertRows(database, materializeAll(cases));
  driver.statements.length = 0;
  return {
    client,
    database,
    driver,
    async close() {
      await client.$disconnect();
      database.close();
    },
  };
}

const verdicts: CaseVerdict[] = [];
const minimized: MinimizedFailure[] = [];
const provider: Record<string, string> = {
  provider: "sqlite",
  "better-sqlite3": String(
    createRequire(import.meta.url)("better-sqlite3/package.json").version
  ),
};

afterAll(() => {
  const path = recordCampaignReceipt(
    "sqlite",
    provider,
    "one vitest invocation of campaign-sqlite.test.ts; one cell and one in-memory database per profile",
    verdicts,
    minimized
  );
  if (path) process.stdout.write(`RQ-06 SQLite receipt: ${path}\n`);
});

describe("RQ-06 saved recursive cases on SQLite", () => {
  it("executes exactly the reconciled corpus, in the admitted schema's own tables", async () => {
    assert.deepEqual(
      recursiveCorpusIdentity(RQ06_FIXED_CASES),
      RQ06_FIXED_CORPUS_IDENTITY
    );
    assert.equal(RQ06_FIXED_CASES.length, 300);
    for (const profile of CAMPAIGN_PROFILES)
      assert.equal(profileCases(profile).length, 100, profile);
    // No executed case is oracle-only: every one is expressible in the admitted
    // schema, and its expected outcome is rows or the attributed FK cycle.
    for (const testCase of RQ06_FIXED_CASES) {
      requireExecutable(testCase);
      const expected = evaluateRecursiveCase(testCase);
      assert(
        expected.kind === "rows" || expected.error.kind === "fk-cycle",
        testCase.caseId
      );
    }
    // The provider-neutral tables the native lanes spell in DDL ARE the
    // admitted schema's tables: same columns, same nullability, same key.
    const { database, close } = await openProfileWorld(RQ06_FIXED_CASES);
    try {
      for (const profile of CAMPAIGN_PROFILES)
        for (const table of PROFILE_WORLDS[profile].tables) {
          const columns = database
            .prepare(`SELECT name, "notnull", pk FROM pragma_table_info(?)`)
            .all(table.name) as {
            name: string;
            notnull: number;
            pk: number;
          }[];
          assert.deepEqual(
            columns.map((column) => [column.name, column.notnull === 0]),
            table.columns.map((column) => [
              column.name,
              column.nullable === true,
            ]),
            table.name
          );
          assert.deepEqual(
            columns
              .filter((column) => column.pk > 0)
              .sort((left, right) => left.pk - right.pk)
              .map((column) => column.name),
            table.primaryKey,
            table.name
          );
        }
    } finally {
      await close();
    }
  });

  it("refuses the schema a required singular case needs before any projection (CM002)", () => {
    const database = new Database(":memory:");
    const driver = new CampaignSQLiteDriver({ client: database });
    let refusal: unknown;
    try {
      createClient({ schema: requiredSingularSchema(), driver });
    } catch (failure) {
      refusal = failure;
    }
    database.close();
    assert(refusal instanceof SchemaValidationError, String(refusal));
    assert.deepEqual(
      refusal.issues.map((issue) => [issue.code, issue.message]),
      [["CM002", "Circular required relations: singularNode → singularNode"]]
    );
    assert.deepEqual(driver.statements, []);
    // The oracle alone can still state a required case; that outcome is
    // oracle-only and no executed seed reaches it.
    const [chain] = profileCases("singular-fk");
    assert(chain);
    assert.deepEqual(
      evaluateRecursiveCase({
        ...chain,
        singularMayBeEmpty: false,
        edges: [],
        roots: ["n0"],
      }),
      {
        kind: "error",
        error: {
          kind: "required-singular-missing",
          relation: "parent",
          source: "n0",
        },
      }
    );
  });

  it("minimizes a failing case to a graph no single deletion still fails (harness self-test)", async () => {
    // A junction case with seven nodes; the synthetic failure is "n6 is
    // reachable from a root", so a 1-minimal failing graph is one root path.
    const source = profileCases("junction").find(
      (testCase) => testCase.nodes.length === 7
    );
    assert(source);
    const reachesN6 = (candidate: RecursiveGraphCase): boolean => {
      const seen = new Set(candidate.roots);
      const pending = [...candidate.roots];
      while (pending.length > 0) {
        const from = pending.pop();
        for (const edge of candidate.edges)
          if (edge.from === from && !seen.has(edge.to)) {
            seen.add(edge.to);
            pending.push(edge.to);
          }
      }
      return seen.has("n6");
    };
    assert(reachesN6(source));
    let attempts = 0;
    const small = await minimizeFailingCase(source, async (candidate) => {
      attempts += 1;
      requireExecutable(candidate);
      return reachesN6(candidate);
    });
    assert(reachesN6(small));
    assert(attempts > 0);
    // One root, and exactly one simple path to n6: nodes = edges + 1.
    assert.equal(small.roots.length, 1);
    assert.equal(small.nodes.length, small.edges.length + 1);
    await minimizeFailingCase(small, async (candidate) => {
      assert.equal(reachesN6(candidate), false, "a deletion still failed");
      return false;
    });
  });

  for (const profile of CAMPAIGN_PROFILES)
    it(`${profile}: 100 saved cases, one public read each, against the oracle`, async () => {
      const executed = await runProfile(profile);
      const failed = executed.filter((verdict) => !verdict.match);
      assert.equal(
        failed.length,
        0,
        `${failed.length} of ${executed.length} ${profile} seeds failed:\n${failureReport(
          failed,
          minimized
        )}`
      );
      assert.equal(executed.length, 100);
    }, 60_000);

  it("names lowering or decoding, not sibling order, for a difference canonical JSON cannot see", () => {
    // A symbol-keyed member is invisible to canonical JSON, so the sorted
    // copies compare equal; before the guard in `orderOnly` that misattributed
    // the mismatch to sibling order (RQ-06 re-check, campaign-harness.ts).
    const testCase = RQ06_FIXED_CASES.find(
      (entry) =>
        entry.profile === "collection-fk" &&
        evaluateRecursiveCase(entry).kind === "rows"
    );
    assert.ok(testCase);
    const oracle = evaluateRecursiveCase(testCase);
    assert.equal(oracle.kind, "rows");
    if (oracle.kind !== "rows") return;
    const actual = structuredClone([...oracle.rows]) as unknown as Record<
      string | symbol,
      unknown
    >[];
    assert.ok(actual.length > 0);
    actual[0]![Symbol("hidden")] = true;
    const verdict = judgeOutcome(testCase, { kind: "value", value: actual });
    assert.ok(verdict.mismatch, "a symbol key is a difference");
    assert.match(verdict.owner ?? "", LOWERING_OR_DECODING);
    assert.doesNotMatch(verdict.owner ?? "", SIBLING_ORDER);
  });
});

/**
 * Execute one profile's saved cases on a fresh database, then minimize every
 * failing seed on that same database; the verdicts go to the caller's cell.
 */
async function runProfile(
  profile: RecursiveProfile
): Promise<readonly CaseVerdict[]> {
  const cases = profileCases(profile);
  const { model } = PROFILE_WORLDS[profile];
  const world = await openProfileWorld(cases);
  const { client, database, driver } = world;
  try {
    provider.sqlite ??= String(
      (
        database.prepare("SELECT sqlite_version() AS version").get() as {
          version: string;
        }
      ).version
    );
    const profileVerdicts: CaseVerdict[] = [];
    for (const testCase of cases) {
      const start = driver.statements.length;
      const observed = await observeOperation(() =>
        findManyOn(client, model, publicArgs(testCase))
      );
      profileVerdicts.push(
        judgeCase(testCase, observed, driver.statements.slice(start))
      );
    }
    verdicts.push(...profileVerdicts);
    minimized.push(
      ...(await minimizeFailures(cases, profileVerdicts, {
        insert: (candidate, seed) =>
          insertRows(database, materialize(candidate, seed)),
        statements: () => driver.statements,
        client,
        model,
      }))
    );
    return profileVerdicts;
  } finally {
    await world.close();
  }
}
