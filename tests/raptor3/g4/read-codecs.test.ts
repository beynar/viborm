/**
 * G4 C12 fixed witnesses — inventory family D read crossings, SC-01…SC-14 and
 * SL-01…SL-10, plus Q-R01's malformed-provider-row boundary.
 *
 * Contract sources: `scalar-roundtrip-behavior.ts` (every scalar's public
 * type and exactness), `list-json-filter-behavior.ts` (list containers and
 * JSON documents), `json-null-sentinel-behavior.ts` (the two nulls),
 * `blob-result-parser.core.test.ts` (Uint8Array identity),
 * `decimal-exactness-behavior.ts` / `decimal-list-surface.test.ts` (exact
 * decimal domain and the RF-05 refusals), `geopoint-behavior.ts` and
 * `vector-behavior.ts` (spatial tiers).
 */
import assert from "node:assert/strict";
import { AnyNull, DbNull, JsonNull } from "@schema";
import { Decimal } from "@src/index";
import { canonicalizeDecimal } from "@validation/primitives/decimal-codec";
import { afterEach, beforeEach, describe, it } from "vitest";
import {
  EMBEDDINGS,
  PLACES,
  PLACE_TABLE,
  SPECIMENS,
  SPECIMEN_TABLE,
  type SpecimenValues,
  VECTOR_TABLE,
  codecWorldSchema,
  spatialWorldSchema,
  vectorWorldSchema,
} from "./codec-schema";
import {
  createWitnessWorld,
  expectRead,
  expectRefusal,
  observeFailure,
  rowsOf,
  type WitnessWorld,
} from "./witness-world";

function assertDecimal(actual: unknown, expected: string, label: string): void {
  assert.ok(actual instanceof Decimal, `${label} is not a Decimal`);
  assert.equal(canonicalizeDecimal(actual), expected, label);
}

function assertBytes(actual: unknown, expected: Uint8Array, label: string): void {
  assert.ok(actual instanceof Uint8Array, `${label} is not a Uint8Array`);
  assert.equal(actual.constructor, Uint8Array, `${label} is not exactly Uint8Array`);
  assert.deepEqual([...actual], [...expected], label);
}

function assertMoment(actual: unknown, expected: Date, label: string): void {
  assert.ok(actual instanceof Date, `${label} is not a Date`);
  assert.equal(actual.toISOString(), expected.toISOString(), label);
}

function assertSpecimen(row: unknown, expected: SpecimenValues, who: string): void {
  assert.ok(row !== null && typeof row === "object", `${who}: missing specimen row`);
  const actual = row as Record<string, unknown>;
  assert.equal(actual.id, expected.id, `${who}: id`);
  assert.equal(actual.label, expected.label, `${who}: SC-01 string`);
  assert.equal(typeof actual.flag, "boolean", `${who}: SC-02 boolean type`);
  assert.equal(actual.flag, expected.flag, `${who}: SC-02 boolean`);
  assert.equal(typeof actual.count, "number", `${who}: SC-03 int type`);
  assert.equal(actual.count, expected.count, `${who}: SC-03 int`);
  assert.equal(typeof actual.ratio, "number", `${who}: SC-04 number type`);
  assert.equal(actual.ratio, expected.ratio, `${who}: SC-04 number`);
  assert.equal(typeof actual.big, "bigint", `${who}: SC-05 bigint type`);
  assert.equal(actual.big, expected.big, `${who}: SC-05 bigint`);
  assertDecimal(actual.amount, expected.amount, `${who}: SC-06 decimal`);
  assertMoment(actual.moment, expected.moment, `${who}: SC-07 dateTime`);
  assertMoment(actual.day, expected.day, `${who}: SC-08 date`);
  assert.equal(typeof actual.clock, "string", `${who}: SC-09 time type`);
  assert.equal(actual.clock, expected.clock, `${who}: SC-09 time`);
  assert.equal(actual.status, expected.status, `${who}: SC-10 enum`);
  assert.deepEqual(actual.document, expected.document, `${who}: SC-11 json`);
  assertBytes(actual.payload, expected.payload, `${who}: SC-12 blob`);
  assert.deepEqual(actual.labels, [...expected.labels], `${who}: SL-01`);
  assert.deepEqual(actual.flags, [...expected.flags], `${who}: SL-02`);
  assert.deepEqual(actual.counts, [...expected.counts], `${who}: SL-03`);
  assert.deepEqual(actual.ratios, [...expected.ratios], `${who}: SL-04`);
  assert.deepEqual(actual.bigs, [...expected.bigs], `${who}: SL-05`);
  const amounts = actual.amounts;
  assert.ok(Array.isArray(amounts), `${who}: SL-06 decimal list`);
  assert.equal(amounts.length, expected.amounts.length, `${who}: SL-06 length`);
  expected.amounts.forEach((member, index) => {
    assertDecimal(amounts[index], member, `${who}: SL-06 member ${index}`);
  });
  const moments = actual.moments;
  assert.ok(Array.isArray(moments), `${who}: SL-07 dateTime list`);
  assert.equal(moments.length, expected.moments.length, `${who}: SL-07 length`);
  expected.moments.forEach((member, index) => {
    assertMoment(moments[index], member, `${who}: SL-07 member ${index}`);
  });
  const days = actual.days;
  assert.ok(Array.isArray(days), `${who}: SL-08 date list`);
  expected.days.forEach((member, index) => {
    assertMoment(days[index], member, `${who}: SL-08 member ${index}`);
  });
  assert.deepEqual(actual.clocks, [...expected.clocks], `${who}: SL-09`);
  assert.deepEqual(actual.statuses, [...expected.statuses], `${who}: SL-10`);
}

