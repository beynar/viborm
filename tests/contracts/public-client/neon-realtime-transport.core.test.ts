/**
 * A live read's envelope is plain JSON: any transformer carries it unchanged,
 * and the browser half decodes the first result exactly. No custom
 * transformer exists; the logical `data` never reaches the wire.
 */

import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import type { RawSqlQuery } from "@neon/realtime/server";
import { createClient, s } from "@src/index";
import { SqlOnlyDriver } from "@tests/fixtures/drivers/sql-only";
import { Decimal } from "@validation/primitives/decimal-value";
import { describe, expect, it } from "vitest";
import { neonRealtime } from "../../../src/neon-realtime";
import { realtimeData } from "../../../src/neon-realtime/client";

class RowsDriver extends SqlOnlyDriver {
  readonly rows: Record<string, unknown>[];
  constructor(rows: Record<string, unknown>[]) {
    super(new PostgresAdapter(), "postgresql");
    this.rows = rows;
  }
  protected override async execute<T>() {
    return { rows: this.rows as T[], rowCount: this.rows.length };
  }
}

const item = s.model({
  id: s.string().id(),
  price: s.decimal({ precision: 12, scale: 2 }),
  views: s.bigInt(),
  at: s.dateTime(),
  day: s.date(),
  bytes: s.blob(),
  meta: s.json(),
  status: s.enum(["draft", "live, now"]),
  tags: s.string().array(),
});
const realtime = {
  seal: async (_input: { readonly query: RawSqlQuery<never> }) => ({
    capability: "capability",
    queryFingerprint: "fingerprint",
    expiresAt: 1,
  }),
};

/** What superjson or devalue do: walk own enumerable members, tag rich leaves. */
function walkingTransformer(value: unknown): unknown {
  const encode = (input: unknown): unknown => {
    if (input instanceof Date) return { $date: input.toISOString() };
    if (typeof input === "bigint") return { $bigint: String(input) };
    if (Array.isArray(input)) return input.map(encode);
    if (input && typeof input === "object")
      return Object.fromEntries(
        Object.entries(input).map(([key, item]) => [key, encode(item)])
      );
    return input;
  };
  const decode = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(decode);
    if (input && typeof input === "object") {
      if ("$date" in input) return new Date(String(input.$date));
      if ("$bigint" in input) return BigInt(String(input.$bigint));
      return Object.fromEntries(
        Object.entries(input).map(([key, item]) => [key, decode(item)])
      );
    }
    return input;
  };
  return decode(JSON.parse(JSON.stringify(encode(value))));
}

describe("Neon Realtime envelopes in transit", () => {
  it("survive JSON, structured cloning and walking transformers", async () => {
    const client = createClient({
      schema: { item },
      driver: new RowsDriver([
        {
          id: "i1",
          price: "12.30",
          views: "9007199254740993",
          at: "2026-01-02 03:04:05.006+00",
          day: "2025-06-01",
          bytes: new Uint8Array([0, 255]),
          meta: { quote: 'a"b', list: [1, null] },
          status: "live, now",
          tags: ["a,b"],
        },
      ]),
    });
    const db = client.$extends(neonRealtime({ realtime }));
    const query = await db.item.findManyRealtime();
    expect(query.data).toEqual([
      {
        id: "i1",
        price: new Decimal("12.30"),
        views: 9_007_199_254_740_993n,
        at: new Date("2026-01-02T03:04:05.006Z"),
        day: new Date("2025-06-01T00:00:00.000Z"),
        bytes: new Uint8Array([0, 255]),
        meta: { quote: 'a"b', list: [1, null] },
        status: "live, now",
        tags: ["a,b"],
      },
    ]);
    for (const transported of [
      JSON.parse(JSON.stringify(query)),
      structuredClone(query),
      walkingTransformer(query),
    ] as (typeof query)[]) {
      expect(Object.keys(transported)).toEqual([
        "kind",
        "sealed",
        "plan",
        "encoded",
      ]);
      expect(realtimeData(transported)).toEqual(query.data);
    }
    await client.$disconnect();
  });
});
