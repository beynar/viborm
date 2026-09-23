/**
 * ROOT REVIEW — Area C, checklist line C2 ("the six decisions are applied
 * exactly as worded; re-check two by running the cells").
 *
 * Two decisions are re-checked here with cells the decisions unit did NOT
 * write, so agreement is evidence rather than an echo:
 *
 *   D-6   "accept the normalized payload as the contract" — re-asked with an
 *         OPERATOR in the update arm and a DEFAULTED column missing from the
 *         create arm, neither of which the author's cell uses.
 *   R-D2  "adopt (a)" — a decimal primary key under `increment` is the
 *         candidate's contract and the shipped engine's refusal; `decrement`
 *         is checked as the same shape, and `multiply` as the half that must
 *         still answer the shipped sentence on BOTH engines.
 *
 * A decision applied "as worded" has to fail when the behaviour regresses, so
 * each cell asserts the divergence in BOTH directions: what the candidate must
 * answer AND what the shipped engine must answer.
 */

import assert from "node:assert/strict";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCandidateClient } from "@query-engine/raptor3/route/client-route";
import { s } from "@schema";
import { createClient } from "@src/index";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { describe, test } from "vitest";

const account = s
  .model({
    id: s.int().id(),
    email: s.string().unique(),
    name: s.string(),
    score: s.int().default(0),
    tier: s.string().default("bronze"),
  })
  .map("g4rc_accounts");

const ledger = s
  .model({
    id: s.decimal({ precision: 10, scale: 2 }).id(),
    label: s.string(),
  })
  .map("g4rc_ledger");

const schema = { account, ledger };

interface World {
  client: ReturnType<typeof createClient<typeof schema, { driver: SQLite3Driver; schema: typeof schema }>>;
  database: Database.Database;
}

async function world(route: "shipped" | "candidate"): Promise<World> {
  const database = new Database(":memory:");
  const driver = new SQLite3Driver({ client: database });
  const config = { driver, schema };
  const client = (
    route === "shipped" ? createClient(config) : createCandidateClient(config)
  ) as World["client"];
  const migration = await syncLiveSchema(client);
  // biome-ignore lint/suspicious/noMisplacedAssertion: helper called only from cells.
  assert.equal(migration.applied, true, "the world's schema applied");
  database.exec(`
    -- an exact decimal is stored as its scaled coefficient: 10.00 at scale 2.
    INSERT INTO g4rc_ledger (id,label) VALUES ('1000','seed');
  `);
  return { client, database };
}

function applyUnsafe<T extends object>(client: T, definition: unknown): T {
  const extend = Reflect.get(client, "$extends") as CallableFunction;
  return Reflect.apply(extend, client, [definition]) as T;
}

async function close(w: World): Promise<void> {
  await w.client.$disconnect();
  w.database.close();
}

