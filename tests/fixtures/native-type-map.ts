// biome-ignore-all lint/suspicious/noMisplacedAssertion: Shared assertion helpers are invoked only from registered tests.
/**
 * Live cells for issue #45 — one schema, a native type per dialect.
 *
 * Shared by the SQLite3 and PGlite suites (`tests/providers/local/`) and the
 * PostgreSQL and MySQL docker suites (`tests/providers/docker/`). Every
 * provider runs the SAME declarations; what differs is only which entry of
 * each map its dialect selects, so each cell asserts the provider's own
 * catalog and physical values, then the ordinary public reads and writes, the
 * selected bulk results and the cache codec over those columns, and finally
 * the migration contract: a second push is a no-op, a change to this dialect's
 * entry is a change, and a change to the other dialects' entries is not.
 *
 * Every native type here is built in; nothing needs an extension. Parameterized
 * timestamps and varchar arrays now retain their physical modifiers through
 * migration introspection and ordinary query decoding.
 */

import { cache } from "@cache/extension";
import type { VibORMClient, VibORMConfig } from "@client/client";
import type { MigrationClient } from "@migrations/push/planner";
import { s } from "@schema";
import {
  MYSQL,
  type NativeTypeMap,
  PG,
  SQLITE,
} from "@schema/scalars/native-types";
import { sql } from "@sql";
import { CountingMemoryCache } from "@tests/fixtures/counting-memory-cache";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { expect, test } from "vitest";

export type NativeMapDialect = "pg" | "mysql" | "sqlite";

/** The entries a migration-contract variant moves. */
interface Entries {
  readonly handle: NativeTypeMap;
  readonly seenAt: NativeTypeMap;
}

const BASE: Entries = {
  handle: { pg: PG.STRING.VARCHAR(40), mysql: MYSQL.STRING.VARCHAR(40) },
  seenAt: { sqlite: SQLITE.DATETIME.INTEGER },
};

/** The identifier storage both the key and its foreign key declare. */
const ID_STORAGE = { pg: PG.BLOB.BYTEA, mysql: MYSQL.STRING.VARCHAR(36) };

function nativeMapSchema(entries: Entries) {
  const owner = s
    .model({
      id: s.string(ID_STORAGE).uuid().id(),
      handle: s.string(entries.handle).unique(),
      score: s.int({ pg: PG.INT.SMALLINT, mysql: MYSQL.INT.SMALLINT }),
      ratio: s.number({ pg: PG.FLOAT.REAL, mysql: MYSQL.FLOAT.FLOAT }),
      seenAt: s.dateTime(entries.seenAt),
      // A list keeps its dialect's container: MySQL's entry describes one
      // member, which a JSON list has no column for.
      tags: s.string({ mysql: MYSQL.STRING.VARCHAR(20) }).array(),
      pets: s.toMany(() => pet),
    })
    .map("ntm_live_owners");
  const pet = s
    .model({
      id: s.string().id(),
      name: s.string(),
      ownerId: s.string(ID_STORAGE),
      owner: s
        .toOne(() => owner)
        .fields("ownerId")
        .references("id"),
    })
    .map("ntm_live_pets");
  return { owner, pet };
}

export const nativeTypeMapSchema = nativeMapSchema(BASE);

export type NativeMapSchema = ReturnType<typeof nativeMapSchema>;

type NativeMapClient = VibORMClient<VibORMConfig<NativeMapSchema>>;

/** A variant that moves only `dialect`'s entries, or only the others'. */
function variant(dialect: NativeMapDialect, own: boolean): NativeMapSchema {
  const moves = (candidate: NativeMapDialect) =>
    own ? candidate === dialect : candidate !== dialect;
  return nativeMapSchema({
    handle: {
      pg: moves("pg") ? PG.STRING.VARCHAR(60) : PG.STRING.VARCHAR(40),
      mysql: moves("mysql")
        ? MYSQL.STRING.VARCHAR(60)
        : MYSQL.STRING.VARCHAR(40),
    },
    seenAt: {
      sqlite: moves("sqlite") ? SQLITE.DATETIME.REAL : SQLITE.DATETIME.INTEGER,
    },
  });
}

