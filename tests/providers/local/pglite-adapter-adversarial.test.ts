import { createClient } from "@drivers/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { vector } from "@electric-sql/pglite-pgvector";
import { postgis } from "@electric-sql/pglite-postgis";
import { UnsupportedOperationError } from "@errors";
import { s } from "@schema";
import { PG } from "@schema/scalars/native-types";
import { type Sql, sql } from "@sql";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterAll, beforeAll, expect, test } from "vitest";

const event = s.model({
  id: s.int().id(),
  at: s.dateTime(),
  day: s.date(),
  dates: s.date().array(),
  moments: s.dateTime().array(),
  body: s.json(PG.JSON.JSON),
});
const place = s.model({ id: s.int().id(), location: s.point() });
const embedding = s.model({
  id: s.int().id(),
  value: s.vector().dimension(3).nullable(),
});
const label = s.model({
  id: s.int().id(),
  text: s.string(PG.STRING.CITEXT),
  exact: s.string(),
});
const nativeText = s.model({
  id: s.int().id(),
  ip: s.string(PG.STRING.INET),
  network: s.string(PG.STRING.CIDR),
  mac: s.string(PG.STRING.MACADDR),
  uuid: s.string(PG.STRING.UUID),
  document: s.string(PG.STRING.XML).nullable(),
  lexemes: s.string(PG.STRING.TSVECTOR),
  query: s.string(PG.STRING.TSQUERY),
  bits: s.string(PG.STRING.BIT(8)),
});
const client = createClient({
  schema: { event, place, embedding, label, nativeText },
  options: { extensions: { postgis, vector, citext } },
  postgis: true,
  pgvector: true,
});

beforeAll(async () => {
  await client.$executeRawUnsafe("CREATE EXTENSION postgis");
  await client.$executeRawUnsafe("CREATE EXTENSION vector");
  await client.$executeRawUnsafe("CREATE EXTENSION citext");
  await syncLiveSchema(client);
});
afterAll(() => client.$disconnect());

test("citext preserves one native case rule across literal text predicates", async () => {
  await client.label.create({
    data: { id: 1, text: "A%_\\Z", exact: "A%_\\Z" },
  });
  for (const filter of [
    { equals: "a%_\\z" },
    { contains: "%_\\z" },
    { startsWith: "a%_" },
    { endsWith: "\\z" },
  ]) {
    expect(await client.label.count({ where: { text: filter } })).toBe(1);
    expect(await client.label.count({ where: { exact: filter } })).toBe(0);
  }
  expect(
    await client.label.count({ where: { text: { contains: "%_x" } } })
  ).toBe(0);
});

test("zero and nullable vectors have defined nullable distance results", async () => {
  await client.embedding.createMany({
    data: [
      { id: 1, value: [0, 0, 0] },
      { id: 2, value: [1, 0, 0] },
      { id: 3, value: null },
    ],
  });
  const cosine = await client.embedding.findMany({
    orderBy: { id: "asc" },
    select: {
      id: true,
      value: { _distance: { to: [1, 0, 0], metric: "cosine" } },
    },
  });
  expect(cosine.map((row) => row._distance)).toEqual([null, 0, null]);
  const zeroTarget = await client.embedding.findMany({
    select: { value: { _distance: { to: [0, 0, 0], metric: "cosine" } } },
  });
  expect(zeroTarget.every((row) => row._distance === null)).toBe(true);
  const l2 = await client.embedding.findMany({
    orderBy: { id: "asc" },
    select: { value: { _distance: { to: [0, 0, 0], metric: "l2" } } },
  });
  expect(l2.map((row) => row._distance)).toEqual([0, 1, null]);
});

test("invalid vector components and dimensions cannot commit", async () => {
  for (const value of [
    [1e100, 0, 0],
    [Number.POSITIVE_INFINITY, 0, 0],
    [1, 2],
  ]) {
    await expect(
      client.embedding.create({ data: { id: 99, value } })
    ).rejects.toThrow();
    expect(await client.embedding.count({ where: { id: 99 } })).toBe(0);
  }
});