async function createCodecWorld(): Promise<WitnessWorld> {
  const world = await createWitnessWorld(codecWorldSchema());
  for (const specimen of SPECIMENS) {
    await world.shipped.specimen?.create?.({
      data: { ...specimen, document: specimen.document ?? DbNull },
    });
  }
  world.reset();
  return world;
}

describe("G4 C12 scalar and list codec read crossings", () => {
  let world: WitnessWorld;

  beforeEach(async () => {
    world = await createCodecWorld();
  });

  afterEach(async () => {
    await world?.close();
  });

  it("pins the physical spelling the codec witnesses read back", () => {
    const stored = world.database
      .prepare(
        `SELECT amount_value, moment_value, day_value, clock_value, status_value, big_value, flag_value, document_value, payload_value, label_list, count_list, amount_list
         FROM ${SPECIMEN_TABLE} WHERE id = 1`
      )
      .get() as Record<string, unknown>;
    assert.equal(stored.amount_value, 123_456_001);
    assert.equal(stored.clock_value, "13:45:30");
    assert.equal(stored.status_value, "ACTIVE");
    assert.equal(stored.flag_value, 1);
    assert.equal(stored.label_list, '["alpha","beta"]');
    assert.equal(stored.count_list, "[1,2,3]");
    assert.ok(
      typeof stored.moment_value === "string" ||
        typeof stored.moment_value === "number",
      "a DateTime column must hold a portable physical spelling"
    );
    assert.ok(
      Buffer.isBuffer(stored.payload_value),
      "a blob column must hold real bytes"
    );
    assert.deepEqual(
      [...(stored.payload_value as Buffer)],
      [0, 1, 2, 128, 253, 255]
    );
  });

  it("SC-01…SC-12, SL-01…SL-10 round-trip exactly through findUnique", async () => {
    for (const specimen of SPECIMENS) {
      const shipped = await world.shipped.specimen?.findUnique?.({
        where: { id: specimen.id },
      });
      assertSpecimen(shipped, specimen, "shipped");
      const candidate = await world.candidate.execute("specimen", "findUnique", {
        where: { id: specimen.id },
      });
      assertSpecimen(candidate, specimen, "candidate");
    }
  });

  it("SC-06 and SL-06 keep the exact decimal domain and fresh public values", async () => {
    const first = await world.candidate.execute("specimen", "findUnique", {
      where: { id: 1 },
      select: { amount: true, amounts: true },
    });
    const second = await world.candidate.execute("specimen", "findUnique", {
      where: { id: 1 },
      select: { amount: true, amounts: true },
    });
    assert.ok(first !== null && typeof first === "object");
    assert.ok(second !== null && typeof second === "object");
    const left = first as Record<string, unknown>;
    const right = second as Record<string, unknown>;
    assertDecimal(left.amount, "123456.001", "first decimal");
    assertDecimal(right.amount, "123456.001", "second decimal");
    assert.notEqual(left.amount, right.amount, "a Decimal must be freshly materialized");
    assert.notEqual(left.amounts, right.amounts, "a decimal list must be a fresh array");
  });

  it("SC-11 keeps the database NULL and the JSON null sentinels distinct", async () => {
    await world.shipped.specimen?.update?.({
      where: { id: 2 },
      data: { document: JsonNull },
    });
    await expectRead(
      world,
      "specimen",
      "findMany",
      {
        where: { document: { equals: DbNull } },
        orderBy: { id: "asc" },
        select: { id: true },
      },
      [{ id: 3 }]
    );
    await expectRead(
      world,
      "specimen",
      "findMany",
      {
        where: { document: { equals: JsonNull } },
        orderBy: { id: "asc" },
        select: { id: true },
      },
      [{ id: 2 }]
    );
    await expectRead(
      world,
      "specimen",
      "findMany",
      {
        where: { document: { equals: AnyNull } },
        orderBy: { id: "asc" },
        select: { id: true },
      },
      [{ id: 2 }, { id: 3 }]
    );
    await expectRead(
      world,
      "specimen",
      "findMany",
      {
        where: { document: { path: ["theme"], equals: "dark" } },
        select: { id: true },
      },
      [{ id: 1 }]
    );
  });

  it("SC-12 publishes a fresh Uint8Array per read", async () => {
    const first = rowsOf(
      await world.candidate.execute("specimen", "findMany", {
        where: { id: 1 },
        select: { payload: true },
      })
    );
    const second = rowsOf(
      await world.candidate.execute("specimen", "findMany", {
        where: { id: 1 },
        select: { payload: true },
      })
    );
    assertBytes(first[0]?.payload, new Uint8Array([0, 1, 2, 128, 253, 255]), "first");
    assertBytes(second[0]?.payload, new Uint8Array([0, 1, 2, 128, 253, 255]), "second");
    assert.notEqual(first[0]?.payload, second[0]?.payload, "blob containers must be fresh");
  });

  it("SL-01…SL-05 and SL-07…SL-10 answer the list container predicates", async () => {
    await expectRead(
      world,
      "specimen",
      "findMany",
      { where: { labels: { has: "beta" } }, select: { id: true } },
      [{ id: 1 }]
    );
    await expectRead(
      world,
      "specimen",
      "findMany",
      {
        where: { labels: { hasEvery: ["beta", "alpha"] } },
        select: { id: true },
      },
      [{ id: 1 }]
    );
    await expectRead(
      world,
      "specimen",
      "findMany",
      {
        where: { labels: { hasSome: ["gamma", "missing"] } },
        select: { id: true },
      },
      [{ id: 2 }]
    );
    await expectRead(
      world,
      "specimen",
      "findMany",
      {
        where: { labels: { isEmpty: true } },
        orderBy: { id: "asc" },
        select: { id: true },
      },
      [{ id: 3 }]
    );
    await expectRead(
      world,
      "specimen",
      "findMany",
      { where: { counts: { equals: [1, 2, 3] } }, select: { id: true } },
      [{ id: 1 }]
    );
    await expectRead(
      world,
      "specimen",
      "findMany",
      { where: { statuses: { has: "PAUSED" } }, select: { id: true } },
      [{ id: 2 }]
    );
  });

  it("SL-06 refuses decimal-list ordering and value aggregation (RF-05)", async () => {
    for (const args of [
      { orderBy: { amounts: "asc" }, select: { id: true } },
      { by: ["id"], _sum: { amounts: true } },
    ]) {
      const operation = "by" in args ? "groupBy" : "findMany";
      const shipped = await observeFailure(() =>
        Promise.resolve(world.shipped.specimen?.[operation]?.(args))
      );
      assert.equal(shipped.name, "ValidationError", shipped.message);
      const candidate = await observeFailure(() =>
        world.candidate.execute("specimen", operation, args)
      );
      assert.equal(candidate.name, "ValidationError", candidate.message);
    }
  });

  it("Q-R01 refuses a malformed provider row at the decode boundary", async () => {
    world.database
      .prepare(`UPDATE ${SPECIMEN_TABLE} SET count_value = 'not-an-int' WHERE id = 1`)
      .run();
    const shipped = await observeFailure(() =>
      Promise.resolve(
        world.shipped.specimen?.findUnique?.({
          where: { id: 1 },
          select: { id: true, count: true },
        })
      )
    );
    const candidate = await observeFailure(() =>
      world.candidate.execute("specimen", "findUnique", {
        where: { id: 1 },
        select: { id: true, count: true },
      })
    );
    assert.notEqual(
      shipped.constructorName,
      "TypeError",
      "a malformed provider row must carry a public error identity"
    );
    assert.equal(
      candidate.constructorName,
      shipped.constructorName,
      `the candidate raised ${candidate.constructorName} (${candidate.message}) where the shipped engine raises ${shipped.constructorName}`
    );
  });
});

