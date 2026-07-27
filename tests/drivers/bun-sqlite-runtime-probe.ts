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
import { push } from "@migrations";
import { s } from "@schema";

const measurement = s
  .model({
    id: s.string().id(),
    views: s.bigInt(),
    readings: s.oneToMany(() => reading),
  })
  .map("bun_sqlite_runtime_measurements");

const reading = s
  .model({
    id: s.string().id(),
    measurementId: s.string(),
    count: s.bigInt(),
    measurement: s
      .manyToOne(() => measurement)
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
  schema: { measurement, reading },
  driver: new BunSQLiteDriver({ dataDir: ":memory:" }),
});

await push(client, { force: true });
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

await client.$disconnect();
