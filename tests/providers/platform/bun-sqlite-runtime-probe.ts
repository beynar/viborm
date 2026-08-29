/**
 * Real-runtime probe for the `bun-sqlite` driver — RUN BY BUN, NOT BY VITEST.
 *
 * `tests/drivers/bun-sqlite-runtime.test.ts` spawns this file with `bun run`
 * when Bun is on PATH, and skips when it is not. It is not a `.test.ts` file,
 * so vitest never collects it (vitest cannot load `bun:sqlite` at all).
 *
 * Everything else that covers this driver is a `vi.fn()` fake, which can only
 * prove viborm handles a well-formed response. This is the one place the real
 * `bun:sqlite` answers, through the real client, migrations and result parser.
 *
 * Any thrown error exits non-zero, which is the failure signal the spawning
 * test asserts on.
 */

import { createClient } from "@client/client";
import { BunSQLiteDriver } from "@drivers/bun-sqlite";
import { ForeignKeyError } from "@errors";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Decimal from "decimal.js";

const DECIMAL_DOMAIN = { precision: 16, scale: 2 };
const PAST_DOUBLE = "99999999999999.99";
const PAST_DOUBLE_NEIGHBOUR = "99999999999999.98";
const PAST_DOUBLE_COEFFICIENT = "9999999999999999";

const decimalEvidence = s
  .model({
    id: s.string().id(),
    amount: s.decimal(DECIMAL_DOMAIN),
    amounts: s.decimal(DECIMAL_DOMAIN).array(),
  })
  .map("bun_sqlite_runtime_decimals");

const measurement = s
  .model({
    id: s.string().id(),
    views: s.bigInt(),
    readings: s.toMany(() => reading),
  })
  .map("bun_sqlite_runtime_measurements");

const reading = s
  .model({
    id: s.string().id(),
    measurementId: s.string(),
    count: s.bigInt(),
    measurement: s
      .toOne(() => measurement)
      .fields("measurementId")
      .references("id"),
  })
  .map("bun_sqlite_runtime_readings");

// The value the shared scalar round-trip suite pins on sqlite3 and libsql:
// one past Number.MAX_SAFE_INTEGER, so it rounds down to 9007199254740992 the
// moment it travels as a JS number.
const VIEWS = 9_007_199_254_740_993n;
const ROUNDED_VIEWS = 9_007_199_254_740_992;

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const client = createClient({
  schema: { decimalEvidence, measurement, reading },
  driver: new BunSQLiteDriver({ dataDir: ":memory:" }),
});

await syncLiveSchema(client);
await client.measurement.create({
  data: {
    id: "m-1",
    views: VIEWS,
    readings: { create: { id: "r-1", count: VIEWS + 1n } },
  },
});

// 1. The typed read path: exact, because the driver opts the statement into
//    safeIntegers. Without that opt-in this is ROUNDED_VIEWS.
const row = await client.measurement.findUnique({ where: { id: "m-1" } });
assert(
  typeof row?.views === "bigint",
  `typed read gave ${typeof row?.views}, expected bigint`
);
assert(
  row?.views === VIEWS,
  `typed read gave ${row?.views}, expected ${VIEWS}`
);

// 2. The same value read again through the same driver in a `findMany`, so the
//    multi-row decode path is covered too.
const rows = await client.measurement.findMany();
assert(rows.length === 1, `findMany gave ${rows.length} rows, expected 1`);
assert(
  rows[0]?.views === VIEWS,
  `findMany gave ${rows[0]?.views}, expected ${VIEWS}`
);

// 3. Inside an `include`: the row travels as a JSON envelope built by SQLite,
//    which is a different decode path from the top-level one.
const withReadings = await client.measurement.findUnique({
  where: { id: "m-1" },
  include: { readings: true },
});
assert(
  withReadings?.readings.length === 1,
  `include gave ${withReadings?.readings.length} readings, expected 1`
);
assert(
  withReadings?.readings[0]?.count === VIEWS + 1n,
  `include gave ${withReadings?.readings[0]?.count}, expected ${VIEWS + 1n}`
);

// 4. The tagged `$queryRaw` travels the same execute path as a model read, so
//    it is exact too — same answer sqlite3 gives.
const tagged = await client.$queryRaw<{
  views: number | bigint;
}>`SELECT "views" FROM "bun_sqlite_runtime_measurements"`;
assert(
  tagged[0]?.views === VIEWS,
  `tagged $queryRaw gave ${tagged[0]?.views}, expected ${VIEWS}`
);