describe("G4 C12 spatial codec read crossings (SC-13, SC-14)", () => {
  let world: WitnessWorld;

  beforeEach(async () => {
    world = await createWitnessWorld(spatialWorldSchema());
    for (const place of PLACES) {
      await world.shipped.place?.create?.({ data: { ...place } });
    }
    world.reset();
  });

  afterEach(async () => {
    await world?.close();
  });

  it("pins the physical spelling of a point column", () => {
    const stored = world.database
      .prepare(`SELECT place_location FROM ${PLACE_TABLE} WHERE id = 1`)
      .get() as Record<string, unknown>;
    assert.equal(
      stored.place_location,
      '{"longitude":2.3522,"latitude":48.8566}'
    );
  });

  it("SC-14 round-trips an exact EPSG:4326 point and answers within", async () => {
    await expectRead(
      world,
      "place",
      "findUnique",
      { where: { id: 1 }, select: { name: true, location: true } },
      { name: "paris", location: { longitude: 2.3522, latitude: 48.8566 } }
    );
    await expectRead(
      world,
      "place",
      "findMany",
      {
        where: {
          location: {
            within: { bounds: { south: 48, west: 1, north: 49, east: 3 } },
          },
        },
        orderBy: { id: "asc" },
        select: { id: true },
      },
      [{ id: 1 }]
    );
  });

  /** The metre-distance tier is witnessed positively only on a capable provider. */
  it("Q-W07 refuses the metre-distance tier identically without provider support", async () => {
    await expectRefusal(
      world,
      "place",
      "findMany",
      {
        where: { location: { distance: { to: PLACES[0]?.location, lte: 1 } } },
        orderBy: { id: "asc" },
        select: { id: true },
      },
      {
        name: "FeatureNotSupportedError",
        message: /GeoPoint distance is not supported by this provider/,
      }
    );
  });
});