test("year zero crosses scalar and array PostgreSQL boundaries exactly", async () => {
  const instant = new Date("0000-02-29T12:30:59.999Z");
  const midnight = new Date("0000-02-29T00:00:00.000Z");
  await client.event.create({
    data: {
      id: 1,
      at: instant,
      day: midnight,
      dates: [midnight],
      moments: [instant],
      body: { title: "hello", score: 2 },
    },
  });
  const row = await client.event.findUniqueOrThrow({ where: { id: 1 } });
  expect(row.at.toISOString()).toBe(instant.toISOString());
  expect(row.day.toISOString()).toBe(midnight.toISOString());
  expect(row.dates.map((value) => value.toISOString())).toEqual([
    midnight.toISOString(),
  ]);
  expect(row.moments.map((value) => value.toISOString())).toEqual([
    instant.toISOString(),
  ]);
  expect(
    await client.event.count({
      where: { at: instant, moments: { has: instant } },
    })
  ).toBe(1);
  expect(
    await client.event.count({
      where: { body: { path: ["title"], string_contains: "ell" } },
    })
  ).toBe(1);
  expect(
    await client.event.count({
      where: { body: { equals: { title: "hello", score: 2 } } },
    })
  ).toBe(1);
});

test("wide JSON projection preserves every field and aggregate scope", async () => {
  const adapter = client.$driver.adapter;
  const fields: [string, Sql][] = Array.from({ length: 121 }, (_, index) => [
    `field${index}`,
    index === 120 ? sql.raw`COUNT(*)` : sql`${index}::int`,
  ]);
  const expression = adapter.json.object(fields);
  const rows = await client.$queryRaw<{ payload: Record<string, number> }>(
    sql`SELECT ${expression} AS payload FROM (VALUES (1), (2)) AS source(value)`
  );
  expect(rows[0]!.payload).toEqual(
    Object.fromEntries(
      fields.map(([key], index) => [key, index === 120 ? 2 : index])
    )
  );
});

test("bounds and their negation retain every coordinate-defined point", async () => {
  const points = [
    { id: 1, location: { longitude: 0, latitude: 40.5 } },
    { id: 2, location: { longitude: 0, latitude: 45 } },
    { id: 3, location: { longitude: 19.9, latitude: 40.1 } },
    { id: 4, location: { longitude: 0, latitude: -49.5 } },
    { id: 5, location: { longitude: 0, latitude: 0.5 } },
  ];
  await client.place.createMany({ data: points });
  for (const bounds of [
    { south: 40, west: -20, north: 50, east: 20 },
    { south: 40, west: -170, north: 50, east: 170 },
    { south: -50, west: -20, north: -40, east: 20 },
    { south: -1, west: -170, north: 1, east: 170 },
  ]) {
    const expected = points
      .filter(
        ({ location }) =>
          location.longitude >= bounds.west &&
          location.longitude <= bounds.east &&
          location.latitude >= bounds.south &&
          location.latitude <= bounds.north
      )
      .map(({ id }) => id);
    expect(
      (
        await client.place.findMany({
          where: { location: { within: { bounds } } },
          orderBy: { id: "asc" },
        })
      ).map(({ id }) => id)
    ).toEqual(expected);
    expect(
      (
        await client.place.findMany({
          where: { location: { not: { within: { bounds } } } },
          orderBy: { id: "asc" },
        })
      ).map(({ id }) => id)
    ).toEqual(
      points.filter(({ id }) => !expected.includes(id)).map(({ id }) => id)
    );
  }
  const bounds = { south: 40, west: -20, north: 50, east: 20 };
  expect(
    await client.place.deleteMany({
      where: { location: { not: { within: { bounds } } } },
    })
  ).toEqual({ count: 2 });
  expect(
    (await client.place.findMany({ orderBy: { id: "asc" } })).map(
      ({ id }) => id
    )
  ).toEqual([1, 2, 3]);
});