// 5. The witness: `$queryRawUnsafe` is the one path that does NOT opt in —
//    hand-written statements bypass the result parser and stay driver-native,
//    exactly as on sqlite3. It comes back ROUNDED. That rounding is what every
//    read on this driver used to do, so this assertion both documents the
//    remaining boundary and fails loudly if the typed path is ever collapsed
//    back into the raw one.
const unsafe = await client.$queryRawUnsafe<{ views: number | bigint }>(
  `SELECT "views" FROM "bun_sqlite_runtime_measurements"`
);
assert(
  typeof unsafe[0]?.views === "number",
  `$queryRawUnsafe gave ${typeof unsafe[0]?.views}, expected number`
);
assert(
  unsafe[0]?.views === ROUNDED_VIEWS,
  `$queryRawUnsafe gave ${unsafe[0]?.views}, expected the rounded ${ROUNDED_VIEWS}`
);

// 6. Referential integrity: bun:sqlite keeps SQLite's foreign_keys default
//    (OFF), so without the driver's `PRAGMA foreign_keys = ON` this dangling
//    write would report success and store the row — the silent divergence
//    sqlite3 and libsql never allow. It must raise the same typed error.
let fkError: unknown;
try {
  await client.reading.create({
    data: { id: "r-dangling", measurementId: "no-such-measurement", count: 1n },
  });
} catch (error) {
  fkError = error;
}
assert(
  fkError instanceof ForeignKeyError,
  fkError === undefined
    ? "dangling FK write reported success, expected ForeignKeyError"
    : `dangling FK write threw ${String(fkError)}, expected ForeignKeyError`
);
const readings = await client.reading.findMany();
assert(
  readings.length === 1,
  `dangling FK write left ${readings.length} readings, expected the 1 valid row`
);

// 7. Fixed-decimal scalar and list binds must cross bun:sqlite as exact scaled
//    coefficients, then materialize as fresh Decimal values on typed reads.
const createdDecimal = await client.decimalEvidence.create({
  data: {
    id: "exact",
    amount: PAST_DOUBLE,
    amounts: [PAST_DOUBLE, "-0.03"],
  },
});
await client.decimalEvidence.create({
  data: {
    id: "neighbour",
    amount: PAST_DOUBLE_NEIGHBOUR,
    amounts: [],
  },
});
assert(
  createdDecimal.amount instanceof Decimal,
  `typed decimal scalar gave ${typeof createdDecimal.amount}, expected Decimal`
);
assert(
  createdDecimal.amounts[0] instanceof Decimal,
  `typed decimal list member gave ${typeof createdDecimal.amounts[0]}, expected Decimal`
);
assert(
  createdDecimal.amount.eq(PAST_DOUBLE),
  `typed decimal scalar gave ${createdDecimal.amount}, expected ${PAST_DOUBLE}`
);
assert(
  createdDecimal.amounts[0]?.eq(PAST_DOUBLE) === true &&
    createdDecimal.amounts[1]?.eq("-0.03") === true,
  `typed decimal list gave ${createdDecimal.amounts.join(",")}, expected ${PAST_DOUBLE},-0.03`
);

// 8. The neighbouring values collapse to one IEEE-754 double. A greater-than
//    filter and numeric order therefore prove the real provider never used it.
const filteredDecimals = await client.decimalEvidence.findMany({
  where: { amount: { gt: PAST_DOUBLE_NEIGHBOUR } },
  select: { id: true },
});
assert(
  filteredDecimals.length === 1 && filteredDecimals[0]?.id === "exact",
  `decimal filter gave ${filteredDecimals.map((row) => row.id)}, expected exact`
);
const orderedDecimals = await client.decimalEvidence.findMany({
  orderBy: { amount: "asc" },
  select: { id: true },
});
assert(
  orderedDecimals[0]?.id === "neighbour" && orderedDecimals[1]?.id === "exact",
  `decimal order gave ${orderedDecimals.map((row) => row.id)}, expected neighbour,exact`
);

