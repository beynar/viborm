/**
 * G4-02 CLOSURE review — adversarial probes against obligation 2, the B-1c
 * cache result codec composed in `raptor3/route/client-route.ts`
 * (`cacheCodec` / `shapeCodec` / `leafCodec`).
 *
 * The unit's own LX-07 pin stores and materializes ONE string leaf
 * (`entry.findMany({ select: { label: true } })`) and §R4.9 item 5 records that
 * no cell compares a cached graph against the shipped route's. These cells
 * store and materialize the scalar-rich codec world instead — every scalar
 * crossing the G4 C12 witnesses cover, plus lists, a nullable JSON column, a
 * relation include, `_count`, an aggregate and an absent row — and compare
 *
 *   (a) each route's cache HIT against its own MISS (round-trip fidelity), and
 *   (b) the candidate route's hit against the shipped route's hit (NS-04).
 *
 * A failure of (a) alone is the candidate codec losing a value's meaning; a
 * failure of (b) alone is a read divergence the cache then preserves.
 */
import assert from "node:assert/strict";
import type { VibORMClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCandidateClient } from "@query-engine/raptor3/route/client-route";
import { DbNull, s } from "@schema";
import { MemoryCache } from "@src/cache/drivers/memory";
import { cache } from "@src/cache/exports";
import { createClient } from "@src/index";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { afterEach, describe, it } from "vitest";
import { SPECIMENS, codecWorldSchema } from "../../codec-schema";

const holder = s
  .model({
    id: s.int().id(),
    label: s.string(),
    tag: s.string().nullable(),
    parts: s.toMany(() => part),
  })
  .map("r3c_cache_holders");
const part = s
  .model({
    id: s.int().id(),
    name: s.string(),
    holderId: s.int().nullable(),
    holder: s
      .toOne(() => holder)
      .fields("holderId")
      .references("id"),
  })
  .map("r3c_cache_parts");

const schema = { ...codecWorldSchema(), holder, part };

type Route = "shipped" | "candidate";

const openWorlds: { close(): Promise<void>; database: Database.Database }[] = [];

async function createWorld(route: Route) {
  const database = new Database(":memory:");
  const driver = new SQLite3Driver({ client: database });
  const config = { driver, schema };
  const base = (
    route === "shipped" ? createClient(config) : createCandidateClient(config)
  ) as VibORMClient<{ driver: SQLite3Driver; schema: typeof schema }>;
  const migration = await syncLiveSchema(base);
  if (!migration.applied) throw new Error("the world's schema did not apply");
  const background: Promise<unknown>[] = [];
  const client = base.$extends(
    cache({
      driver: new MemoryCache(),
      waitUntil(promise) {
        background.push(promise);
      },
    })
  );
  // The physical spelling of every scalar is the shipped client's, as the
  // codec fixture requires.
  const writer = base as unknown as Record<
    string,
    Record<string, (args: unknown) => Promise<unknown>>
  >;
  for (const specimen of SPECIMENS)
    await writer.specimen!.create!({
      data: { ...specimen, document: specimen.document ?? DbNull },
    });
  await writer.holder!.create!({ data: { id: 1, label: "h", tag: null } });
  await writer.part!.create!({ data: { id: 1, name: "p", holderId: 1 } });
  openWorlds.push({ close: () => client.$disconnect(), database });
  return {
    client: client as unknown as Record<
      string,
      Record<string, (args: unknown) => Promise<unknown>>
    >,
    async settle(): Promise<void> {
      await Promise.all(background.splice(0));
    },
  };
}

afterEach(async () => {
  for (const world of openWorlds.splice(0)) {
    await world.close();
    world.database.close();
  }
});

/** A type-revealing serialization: a cached value must keep its meaning. */
function reveal(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "bigint") return `bigint:${value}`;
  if (value instanceof Date) return `date:${value.toISOString()}`;
  if (value instanceof Uint8Array) return `bytes:${[...value].join(",")}`;
  if (Array.isArray(value)) return value.map(reveal);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const name = record.constructor?.name;
    if (name && name !== "Object")
      return `${name}:${String((record as { toString(): string }).toString())}`;
    return Object.fromEntries(
      Object.entries(record)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, reveal(item)])
    );
  }
  return value;
}

interface Measured {
  readonly miss: string;
  readonly hit: string;
  readonly fresh: boolean;
}

