import { defineContract } from "@tests/contracts/contract";
import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { push } from "@migrations";
import { s } from "@schema";
import type { InputJsonValue } from "@validation";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const measurement = s
  .model({
    id: s.string().id(),
    takenAt: s.dateTime(),
    amount: s.decimal(),
    views: s.bigInt(),
    readings: s.toMany(() => reading),
  })
  .map("scalar_roundtrip_measurements");

const reading = s
  .model({
    id: s.string().id(),
    measurementId: s.string(),
    recordedAt: s.dateTime(),
    price: s.decimal(),
    count: s.bigInt(),
    measurement: s
      .toOne(() => measurement)
      .fields("measurementId")
      .references("id"),
  })
  .map("scalar_roundtrip_readings");

const schema = { measurement, reading };

type ScalarRoundtripClientConfig = VibORMConfig & {
  schema: typeof schema;
  driver: AnyDriver;
};

type ScalarRoundtripClient = VibORMClient<ScalarRoundtripClientConfig>;

export interface ScalarRoundtripBehaviorOptions {
  driverName: string;
  createDriver: () => AnyDriver;
}

const TAKEN_AT = new Date("2024-01-15T10:30:00.123Z");
// A decimal is written and read as an exact string (W6-U1). This one is
// representable as a double too — the values that are NOT are exercised by the
// exact-decimal suite below.
const AMOUNT = "123.456";
// One past Number.MAX_SAFE_INTEGER: silently corrupts if it travels as a JS number
const VIEWS = 9_007_199_254_740_993n;

/**
 * Exact round-trips for the scalar types that historically shipped broken on
 * MySQL: datetime (ISO 'Z' strings rejected by DATETIME, reads shifted by
 * process timezone), decimal (bare DECIMAL truncates fractions), and bigint
 * (mysql2 returns lossy JS numbers past 2^53). Every test asserts the exact
 * JS value AND type, both top-level and inside an include (the JSON
 * aggregation path serializes these differently).
 */
export function runScalarRoundtripBehavior({
  driverName,
  createDriver,
}: ScalarRoundtripBehaviorOptions) {
  describe(`${driverName} scalar round-trip behavior`, () => {
    let client: ScalarRoundtripClient | undefined;

    beforeEach(async () => {
      client = createClient({ schema, driver: createDriver() });
      await push(client, { force: true });
    });

    afterEach(async () => {
      if (client) {
        await client.$disconnect();
        client = undefined;
      }
    });

    async function seed(): Promise<void> {
      await requireClient(client).measurement.create({
        data: { id: "m-1", takenAt: TAKEN_AT, amount: AMOUNT, views: VIEWS },
      });
    }

    test("datetime round-trips exactly through create and findMany", async () => {
      await seed();

      const rows = await requireClient(client).measurement.findMany();

      expect(rows).toHaveLength(1);
      expect(rows[0]?.takenAt).toBeInstanceOf(Date);
      expect(rows[0]?.takenAt.toISOString()).toBe(TAKEN_AT.toISOString());
    });

    test("datetime filters match the stored instant", async () => {
      await seed();
      const found = requireClient(client);

      const equals = await found.measurement.findMany({
        where: { takenAt: TAKEN_AT },
      });
      expect(equals.map((row) => row.id)).toEqual(["m-1"]);

      const before = await found.measurement.findMany({
        where: { takenAt: { gt: new Date("2024-01-15T10:30:00.122Z") } },
      });
      expect(before.map((row) => row.id)).toEqual(["m-1"]);

      const after = await found.measurement.findMany({
        where: { takenAt: { gt: new Date("2024-01-15T10:30:00.123Z") } },
      });
      expect(after).toEqual([]);
    });

    test("datetime update round-trips exactly", async () => {
      await seed();
      const updatedAt = new Date("2025-06-30T23:59:59.999Z");

      await requireClient(client).measurement.update({
        where: { id: "m-1" },
        data: { takenAt: updatedAt },
      });

      const row = await requireClient(client).measurement.findUnique({
        where: { id: "m-1" },
      });
      expect(row?.takenAt).toBeInstanceOf(Date);
      expect(row?.takenAt.toISOString()).toBe(updatedAt.toISOString());
    });

    test("decimal reads back as its exact canonical string", async () => {
      await seed();

      const row = await requireClient(client).measurement.findUnique({
        where: { id: "m-1" },
      });

      expect(typeof row?.amount).toBe("string");
      expect(row?.amount).toBe(AMOUNT);
    });

    test("bigint beyond Number.MAX_SAFE_INTEGER round-trips exactly", async () => {
      await seed();

      const row = await requireClient(client).measurement.findUnique({
        where: { id: "m-1" },
      });

      expect(typeof row?.views).toBe("bigint");
      expect(row?.views).toBe(VIEWS);
    });

    test("include round-trips datetime, decimal, and bigint exactly", async () => {
      const recordedAt = new Date("2023-11-05T08:15:30.042Z");
      await requireClient(client).measurement.create({
        data: {
          id: "m-1",
          takenAt: TAKEN_AT,
          amount: AMOUNT,
          views: VIEWS,
          readings: {
            createMany: {
              data: [
                { id: "r-1", recordedAt, price: "0.001", count: VIEWS + 1n },
              ],
            },
          },
        },
      });

      const row = await requireClient(client).measurement.findUnique({
        where: { id: "m-1" },
        include: { readings: true },
      });

      expect(row?.readings).toHaveLength(1);
      const nested = row?.readings[0];
      expect(nested?.recordedAt).toBeInstanceOf(Date);
      expect(nested?.recordedAt.toISOString()).toBe(recordedAt.toISOString());
      expect(typeof nested?.price).toBe("string");
      expect(nested?.price).toBe("0.001");
      expect(typeof nested?.count).toBe("bigint");
      expect(nested?.count).toBe(VIEWS + 1n);
    });
  });
}

