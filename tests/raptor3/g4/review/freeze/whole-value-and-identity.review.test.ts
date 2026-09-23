/**
 * FREEZE-unit review probe — part 2 (one spelling of "an operator record whose
 * `set` names the whole value") and the new `Unknown update operation:`
 * identity.
 *
 * The unit's own domain census is a REPLICATION of the two spellings printed in
 * a receipt, not an execution of the compiled module (note §7 item 2). This
 * probe runs the SHIPPED-in-tree `wholeValue` export itself against the
 * predicate `commands/assignments.ts` carried before the change
 * (`value !== null && typeof value === "object" && !(value instanceof Sql) &&
 * Object.hasOwn(value, "set") ? record(value).set : value`, the
 * `0cc61e61`/pre-freeze spelling) over every domain an admitted scalar value
 * can be, and reports each disagreement.
 *
 * The last cell measures the reachable shapes of `Queries.prepareUpdate`'s new
 * throw against the shipped engine, answer and identity.
 */
import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { Operations } from "@client/types";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { wholeValue } from "@query-engine/raptor3/shared/query";
import { s } from "@schema";
import { Sql, sql } from "@sql";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { toDecimal } from "@validation/primitives/decimal-codec";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

/** `String()` throws on a null-prototype object; this never does. */
function show(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "object")
    return `${Object.getPrototypeOf(value) === null ? "[null-proto]" : ((value as object).constructor?.name ?? "object")} ${JSON.stringify(value) ?? "?"}`;
  return String(value);
}

/** The predicate `scalarAssignment` carried before the freeze unit. */
function previousSpelling(value: unknown): unknown {
  return value !== null &&
    typeof value === "object" &&
    !(value instanceof Sql) &&
    Object.hasOwn(value as object, "set")
    ? (value as Record<string, unknown>).set
    : value;
}

/** The new spelling, as `scalarAssignment` now composes it. */
function currentSpelling(value: unknown): unknown {
  const whole = wholeValue(value);
  return whole ? whole.value : value;
}

class OwnSet {
  set = 7;
}
class Inherited {
  get set(): number {
    return 7;
  }
}
const nullProto = Object.assign(
  Object.create(null) as Record<string, unknown>,
  {
    set: 3,
  }
);
const nullProtoOperator = Object.assign(
  Object.create(null) as Record<string, unknown>,
  { increment: 3 }
);

const DOMAINS: readonly (readonly [string, unknown])[] = [
  ["null", null],
  ["undefined", undefined],
  ["number", 7],
  ["bigint", 7n],
  ["string", "seven"],
  ["boolean", true],
  ["Uint8Array", new Uint8Array([1, 2, 3])],
  ["Date", new Date(0)],
  ["Decimal", toDecimal("1.25")],
  ["array", [1, 2]],
  ["array of Uint8Array", [new Uint8Array([1])]],
  ["Map", new Map([["set", 1]])],
  ["Set", new Set([1])],
  ["Sql", sql`1`],
  ["plain {set}", { set: 5 }],
  ["plain {set:null}", { set: null }],
  ["plain {set:undefined}", { set: undefined }],
  ["plain {increment}", { increment: 5 }],
  ["plain {set,increment}", { set: 5, increment: 1 }],
  ["plain {}", {}],
  ["null-prototype {set}", nullProto],
  ["null-prototype {increment}", nullProtoOperator],
  ["class instance with OWN set", new OwnSet()],
  ["class instance with INHERITED set", new Inherited()],
  ["function", () => 1],
];

const MODEL = "g4fzwv_rows";
const model = s
  .model({
    id: s.int().id(),
    name: s.string(),
    payload: s.blob().nullable(),
  })
  .map(MODEL);
const schema = { row: model };

async function answer(
  engine: "shipped" | "candidate",
  operation: Operations,
  args: unknown
): Promise<string> {
  const database = new Database(":memory:");
  const driver = new SQLite3Driver({ client: database });
  const client = createClient({ schema, driver });
  // biome-ignore lint/suspicious/noMisplacedAssertion: helper called only from cells.
  assert.equal((await syncLiveSchema(client)).applied, true);
  database.exec(`INSERT INTO ${MODEL} (id,name,payload) VALUES (1,'a',NULL);`);
  const candidate = createCommandEngine({ schema, driver });
  let text: string;
  try {
    const value =
      engine === "shipped"
        ? await (
            client as unknown as Record<
              string,
              Record<string, (args: unknown) => Promise<unknown>>
            >
          ).row![operation]!(args)
        : await candidate.execute("row", operation, args);
    text = `ok:${JSON.stringify(value)}`;
  } catch (error) {
    text = `${(error as Error).constructor.name}: ${(error as Error).message}`;
  }
  const rows = database.prepare(`SELECT * FROM ${MODEL} ORDER BY id`).all();
  await client.$disconnect();
  database.close();
  return `${text} | rows=${JSON.stringify(rows)}`;
}