// 9. Aggregate results retain exact scale-aware Decimal semantics. The sum is
//    wider than the field precision, and the .985 average ties to even (.98).
const decimalAggregates = await client.decimalEvidence.aggregate({
  _min: { amount: true },
  _max: { amount: true },
  _sum: { amount: true },
  _avg: { amount: true },
});
assert(
  decimalAggregates._min.amount?.eq(PAST_DOUBLE_NEIGHBOUR) === true,
  `decimal minimum gave ${decimalAggregates._min.amount}, expected ${PAST_DOUBLE_NEIGHBOUR}`
);
assert(
  decimalAggregates._max.amount?.eq(PAST_DOUBLE) === true,
  `decimal maximum gave ${decimalAggregates._max.amount}, expected ${PAST_DOUBLE}`
);
assert(
  decimalAggregates._sum.amount?.eq("199999999999999.97") === true,
  `decimal sum gave ${decimalAggregates._sum.amount}, expected 199999999999999.97`
);
assert(
  decimalAggregates._avg.amount?.eq(PAST_DOUBLE_NEIGHBOUR) === true,
  `decimal average gave ${decimalAggregates._avg.amount}, expected ${PAST_DOUBLE_NEIGHBOUR}`
);

// 10. Arithmetic executes in coefficient space with the shared half-even rule.
await client.decimalEvidence.create({
  data: { id: "rounding", amount: "0.05", amounts: [] },
});
const multipliedDecimal = await client.decimalEvidence.update({
  where: { id: "rounding" },
  data: { amount: { multiply: "0.5" } },
});
assert(
  multipliedDecimal.amount.eq("0.02"),
  `decimal multiply tie gave ${multipliedDecimal.amount}, expected 0.02`
);
await client.decimalEvidence.update({
  where: { id: "rounding" },
  data: { amount: { set: "1" } },
});
const dividedDecimal = await client.decimalEvidence.update({
  where: { id: "rounding" },
  data: { amount: { divide: "8" } },
});
assert(
  dividedDecimal.amount.eq("0.12"),
  `decimal divide tie gave ${dividedDecimal.amount}, expected 0.12`
);

// 11. The update result is public
//    Decimal, and a later read constructs another value rather than reusing it.
const updatedDecimal = await client.decimalEvidence.update({
  where: { id: "exact" },
  data: { amount: { decrement: "0.01" } },
});
assert(
  updatedDecimal.amount.eq(PAST_DOUBLE_NEIGHBOUR),
  `decimal arithmetic gave ${updatedDecimal.amount}, expected ${PAST_DOUBLE_NEIGHBOUR}`
);
const selectedDecimal = await client.decimalEvidence.findUniqueOrThrow({
  where: { id: "exact" },
});
assert(
  selectedDecimal.amount instanceof Decimal &&
    selectedDecimal.amount !== updatedDecimal.amount,
  "a later typed decimal read did not materialize a fresh Decimal"
);
assert(
  selectedDecimal.amounts[0] instanceof Decimal &&
    selectedDecimal.amounts[0] !== createdDecimal.amounts[0],
  "a later typed decimal-list read did not materialize a fresh Decimal"
);

// 12. Raw physical evidence completes the transport claim: the scalar is the
//     scaled INTEGER coefficient and the list is coefficient-string JSON.
const physicalDecimals = await client.$queryRaw<{
  amount: string;
  amounts: string;
  amountStorage: string;
  amountsStorage: string;
}>`
  SELECT
    CAST(amount AS TEXT) AS amount,
    amounts,
    typeof(amount) AS amountStorage,
    typeof(amounts) AS amountsStorage
  FROM bun_sqlite_runtime_decimals
  WHERE id = ${"exact"}
`;
assert(
  physicalDecimals[0]?.amount === "9999999999999998",
  `physical decimal scalar gave ${physicalDecimals[0]?.amount}, expected 9999999999999998`
);
assert(
  physicalDecimals[0]?.amounts === `["${PAST_DOUBLE_COEFFICIENT}","-3"]`,
  `physical decimal list gave ${physicalDecimals[0]?.amounts}, expected coefficient strings`
);
assert(
  physicalDecimals[0]?.amountStorage === "integer" &&
    physicalDecimals[0]?.amountsStorage === "text",
  `physical storage classes gave ${physicalDecimals[0]?.amountStorage}/${physicalDecimals[0]?.amountsStorage}, expected integer/text`
);

console.log("fixed-decimal evidence passed");

await client.$disconnect();