function requireClient(
  client: ScalarRoundtripClient | undefined
): ScalarRoundtripClient {
  if (!client) {
    throw new Error("Scalar round-trip test client was not initialized.");
  }
  return client;
}

// =============================================================================
// Full scalar-type coverage: every scalar written and read back must be the
// same JS value AND type on every driver, both top-level and inside an
// include (the JSON aggregation path serializes scalars differently).
// =============================================================================

const fullRecord = s
  .model({
    id: s.string().id(),
    text: s.string(),
    count: s.int(),
    ratio: s.number(),
    price: s.decimal(),
    views: s.bigInt(),
    active: s.boolean(),
    happenedAt: s.dateTime(),
    localAt: s.dateTime().withoutTimezone(),
    bornOn: s.date(),
    wakeAt: s.time(),
    meta: s.json(),
    payload: s.blob(),
    kind: s.enum(["alpha", "beta"]),
    items: s.toMany(() => fullItem),
  })
  .map("scalar_roundtrip_full");

const fullItem = s
  .model({
    id: s.string().id(),
    recordId: s.string(),
    text: s.string(),
    count: s.int(),
    ratio: s.number(),
    price: s.decimal(),
    views: s.bigInt(),
    active: s.boolean(),
    happenedAt: s.dateTime(),
    localAt: s.dateTime().withoutTimezone(),
    bornOn: s.date(),
    wakeAt: s.time(),
    meta: s.json(),
    payload: s.blob(),
    kind: s.enum(["alpha", "beta"]),
    record: s
      .toOne(() => fullRecord)
      .fields("recordId")
      .references("id"),
  })
  .map("scalar_roundtrip_full_items");

const fullSchema = { record: fullRecord, item: fullItem };

type FullClientConfig = VibORMConfig & {
  schema: typeof fullSchema;
  driver: AnyDriver;
};
type FullClient = VibORMClient<FullClientConfig>;

type FullValues = {
  text: string;
  count: number;
  ratio: number;
  price: string;
  views: bigint;
  active: boolean;
  happenedAt: Date;
  localAt: Date;
  bornOn: Date;
  wakeAt: string;
  // Write position: a JSON field takes any document except a bare
  // top-level null, which needs the DbNull/JsonNull sentinels
  meta: InputJsonValue;
  payload: Uint8Array;
  kind: "alpha" | "beta";
};

const FULL_VALUES: FullValues = {
  text: 'plain text with {"json": true} inside',
  count: 42,
  ratio: 1.5,
  // A decimal is an exact string: 30 fraction digits, past what a double holds
  price: "123.456000000000000000000000000001",
  // One past Number.MAX_SAFE_INTEGER: corrupts if it travels as a JS number
  views: 9_007_199_254_740_993n,
  active: true,
  happenedAt: new Date("2024-01-15T10:30:00.123Z"),
  localAt: new Date("2024-06-01T22:45:10.500Z"),
  bornOn: new Date("2024-03-07T00:00:00.000Z"),
  wakeAt: "13:45:30",
  meta: { nested: { a: 1 }, list: [1, "two", true], text: "x" },
  payload: new Uint8Array([0, 1, 2, 128, 253, 255]),
  kind: "beta",
};