describe("freeze review — one whole-value spelling, measured on the compiled owner", () => {
  it("answers what the deleted inline predicate answered on every admitted scalar domain", async () => {
    const divergences: string[] = [];
    for (const [label, value] of DOMAINS) {
      const before = previousSpelling(value);
      const now = currentSpelling(value);
      const same = Object.is(before, now);
      // biome-ignore lint/suspicious/noConsole: the probe's measurement IS its output.
      console.log(
        `${same ? "AGREE " : "DIFFER"}  ${label}: before=${show(before)} now=${show(now)}`
      );
      if (!same) divergences.push(label);
    }
    // The one known and disclosed divergence is a class instance carrying an
    // OWN `set`; nothing in the estate produces one. Any OTHER divergence is a
    // behaviour change the unit did not disclose.
    // biome-ignore lint/suspicious/noMisplacedAssertion: this IS the cell.
    assert.deepEqual(divergences, ["class instance with OWN set"]);
  });

  it("holds a blob whole and unwraps a plain {set} through the real write path", async () => {
    const rows: readonly (readonly [string, Operations, unknown])[] = [
      [
        "blob update with a bare Uint8Array",
        "update",
        { where: { id: 1 }, data: { payload: new Uint8Array([9, 9]) } },
      ],
      [
        "blob update with {set: Uint8Array}",
        "update",
        { where: { id: 1 }, data: { payload: { set: new Uint8Array([8]) } } },
      ],
      [
        "key update with {set}",
        "update",
        { where: { id: 1 }, data: { id: { set: 42 } } },
      ],
      [
        "key update with {increment}",
        "update",
        { where: { id: 1 }, data: { id: { increment: 5 } } },
      ],
    ];
    const divergences: string[] = [];
    for (const [label, operation, args] of rows) {
      const shipped = await answer("shipped", operation, args);
      const candidate = await answer("candidate", operation, args);
      const same = shipped === candidate;
      // biome-ignore lint/suspicious/noConsole: the probe's measurement IS its output.
      console.log(
        `${same ? "AGREE " : "DIFFER"}  ${label}\n    shipped   ${shipped}\n    candidate ${candidate}`
      );
      if (!same) divergences.push(label);
    }
    // biome-ignore lint/suspicious/noMisplacedAssertion: this IS the cell.
    assert.deepEqual(divergences, []);
  });

  it("answers the shipped `Unknown update operation:` identity on the reachable empty-record shapes", async () => {
    const rows: readonly (readonly [string, Operations, unknown])[] = [
      [
        "root update, non-key field names nothing",
        "update",
        { where: { id: 1 }, data: { name: {} } },
      ],
      [
        "root upsert (relation-free), non-key field names nothing",
        "upsert",
        {
          where: { id: 1 },
          create: { id: 1, name: "a" },
          update: { name: {} },
        },
      ],
      [
        "root upsert (relation-free), key names nothing",
        "upsert",
        { where: { id: 1 }, create: { id: 1, name: "a" }, update: { id: {} } },
      ],
      [
        "root update, blob field names nothing",
        "update",
        { where: { id: 1 }, data: { payload: {} } },
      ],
    ];
    const divergences: string[] = [];
    for (const [label, operation, args] of rows) {
      const shipped = await answer("shipped", operation, args);
      const candidate = await answer("candidate", operation, args);
      const same = shipped === candidate;
      // biome-ignore lint/suspicious/noConsole: the probe's measurement IS its output.
      console.log(
        `${same ? "AGREE " : "DIFFER"}  ${label}\n    shipped   ${shipped}\n    candidate ${candidate}`
      );
      if (!same) divergences.push(label);
    }
    // biome-ignore lint/suspicious/noMisplacedAssertion: this IS the cell.
    assert.deepEqual(divergences, []);
  });
});