test("distance upper bounds retain the equatorward rim at every scale", async () => {
  const radius = 6_371_008.8;
  const radians = Math.PI / 180;
  const centers = [
    { longitude: 0, latitude: 70 },
    { longitude: 10, latitude: 25 },
    { longitude: 90, latitude: 0 },
    { longitude: -90, latitude: -25 },
    { longitude: 179, latitude: -70 },
  ];
  let nextId = 1000;
  for (const center of centers)
    for (const upper of [100, 10_000, 500_000]) {
      const firstId = nextId;
      const points: {
        id: number;
        location: { longitude: number; latitude: number };
      }[] = [];
      for (const bearing of [0, 45, 90, 135, 180, 225, 270, 315]) {
        for (const fraction of [0.5, 0.99, 0.999, 1.001]) {
          const angle = (upper * fraction) / radius;
          const lat = center.latitude * radians;
          const azimuth = bearing * radians;
          const latitude = Math.asin(
            Math.sin(lat) * Math.cos(angle) +
              Math.cos(lat) * Math.sin(angle) * Math.cos(azimuth)
          );
          const longitude =
            center.longitude * radians +
            Math.atan2(
              Math.sin(azimuth) * Math.sin(angle) * Math.cos(lat),
              Math.cos(angle) - Math.sin(lat) * Math.sin(latitude)
            );
          points.push({
            id: nextId++,
            location: {
              longitude: ((longitude / radians + 540) % 360) - 180,
              latitude: latitude / radians,
            },
          });
        }
      }
      await client.place.createMany({ data: points });
      const expected = points
        .filter(({ location }) => {
          const deltaLat = (location.latitude - center.latitude) * radians;
          const deltaLon = (location.longitude - center.longitude) * radians;
          const a =
            Math.sin(deltaLat / 2) ** 2 +
            Math.cos(center.latitude * radians) *
              Math.cos(location.latitude * radians) *
              Math.sin(deltaLon / 2) ** 2;
          return (
            2 * radius * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) <= upper
          );
        })
        .map(({ id }) => id);
      const range = { gte: firstId, lt: nextId };
      for (const bound of [{ lte: upper }, { lt: upper }]) {
        const rows = await client.place.findMany({
          where: {
            id: range,
            location: { distance: { to: center, ...bound } },
          },
          orderBy: { id: "asc" },
          select: { id: true },
        });
        expect(rows.map(({ id }) => id)).toEqual(expected);
      }
      const outside = await client.place.findMany({
        where: {
          id: range,
          location: { not: { distance: { to: center, lte: upper } } },
        },
        orderBy: { id: "asc" },
        select: { id: true },
      });
      expect(outside.map(({ id }) => id)).toEqual(
        points.filter(({ id }) => !expected.includes(id)).map(({ id }) => id)
      );
    }
});

test("native PostgreSQL string values support text patterns/mode while equality stays native", async () => {
  await client.nativeText.create({
    data: {
      id: 1,
      ip: "192.0.2.1/24",
      network: "192.0.2.0/24",
      mac: "08:00:2b:01:02:03",
      uuid: "550e8400-e29b-41d4-a716-446655440000",
      document: '<Root Attr="X">value</Root>',
      lexemes: "'Ab':1 'Cd':2",
      query: "'Ab' & 'Cd'",
      bits: "10101010",
    },
  });
  for (const where of [
    { ip: { contains: "192.0", startsWith: "192", endsWith: "/24" } },
    { network: { contains: "192.0.2" } },
    { mac: { contains: "2b:01" } },
    { uuid: { startsWith: "550e8400" } },
    { document: { contains: "Root" } },
    { lexemes: { contains: "Ab" } },
    { query: { contains: "Cd" } },
    { bits: { endsWith: "10" } },
  ])
    expect(await client.nativeText.count({ where })).toBe(1);
  expect(
    await client.nativeText.count({
      where: { mac: { equals: "08:00:2B:01:02:03" } },
    })
  ).toBe(1);
  expect(
    await client.nativeText.count({
      where: { uuid: { equals: "550E8400-E29B-41D4-A716-446655440000" } },
    })
  ).toBe(1);
  expect(
    await client.nativeText.count({
      where: { uuid: { mode: "insensitive", startsWith: "550E8400" } },
    })
  ).toBe(1);
  expect(
    await client.nativeText.count({
      where: { document: { mode: "insensitive", contains: "root" } },
    })
  ).toBe(1);
  await expect(
    client.nativeText.count({
      where: { document: { equals: '<Root Attr="X">value</Root>' } },
    })
  ).rejects.toBeInstanceOf(UnsupportedOperationError);
  expect(await client.nativeText.count({ where: { document: null } })).toBe(0);
});
