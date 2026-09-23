/**
 * G4-02 phase-2 review — the folded root `create` (§P.4.7, decision E-f/§10.12).
 *
 * Phase 1 kept root `create` on the record route because it "owns
 * generated-output continuations, insert-id scratch and acknowledged-segment
 * progress" (note §8.3). Phase 2 folds it to one `INSERT … RETURNING` whenever
 * `data` names no relation, the projection is RETURNING-safe and the adapter
 * returns. These probes compare the folded shape with the shipped engine on the
 * generated-value surface the phase-1 note named as the reason NOT to fold:
 * an auto-increment key the caller omitted, a generated string id, a `now()`
 * default, an `updatedAt` stamp, and the unique-violation identity.
 */
import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

const counter = s
  .model({
    id: s.int().id().increment(),
    label: s.string().unique(),
    createdAt: s.dateTime().now(),
    touchedAt: s.dateTime().updatedAt(),
  })
  .map("r2_counters");
const token = s
  .model({ id: s.string().id().uuid(), label: s.string() })
  .map("r2_tokens");
const schema = { counter, token };

async function build() {
  const database = new Database(":memory:");
  const driver = new SQLite3Driver({ client: database });
  const client = createClient({ schema, driver });
  assert.equal((await syncLiveSchema(client)).applied, true);
  return {
    database,
    client: client as unknown as Record<
      string,
      Record<string, (args?: unknown) => Promise<unknown>>
    >,
    candidate: createCommandEngine({ schema, driver }),
    async close() {
      await client.$disconnect();
      database.close();
    },
  };
}

interface Outcome {
  readonly value?: Record<string, unknown>;
  readonly error?: string;
  readonly rows: unknown[];
}

async function create(
  model: string,
  table: string,
  args: unknown,
  engine: "shipped" | "candidate"
): Promise<Outcome> {
  const live = await build();
  try {
    const value = (
      engine === "shipped"
        ? await live.client[model]?.create?.(args)
        : await live.candidate.execute(model, "create", args)
    ) as Record<string, unknown>;
    return {
      value,
      rows: live.database.prepare(`SELECT * FROM ${table}`).all(),
    };
  } catch (error) {
    return {
      error: `${(error as Error).constructor.name}: ${(error as Error).message}`,
      rows: live.database.prepare(`SELECT * FROM ${table}`).all(),
    };
  } finally {
    await live.close();
  }
}

/** Shapes, not values: a generated id and a timestamp differ between runs. */
function shape(outcome: Outcome): unknown {
  if (outcome.error) return { error: outcome.error };
  const value = outcome.value!;
  return {
    keys: Object.keys(value).sort(),
    kinds: Object.fromEntries(
      Object.entries(value).map(([key, member]) => [
        key,
        member instanceof Date
          ? "Date"
          : member === null
            ? "null"
            : typeof member,
      ])
    ),
    rowCount: outcome.rows.length,
    rowKeys: outcome.rows[0]
      ? Object.keys(outcome.rows[0] as object).sort()
      : [],
  };
}

describe("G4-02 review — the folded root create keeps the generated surface", () => {
  it("returns the auto-increment key the caller omitted, as the shipped engine does", async () => {
    const shipped = await create(
      "counter",
      "r2_counters",
      { data: { label: "a" } },
      "shipped"
    );
    const candidate = await create(
      "counter",
      "r2_counters",
      { data: { label: "a" } },
      "candidate"
    );
    assert.deepEqual(
      shape(candidate),
      shape(shipped),
      `candidate ${JSON.stringify(shape(candidate))} vs shipped ${JSON.stringify(shape(shipped))}`
    );
    assert.equal(
      typeof (candidate.value as Record<string, unknown>)?.id,
      "number",
      `the generated key must be published: ${JSON.stringify(candidate.value)}`
    );
  });

  it("generates a string id the same way as the shipped engine", async () => {
    const shipped = await create(
      "token",
      "r2_tokens",
      { data: { label: "a" } },
      "shipped"
    );
    const candidate = await create(
      "token",
      "r2_tokens",
      { data: { label: "a" } },
      "candidate"
    );
    assert.deepEqual(shape(candidate), shape(shipped));
    assert.equal(
      typeof (candidate.value as Record<string, unknown>)?.id,
      "string"
    );
  });

  it("raises the same identity for a unique violation", async () => {
    const live = await build();
    try {
      await live.client.counter?.create?.({ data: { label: "dup" } });
      const failures: string[] = [];
      for (const invoke of [
        () => live.client.counter?.create?.({ data: { label: "dup" } }),
        () => live.candidate.execute("counter", "create", { data: { label: "dup" } }),
      ]) {
        try {
          await invoke();
          failures.push("no refusal");
        } catch (error) {
          failures.push(
            `${(error as Error).constructor.name}: ${(error as Error).message}`
          );
        }
      }
      assert.equal(failures[1], failures[0], failures.join(" | "));
    } finally {
      await live.close();
    }
  });

  it("publishes a partial selection the same way", async () => {
    const shipped = await create(
      "counter",
      "r2_counters",
      { data: { label: "a" }, select: { label: true } },
      "shipped"
    );
    const candidate = await create(
      "counter",
      "r2_counters",
      { data: { label: "a" }, select: { label: true } },
      "candidate"
    );
    assert.deepEqual(candidate.value, shipped.value);
  });
});