async function measure(
  route: Route,
  model: string,
  operation: string,
  args: unknown
): Promise<Measured> {
  const world = await createWorld(route);
  const cached = (
    world.client as unknown as { $withCache(): typeof world.client }
  ).$withCache();
  const call = () => cached[model]![operation]!(args);
  let miss: unknown;
  let hit: unknown;
  try {
    miss = await call();
    await world.settle();
    hit = await call();
    await world.settle();
  } catch (error) {
    const answer = `${(error as Error).constructor.name}: ${(error as Error).message}`;
    return { miss: answer, hit: answer, fresh: true };
  }
  return {
    miss: JSON.stringify(reveal(miss)),
    hit: JSON.stringify(reveal(hit)),
    // Identity is only meaningful for a graph; a primitive answer (a count, a
    // located `null`) is the same value by construction.
    fresh: typeof miss === "object" && miss !== null ? miss !== hit : true,
  };
}

async function compare(
  name: string,
  model: string,
  operation: string,
  args: unknown
): Promise<void> {
  const shipped = await measure("shipped", model, operation, args);
  const candidate = await measure("candidate", model, operation, args);
  // biome-ignore lint/suspicious/noConsole: the probe's measurement IS its output.
  console.log(
    `[${name}]\n  shipped   miss ${shipped.miss}\n            hit  ${shipped.hit}\n  candidate miss ${candidate.miss}\n            hit  ${candidate.hit}`
  );
  assert.equal(
    candidate.hit,
    candidate.miss,
    `${name}: the candidate's cached value does not materialize as the read published it`
  );
  assert.equal(
    shipped.hit,
    shipped.miss,
    `${name}: the SHIPPED route's own round trip (control)`
  );
  assert.equal(
    candidate.fresh,
    true,
    `${name}: the candidate materialized the same graph object twice`
  );
  assert.equal(
    candidate.hit,
    shipped.hit,
    `${name}: NS-04 — the cached value the candidate serves is not the shipped one`
  );
}

describe("G4-02 closure review — the composed cache result codec", () => {
  it("round-trips every scalar crossing the codec world declares", async () => {
    await compare("all scalars, findMany", "specimen", "findMany", {
      orderBy: { id: "asc" },
    });
  }, 120_000);

  it("round-trips a single located row", async () => {
    await compare("findUnique row", "specimen", "findUnique", {
      where: { id: 1 },
    });
  }, 120_000);

  it("round-trips an ABSENT row", async () => {
    await compare("findUnique absent", "specimen", "findUnique", {
      where: { id: 404 },
    });
  }, 120_000);

  it("round-trips a projection of a nullable JSON column", async () => {
    await compare("nullable json projection", "specimen", "findMany", {
      select: { id: true, document: true, amount: true, moment: true },
      orderBy: { id: "asc" },
    });
  }, 120_000);

  it("round-trips a relation include and a nullable to-one", async () => {
    await compare("relation include", "holder", "findMany", {
      include: { parts: true },
    });
  }, 120_000);

  it("round-trips a nested to-one that is NULL", async () => {
    await compare("nullable to-one", "part", "findMany", {
      select: { id: true, holder: { select: { id: true, tag: true } } },
    });
  }, 120_000);

  it("round-trips a relation _count", async () => {
    await compare("relation count", "holder", "findMany", {
      select: { id: true, _count: { select: { parts: true } } },
    });
  }, 120_000);

  it("round-trips a count operation", async () => {
    await compare("count", "specimen", "count", {});
  }, 120_000);

  it("round-trips an integer-only aggregate", async () => {
    await compare("aggregate, integers only", "specimen", "aggregate", {
      _sum: { count: true },
      _avg: { count: true },
      _count: true,
    });
  }, 120_000);

  it("round-trips a single-row decimal _sum (the widened-sum codec branch)", async () => {
    await compare("aggregate, decimal sum of one row", "specimen", "aggregate", {
      where: { id: 1 },
      _sum: { amount: true },
    });
  }, 120_000);

  it("round-trips an aggregate over a decimal and a number", async () => {
    await compare("aggregate", "specimen", "aggregate", {
      _sum: { amount: true, count: true },
      _avg: { ratio: true },
      _min: { moment: true },
      _count: true,
    });
  }, 120_000);
});
