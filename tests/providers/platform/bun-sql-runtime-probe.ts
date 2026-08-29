/**
 * Real-runtime fixed-decimal probe for Bun SQL.
 *
 * Vitest owns discovery and reporting, but Bun owns this process so the probe
 * crosses the real `SQL` transport. It uses the repository's existing
 * `PG_TEST_CONNECTION_STRING` convention and an isolated PostgreSQL schema.
 */

import { createClient } from "@client/client";
import { BunSQLDriver } from "@drivers/bun-sql";
import { push } from "@migrations";
import { s } from "@schema";
import { Decimal } from "@src/index";

const databaseUrl = process.env.PG_TEST_CONNECTION_STRING;
if (!databaseUrl) {
  throw new Error(
    "PG_TEST_CONNECTION_STRING is required for the Bun SQL probe"
  );
}

const PROBE_NAMESPACE = "viborm_bun_sql_decimal_probe";
const DECIMAL_DOMAIN = { precision: 16, scale: 2 };
const PAST_DOUBLE = "99999999999999.99";
const PAST_DOUBLE_NEIGHBOUR = "99999999999999.98";
const HOSTILE_TEXT_MEMBERS = [
  "comma,value",
  'quote"value',
  "back\\slash",
  "NULL",
  "",
];
const EXACT_BIGINT_MEMBERS = [9_007_199_254_740_993n, -9_007_199_254_740_994n];
const DATETIME_MEMBER = "2024-01-02T03:04:05.678Z";
const DATE_MEMBER = "2024-01-02";
const TIME_MEMBER = "03:04:05.678";

const decimalEvidence = s
  .model({
    id: s.string().id(),
    amount: s.decimal(DECIMAL_DOMAIN),
    amounts: s.decimal(DECIMAL_DOMAIN).array(),
    labels: s.string().array(),
    integers: s.int().array(),
    numbers: s.number().array(),
    bigints: s.bigInt().array(),
    flags: s.boolean().array(),
    moments: s.dateTime().array(),
    dates: s.date().array(),
    times: s.time().withoutTimezone().array(),
  })
  .map("bun_sql_runtime_decimals");

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function recreateProbeNamespace(): Promise<void> {
  const driver = new BunSQLDriver({ databaseUrl });
  try {
    await driver._executeRaw(
      `DROP SCHEMA IF EXISTS "${PROBE_NAMESPACE}" CASCADE`
    );
    await driver._executeRaw(`CREATE SCHEMA "${PROBE_NAMESPACE}"`);
  } finally {
    await driver._disconnect();
  }
}

async function removeProbeNamespace(): Promise<void> {
  const driver = new BunSQLDriver({ databaseUrl });
  try {
    await driver._executeRaw(
      `DROP SCHEMA IF EXISTS "${PROBE_NAMESPACE}" CASCADE`
    );
  } finally {
    await driver._disconnect();
  }
}

await recreateProbeNamespace();

const client = createClient({
  schema: { decimalEvidence },
  driver: new BunSQLDriver({ databaseUrl, namespace: PROBE_NAMESPACE }),
});