function expectFullValues(
  row: Record<string, unknown> | null | undefined,
  expected: FullValues
): void {
  expect(row).toBeTruthy();
  const r = row as Record<string, unknown>;

  expect(typeof r.text).toBe("string");
  expect(r.text).toBe(expected.text);

  expect(typeof r.count).toBe("number");
  expect(r.count).toBe(expected.count);

  expect(typeof r.ratio).toBe("number");
  expect(r.ratio).toBe(expected.ratio);

  expect(typeof r.price).toBe("string");
  expect(r.price).toBe(expected.price);

  expect(typeof r.views).toBe("bigint");
  expect(r.views).toBe(expected.views);

  expect(typeof r.active).toBe("boolean");
  expect(r.active).toBe(expected.active);

  expect(r.happenedAt).toBeInstanceOf(Date);
  expect((r.happenedAt as Date).toISOString()).toBe(
    expected.happenedAt.toISOString()
  );

  expect(r.localAt).toBeInstanceOf(Date);
  expect((r.localAt as Date).toISOString()).toBe(
    expected.localAt.toISOString()
  );

  // Dates are UTC midnight on every driver — never local midnight
  expect(r.bornOn).toBeInstanceOf(Date);
  expect((r.bornOn as Date).toISOString()).toBe(expected.bornOn.toISOString());

  expect(typeof r.wakeAt).toBe("string");
  expect(r.wakeAt).toBe(expected.wakeAt);

  expect(r.meta).toEqual(expected.meta);

  // Uint8Array is the one public blob type — not Buffer, not ArrayBuffer
  expect(r.payload).toBeInstanceOf(Uint8Array);
  expect((r.payload as Uint8Array).constructor).toBe(Uint8Array);
  expect(Array.from(r.payload as Uint8Array)).toEqual(
    Array.from(expected.payload)
  );

  expect(r.kind).toBe(expected.kind);
}

export function runFullScalarRoundtripBehavior({
  driverName,
  createDriver,
}: ScalarRoundtripBehaviorOptions) {
  describe(`${driverName} full scalar-type round-trip behavior`, () => {
    let client: FullClient;

    beforeEach(async () => {
      client = createClient({ schema: fullSchema, driver: createDriver() });
      await push(client, { force: true });
    });

    afterEach(async () => {
      await client.$disconnect();
    });

    function recordData(id: string, overrides: Partial<FullValues> = {}) {
      return { id, ...FULL_VALUES, ...overrides };
    }

    test("every scalar type round-trips exactly top-level", async () => {
      await client.record.create({ data: recordData("f-1") });

      const row = await client.record.findUnique({ where: { id: "f-1" } });
      expectFullValues(row, FULL_VALUES);
    });

    test("every scalar type round-trips exactly inside an include", async () => {
      const itemValues: FullValues = {
        ...FULL_VALUES,
        active: false,
        views: FULL_VALUES.views + 1n,
        payload: new Uint8Array([255, 0, 42]),
        meta: "just a json string",
        kind: "alpha",
      };
      await client.record.create({
        data: {
          ...recordData("f-1"),
          items: { create: { id: "i-1", ...itemValues } },
        },
      });

      const row = await client.record.findUnique({
        where: { id: "f-1" },
        include: { items: true },
      });

      expectFullValues(row, FULL_VALUES);
      expect(row?.items).toHaveLength(1);
      expectFullValues(row?.items[0], itemValues);
    });

    test("json primitives round-trip with exact types", async () => {
      const cases: [string, InputJsonValue][] = [
        ["j-string", "hello"],
        ["j-number", 42],
        ["j-boolean", true],
        // A json STRING of digits must stay a string, not become a number
        ["j-numeric-string", "123"],
        ["j-array", [1, "two", { three: 3 }]],
      ];
      for (const [id, meta] of cases) {
        await client.record.create({ data: recordData(id, { meta }) });
      }

      for (const [id, meta] of cases) {
        const row = await client.record.findUnique({ where: { id } });
        expect(row?.meta).toEqual(meta);
        expect(typeof row?.meta).toBe(typeof meta);
      }
    });

    test("aggregates are scalar-aware", async () => {
      await client.record.create({ data: recordData("f-1") });
      await client.record.create({
        data: recordData("f-2", {
          views: FULL_VALUES.views + 10n,
          count: 8,
          happenedAt: new Date("2025-02-20T05:00:00.000Z"),
        }),
      });

      const result = await client.record.aggregate({
        _count: true,
        _avg: { count: true },
        _sum: { views: true, count: true },
        _min: { happenedAt: true },
        _max: { happenedAt: true },
      });

      expect(typeof result._count).toBe("number");
      expect(result._count).toBe(2);

      expect(typeof result._avg.count).toBe("number");
      expect(result._avg.count).toBe(25);

      expect(typeof result._sum.count).toBe("number");
      expect(result._sum.count).toBe(50);

      // Sum of two >2^53 bigints: corrupts unless it travels as TEXT
      expect(typeof result._sum.views).toBe("bigint");
      expect(result._sum.views).toBe(FULL_VALUES.views * 2n + 10n);

      expect(result._min.happenedAt).toBeInstanceOf(Date);
      expect(result._min.happenedAt?.toISOString()).toBe(
        FULL_VALUES.happenedAt.toISOString()
      );
      expect(result._max.happenedAt).toBeInstanceOf(Date);
      expect(result._max.happenedAt?.toISOString()).toBe(
        "2025-02-20T05:00:00.000Z"
      );
    });
  });
}

export const scalarRoundtripContract = defineContract({
  id: "drivers.scalar-roundtrip",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution"],
  register: runScalarRoundtripBehavior,
});

export const fullScalarRoundtripContract = defineContract({
  id: "drivers.full-scalar-roundtrip",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution"],
  register: runFullScalarRoundtripBehavior,
});