describe("Area C2 — two of Arnaud's decisions, re-checked by cells of my own", () => {
  test("D-6: the upsert interceptor input is the ONE admission (operator arm, defaulted column)", async () => {
    const seenOn = async (route: "shipped" | "candidate") => {
      const w = await world(route);
      const seen: Record<string, unknown>[] = [];
      const client = applyUnsafe(w.client, {
        name: "rootC-upsert-interceptor",
        query: {
          account: {
            upsert({
              input,
              proceed,
            }: {
              input: Record<string, unknown>;
              proceed: () => Promise<unknown>;
            }) {
              seen.push(structuredClone(input));
              return proceed();
            },
          },
        },
      }) as World["client"];
      const call = {
        // `score` and `tier` carry defaults and are ABSENT from the create arm.
        create: { email: "d6@example.test", id: 1, name: "Created" },
        // An OPERATOR, not a bare value: the normalization the decision names.
        update: { score: { increment: 5 } },
        where: { email: "d6@example.test" },
      };
      const created = await client.account.upsert(call);
      const updated = await client.account.upsert(call);
      const rows = w.database
        .prepare("SELECT id,name,score,tier FROM g4rc_accounts ORDER BY id")
        .all();
      await close(w);
      return { created, rows, seen, updated };
    };

    const shipped = await seenOn("shipped");
    const candidate = await seenOn("candidate");

    // biome-ignore lint/suspicious/noConsole: the probe's output IS its receipt.
    console.log(
      [
        "[D-6 re-check]",
        `  shipped   seen ${JSON.stringify(shipped.seen)}`,
        `  candidate seen ${JSON.stringify(candidate.seen)}`,
        `  shipped   rows ${JSON.stringify(shipped.rows)}`,
        `  candidate rows ${JSON.stringify(candidate.rows)}`,
      ].join("\n")
    );

    // The public answers and the committed rows are parity facts.
    assert.deepEqual(candidate.created, shipped.created);
    assert.deepEqual(candidate.updated, shipped.updated);
    assert.deepEqual(candidate.rows, shipped.rows);
    assert.equal(candidate.seen.length, 2);

    // THE DECISION, both directions.
    const create0 = candidate.seen[0]!.create as Record<string, unknown>;
    assert.equal(
      create0.score,
      0,
      "the candidate publishes the DEFAULT filled into the create arm"
    );
    assert.equal(create0.tier, "bronze");
    assert.deepEqual(
      (shipped.seen[0]!.create as Record<string, unknown>).score,
      undefined,
      "the shipped route publishes the caller's raw create arm"
    );
    const update1 = candidate.seen[1]!.update as Record<string, unknown>;
    assert.deepEqual(
      update1.score,
      { increment: 5 },
      "an operator arm stays the operator it is, in the one admission"
    );
  }, 180_000);

  test("R-D2 (a): a decimal primary key under increment/decrement is the candidate's contract", async () => {
    const run = async (
      route: "shipped" | "candidate",
      data: Record<string, unknown>
    ) => {
      const w = await world(route);
      let answer: string;
      try {
        const value = await (
          w.client as unknown as Record<
            string,
            Record<string, (a: unknown) => Promise<unknown>>
          >
        ).ledger!.update!({ data, where: { id: "10.00" } });
        answer = `ok:${JSON.stringify(value)}`;
      } catch (error) {
        const raised = error as Error;
        answer = `${raised.constructor.name}: ${raised.message}`;
      }
      const rows = w.database
        .prepare("SELECT id,label FROM g4rc_ledger ORDER BY id")
        .all();
      await close(w);
      return { answer, rows };
    };

    const report: string[] = [];
    for (const [label, data] of [
      ["increment", { id: { increment: 1 } }],
      ["decrement", { id: { decrement: 1 } }],
      ["multiply", { id: { multiply: 2 } }],
      ["divide", { id: { divide: 2 } }],
    ] as [string, Record<string, unknown>][]) {
      const shipped = await run("shipped", data);
      const candidate = await run("candidate", data);
      report.push(
        [
          `[R-D2 ${label}]`,
          `  shipped   ${shipped.answer} rows ${JSON.stringify(shipped.rows)}`,
          `  candidate ${candidate.answer} rows ${JSON.stringify(candidate.rows)}`,
        ].join("\n")
      );
      if (label === "increment" || label === "decrement") {
        assert.ok(
          candidate.answer.startsWith("ok:"),
          `${label}: the candidate SUPPORTS a decimal key ${label} (R-D2 (a)) — saw ${candidate.answer}`
        );
        assert.ok(
          shipped.answer.includes(
            "Arithmetic updates are not portable for decimal primary key field 'id'."
          ),
          `${label}: the shipped engine still refuses — saw ${shipped.answer}`
        );
      } else {
        assert.equal(
          candidate.answer,
          shipped.answer,
          `${label}: both engines answer the shipped sentence`
        );
        assert.ok(
          candidate.answer.includes(
            "Arithmetic updates are not portable for decimal primary key field 'id'."
          ),
          `${label}: the shipped sentence — saw ${candidate.answer}`
        );
      }
    }
    // biome-ignore lint/suspicious/noConsole: the probe's output IS its receipt.
    console.log(report.join("\n"));
  }, 180_000);
});