const OWNER_ID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
const SECOND_ID = "b1ffcd88-8d1a-4ef8-bb6d-6bb9bd380a22";
const SEEN = new Date("2026-01-15T10:30:00.789Z");
const LATER = new Date("2026-03-01T08:00:00.123Z");

/** The catalog's own spelling of each column's type, lowercased. */
async function catalog(
  client: NativeMapClient,
  dialect: NativeMapDialect,
  table: string,
  namespace: string
): Promise<Record<string, string>> {
  const rows =
    dialect === "sqlite"
      ? await client.$queryRaw<{ name: string; type: string }>(
          sql`SELECT name, type FROM pragma_table_info(${table})`
        )
      : dialect === "mysql"
        ? await client.$queryRaw<{ name: string; type: string }>(
            sql`SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type FROM information_schema.COLUMNS WHERE TABLE_NAME = ${table} AND TABLE_SCHEMA = DATABASE()`
          )
        : await client.$queryRaw<{ name: string; type: string }>(
            sql`SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = ${table} AND n.nspname = ${namespace} AND a.attnum > 0 AND NOT a.attisdropped`
          );
  return Object.fromEntries(
    rows.map((row) => [String(row.name), String(row.type).toLowerCase()])
  );
}

const hex = (value: unknown): string =>
  value instanceof Uint8Array
    ? [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("")
    : `not bytes: ${String(value)}`;

export interface NativeTypeMapCellOptions {
  readonly dialect: NativeMapDialect;
  /** The PostgreSQL namespace the tables live in; unused elsewhere. */
  readonly namespace?: () => string;
  readonly client: () => NativeMapClient;
  /** A client for another schema over the SAME database. */
  readonly clientFor: (schema: NativeMapSchema) => MigrationClient;
  /** Empty both tables before a cell. */
  readonly reset: () => Promise<void>;
  /** What this provider's catalog reports for each table. */
  readonly expectedCatalog: {
    readonly owners: Record<string, string>;
    readonly pets: Record<string, string>;
  };
  /** How the raw (physical) boundary returns the key and the timestamp. */
  readonly raw: {
    readonly id: "bytes" | "text";
    readonly seenAt: "epochMillis" | "provider";
  };
}

export function nativeTypeMapCells(options: NativeTypeMapCellOptions): void {
  const { dialect } = options;
  const namespace = () => options.namespace?.() ?? "public";
  const quote = (table: string) =>
    dialect === "mysql" ? `\`${table}\`` : `"${table}"`;
  const qualified = (table: string) =>
    dialect === "pg" ? `"${namespace()}".${quote(table)}` : quote(table);

  const seed = async (client: NativeMapClient) => {
    await options.reset();
    await client.owner.create({
      data: {
        id: OWNER_ID,
        handle: "ada",
        score: 7,
        ratio: 0.5,
        seenAt: SEEN,
        tags: ["one", "two"],
        pets: { create: [{ id: "p1", name: "Rex" }] },
      },
    });
  };

  test("the catalog holds each dialect's own entry", async () => {
    const client = options.client();
    expect(
      await catalog(client, dialect, "ntm_live_owners", namespace())
    ).toEqual(options.expectedCatalog.owners);
    expect(
      await catalog(client, dialect, "ntm_live_pets", namespace())
    ).toEqual(options.expectedCatalog.pets);
  });

  test("the physical values are the ones the columns declare", async () => {
    const client = options.client();
    await seed(client);
    const [row] = await client.$queryRawUnsafe<Record<string, unknown>>(
      `SELECT ${quote("id")} AS id, ${quote("seenAt")} AS seen FROM ${qualified("ntm_live_owners")}`
    );
    if (options.raw.id === "bytes") {
      expect(hex(row?.id)).toBe(OWNER_ID.replaceAll("-", ""));
    } else {
      expect(row?.id).toBe(OWNER_ID);
    }
    if (options.raw.seenAt === "epochMillis") {
      expect(row?.seen).toBe(SEEN.getTime());
    }
  });

  test("ordinary reads and writes decode through the declared storage", async () => {
    const client = options.client();
    await seed(client);
    const expected = {
      id: OWNER_ID,
      handle: "ada",
      score: 7,
      ratio: 0.5,
      seenAt: SEEN,
      tags: ["one", "two"],
    };
    await expect(
      client.owner.findUnique({ where: { id: OWNER_ID } })
    ).resolves.toEqual(expected);
    await expect(
      client.owner.findMany({
        where: { handle: "ada", seenAt: { gte: SEEN } },
        include: { pets: true },
      })
    ).resolves.toEqual([
      { ...expected, pets: [{ id: "p1", name: "Rex", ownerId: OWNER_ID }] },
    ]);
    await expect(
      client.pet.findFirst({
        where: { owner: { id: OWNER_ID } },
        select: { owner: { select: { id: true, seenAt: true } } },
      })
    ).resolves.toEqual({ owner: { id: OWNER_ID, seenAt: SEEN } });
    await expect(
      client.owner.update({
        where: { id: OWNER_ID },
        data: { seenAt: LATER, tags: ["three"] },
        select: { seenAt: true, tags: true },
      })
    ).resolves.toEqual({ seenAt: LATER, tags: ["three"] });
  });

  test("selected bulk results decode the same way", async () => {
    const client = options.client();
    await seed(client);
    await expect(
      client.owner.createMany({
        data: [
          {
            id: SECOND_ID,
            handle: "grace",
            score: 3,
            ratio: 0.25,
            seenAt: LATER,
            tags: [],
          },
        ],
        select: { id: true, seenAt: true, tags: true },
      })
    ).resolves.toEqual([{ id: SECOND_ID, seenAt: LATER, tags: [] }]);
    const updated = await client.owner.updateMany({
      where: { id: { in: [OWNER_ID, SECOND_ID] } },
      data: { score: 9 },
      select: { id: true, score: true, seenAt: true },
    });
    expect(
      [...updated].sort((left, right) => left.id.localeCompare(right.id))
    ).toEqual([
      { id: OWNER_ID, score: 9, seenAt: SEEN },
      { id: SECOND_ID, score: 9, seenAt: LATER },
    ]);
  });

  test("the cache codec returns the same values, fresh", async () => {
    const client = options.client();
    await seed(client);
    const store = new CountingMemoryCache();
    const cached = client.$extends(cache({ driver: store }));
    const read = () =>
      cached.$withCache().owner.findMany({
        where: { id: OWNER_ID },
        select: { id: true, seenAt: true, tags: true },
      });
    const first = await read();
    // Move the row behind the cache, through the uncached client: a second
    // read that still answers SEEN was decoded from the cache entry.
    await client.owner.update({
      where: { id: OWNER_ID },
      data: { seenAt: LATER },
    });
    const second = await read();
    expect({ reads: store.reads, writes: store.writes }).toEqual({
      reads: 2,
      writes: 1,
    });
    expect(second).toEqual([
      { id: OWNER_ID, seenAt: SEEN, tags: ["one", "two"] },
    ]);
    expect(second).toEqual(first);
    expect(second[0]?.seenAt).not.toBe(first[0]?.seenAt);
    expect(second[0]?.seenAt).toBeInstanceOf(Date);
  });

  test("a second push is a no-op", async () => {
    const again = await syncLiveSchema(options.client(), { dryRun: true });
    expect(again.operations).toEqual([]);
  });

  test("changing this dialect's entry is a change; changing the others' is not", async () => {
    const others = await syncLiveSchema(
      options.clientFor(variant(dialect, false)),
      { dryRun: true }
    );
    expect(others.operations).toEqual([]);
    const own = await syncLiveSchema(
      options.clientFor(variant(dialect, true)),
      { dryRun: true }
    );
    expect(
      own.operations.map((operation) =>
        operation.id.slice(0, operation.id.indexOf(":"))
      )
    ).toEqual(["alterColumn"]);
    expect(own.sql.join("\n")).toContain(
      dialect === "sqlite" ? "seenAt" : "handle"
    );
  });
}