try {
  await push(client, { force: true });

  const created = await client.decimalEvidence.create({
    data: {
      id: "exact",
      amount: PAST_DOUBLE,
      amounts: [PAST_DOUBLE, "-0.03"],
      labels: HOSTILE_TEXT_MEMBERS,
      integers: [-2_147_483_648, 2_147_483_647],
      numbers: [-1.25, 0, 1.5],
      bigints: EXACT_BIGINT_MEMBERS,
      flags: [true, false],
      moments: [DATETIME_MEMBER],
      dates: [DATE_MEMBER],
      times: [TIME_MEMBER],
    },
  });
  await client.decimalEvidence.create({
    data: {
      id: "neighbour",
      amount: PAST_DOUBLE_NEIGHBOUR,
      amounts: [],
      labels: [],
      integers: [],
      numbers: [],
      bigints: [],
      flags: [],
      moments: [],
      dates: [],
      times: [],
    },
  });

  assert(created.amount instanceof Decimal, "typed scalar was not a Decimal");
  assert(
    created.amounts[0] instanceof Decimal,
    "typed list member was not a Decimal"
  );
  assert(
    created.amount.eq(PAST_DOUBLE),
    `typed scalar gave ${created.amount}, expected ${PAST_DOUBLE}`
  );
  assert(
    created.amounts[0]?.eq(PAST_DOUBLE) === true &&
      created.amounts[1]?.eq("-0.03") === true,
    `typed list gave ${created.amounts.join(",")}, expected ${PAST_DOUBLE},-0.03`
  );
  assert(
    JSON.stringify(created.labels) === JSON.stringify(HOSTILE_TEXT_MEMBERS),
    `string list gave ${JSON.stringify(created.labels)}, expected ${JSON.stringify(HOSTILE_TEXT_MEMBERS)}`
  );
  assert(
    created.integers[0] === -2_147_483_648 &&
      created.integers[1] === 2_147_483_647,
    `integer list gave ${created.integers}, expected signed int32 bounds`
  );
  assert(
    created.numbers[0] === -1.25 &&
      created.numbers[1] === 0 &&
      created.numbers[2] === 1.5,
    `number list gave ${created.numbers}, expected -1.25,0,1.5`
  );
  assert(
    created.bigints[0] === EXACT_BIGINT_MEMBERS[0] &&
      created.bigints[1] === EXACT_BIGINT_MEMBERS[1],
    `bigint list gave ${created.bigints}, expected ${EXACT_BIGINT_MEMBERS}`
  );
  assert(
    created.flags[0] === true && created.flags[1] === false,
    `boolean list gave ${created.flags}, expected true,false`
  );
  assert(
    created.moments[0]?.toISOString() === DATETIME_MEMBER,
    `datetime list gave ${created.moments[0]?.toISOString()}, expected ${DATETIME_MEMBER}`
  );
  assert(
    created.dates[0]?.toISOString() === `${DATE_MEMBER}T00:00:00.000Z`,
    `date list gave ${created.dates[0]?.toISOString()}, expected ${DATE_MEMBER}`
  );
  assert(
    created.times[0] === TIME_MEMBER,
    `time list gave ${created.times[0]}, expected ${TIME_MEMBER}`
  );

  const exactMatches = await client.decimalEvidence.findMany({
    where: { amount: { gt: PAST_DOUBLE_NEIGHBOUR } },
    select: { id: true },
  });
  assert(
    exactMatches.length === 1 && exactMatches[0]?.id === "exact",
    `decimal filter gave ${exactMatches.map((row) => row.id)}, expected exact`
  );

  const ordered = await client.decimalEvidence.findMany({
    orderBy: [{ amount: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  assert(
    ordered[0]?.id === "neighbour" && ordered[1]?.id === "exact",
    `decimal order gave ${ordered.map((row) => row.id)}, expected neighbour,exact`
  );

  const aggregates = await client.decimalEvidence.aggregate({
    _min: { amount: true },
    _max: { amount: true },
    _sum: { amount: true },
    _avg: { amount: true },
  });
  assert(
    aggregates._min.amount?.eq(PAST_DOUBLE_NEIGHBOUR) === true,
    `decimal minimum gave ${aggregates._min.amount}, expected ${PAST_DOUBLE_NEIGHBOUR}`
  );
  assert(
    aggregates._max.amount?.eq(PAST_DOUBLE) === true,
    `decimal maximum gave ${aggregates._max.amount}, expected ${PAST_DOUBLE}`
  );
  assert(
    aggregates._sum.amount?.eq("199999999999999.97") === true,
    `decimal sum gave ${aggregates._sum.amount}, expected 199999999999999.97`
  );
  assert(
    aggregates._avg.amount?.eq(PAST_DOUBLE_NEIGHBOUR) === true,
    `decimal average gave ${aggregates._avg.amount}, expected ${PAST_DOUBLE_NEIGHBOUR}`
  );

  await client.decimalEvidence.create({
    data: {
      id: "rounding",
      amount: "0.05",
      amounts: [],
      labels: [],
      integers: [],
      numbers: [],
      bigints: [],
      flags: [],
      moments: [],
      dates: [],
      times: [],
    },
  });
  const multiplied = await client.decimalEvidence.update({
    where: { id: "rounding" },
    data: { amount: { multiply: "0.5" } },
  });
  assert(
    multiplied.amount.eq("0.02"),
    `decimal multiply tie gave ${multiplied.amount}, expected 0.02`
  );
  await client.decimalEvidence.update({
    where: { id: "rounding" },
    data: { amount: { set: "1" } },
  });
  const divided = await client.decimalEvidence.update({
    where: { id: "rounding" },
    data: { amount: { divide: "8" } },
  });
  assert(
    divided.amount.eq("0.12"),
    `decimal divide tie gave ${divided.amount}, expected 0.12`
  );

  const updated = await client.decimalEvidence.update({
    where: { id: "exact" },
    data: { amount: { decrement: "0.01" } },
  });
  assert(
    updated.amount.eq(PAST_DOUBLE_NEIGHBOUR),
    `decimal arithmetic gave ${updated.amount}, expected ${PAST_DOUBLE_NEIGHBOUR}`
  );

  const selected = await client.decimalEvidence.findUniqueOrThrow({
    where: { id: "exact" },
  });
  assert(
    selected.amount instanceof Decimal && selected.amount !== updated.amount,
    "a later scalar read did not materialize a fresh Decimal"
  );
  assert(
    selected.amounts[0] instanceof Decimal &&
      selected.amounts[0] !== created.amounts[0],
    "a later list read did not materialize a fresh Decimal"
  );
  assert(
    JSON.stringify(selected.labels) === JSON.stringify(HOSTILE_TEXT_MEMBERS),
    "a later string-list read changed Bun's decoded members"
  );
  assert(
    selected.integers[0] === -2_147_483_648 &&
      selected.integers[1] === 2_147_483_647,
    "a later int-list read did not normalize Bun's Int32Array"
  );
  assert(
    selected.numbers[0] === -1.25 &&
      selected.numbers[1] === 0 &&
      selected.numbers[2] === 1.5,
    "a later number-list read changed Bun's decoded members"
  );
  assert(
    selected.bigints[0] === EXACT_BIGINT_MEMBERS[0] &&
      selected.bigints[1] === EXACT_BIGINT_MEMBERS[1],
    "a later bigint-list read changed Bun's decoded members"
  );
  assert(
    selected.flags[0] === true && selected.flags[1] === false,
    "a later boolean-list read changed Bun's decoded members"
  );
  assert(
    selected.moments[0]?.toISOString() === DATETIME_MEMBER &&
      selected.dates[0]?.toISOString() === `${DATE_MEMBER}T00:00:00.000Z` &&
      selected.times[0] === TIME_MEMBER,
    "a later temporal-list read changed Bun's decoded members"
  );

  const physical = await client.$queryRaw<{
    amount: string;
    amounts: string;
    amountType: string;
    amountsType: string;
  }>`
    SELECT
      amount::text AS "amount",
      amounts::text AS "amounts",
      pg_typeof(amount)::text AS "amountType",
      pg_typeof(amounts)::text AS "amountsType"
    FROM "viborm_bun_sql_decimal_probe"."bun_sql_runtime_decimals"
    WHERE id = ${"exact"}
  `;
  assert(
    physical[0]?.amount === PAST_DOUBLE_NEIGHBOUR,
    `physical scalar gave ${physical[0]?.amount}, expected ${PAST_DOUBLE_NEIGHBOUR}`
  );
  assert(
    physical[0]?.amounts === `{${PAST_DOUBLE},-0.03}`,
    `physical list gave ${physical[0]?.amounts}, expected {${PAST_DOUBLE},-0.03}`
  );
  assert(
    physical[0]?.amountType === "numeric" &&
      physical[0]?.amountsType === "numeric[]",
    `physical types gave ${physical[0]?.amountType}/${physical[0]?.amountsType}, expected numeric/numeric[]`
  );

  const rawIntegerList = await client.$queryRawUnsafe<{
    integers: Int32Array;
  }>(
    `SELECT integers FROM "${PROBE_NAMESPACE}"."bun_sql_runtime_decimals" WHERE id = $1`,
    "exact"
  );
  assert(
    rawIntegerList[0]?.integers instanceof Int32Array,
    "verbatim raw integer[] did not retain Bun's native Int32Array"
  );

  console.log("bun-sql fixed-decimal evidence passed");
} finally {
  try {
    await client.$disconnect();
  } finally {
    await removeProbeNamespace();
  }
}