describe("G4 C12 vector capability boundary (SC-13)", () => {
  let world: WitnessWorld;

  beforeEach(async () => {
    // This is the one witness world whose row CANNOT be written by the shipped
    // client: both engines refuse a vector write here, so an engine-written
    // seed would leave the table empty and make the read half vacuous. The row
    // is therefore hand-written with raw SQL, the mechanism `WitnessWorld`
    // exposes for exactly this case, and the physical spelling it writes is
    // pinned in the cell below.
    world = await createWitnessWorld(vectorWorldSchema(), {
      seed: (database) => {
        const seeded = EMBEDDINGS[0];
        assert.ok(seeded, "SC-13 needs a seeded embedding");
        database
          .prepare(
            `INSERT INTO ${VECTOR_TABLE} (id, embedded_name, embedded_vector) VALUES (?, ?, ?)`
          )
          .run(seeded.id, seeded.name, JSON.stringify(seeded.embedding));
      },
    });
  });

  afterEach(async () => {
    await world?.close();
  });

  /**
   * SQLite declares no vector tier (`sqlite-adapter.ts` `vector =
   * unsupportedVector`). The WRITE is where the capability is asked: the
   * contract is a refusal with one identity, not a silent degradation, and the
   * candidate must refuse identically. The READ is still answered — the vector
   * field carries as JSON — so the same cell measures that a stored vector
   * comes back decoded from both engines. What is NOT witnessed here is the
   * round trip through the engine's own vector writer; that needs a capable
   * provider, in `tests/raptor3/g4/native/`.
   */
  it("SC-13 refuses a vector write identically and decodes a stored vector", async () => {
    const seeded = EMBEDDINGS[0];
    const refused = EMBEDDINGS[1];
    assert.ok(seeded && refused, "SC-13 needs two embedding fixtures");
    // A row the seed did NOT write, so a duplicate key can never stand in for
    // the capability refusal.
    const shippedWrite = await observeFailure(() =>
      Promise.resolve(
        world.shipped.embedded?.create?.({ data: { ...refused } })
      )
    );
    const candidateWrite = await observeFailure(() =>
      world.candidate.execute("embedded", "create", { data: { ...refused } })
    );
    assert.equal(
      candidateWrite.constructorName,
      shippedWrite.constructorName,
      `the candidate raised ${candidateWrite.constructorName} (${candidateWrite.message}) where the shipped engine raises ${shippedWrite.constructorName}`
    );
    const stored = world.database
      .prepare(`SELECT embedded_vector FROM ${VECTOR_TABLE} WHERE id = ?`)
      .get(seeded.id) as Record<string, unknown>;
    assert.equal(stored.embedded_vector, "[1,0,0]");
    // One read, two facts: the refused write stored nothing (a leaked row would
    // show up as a second member) and both engines decode the stored list to
    // the hand value.
    await expectRead(
      world,
      "embedded",
      "findMany",
      { select: { embedding: true } },
      [{ embedding: [...seeded.embedding] }]
    );
  });
});
