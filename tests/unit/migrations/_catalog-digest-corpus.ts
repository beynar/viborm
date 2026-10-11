/**
 * The corpus the PostgreSQL catalog digest (plan D5, decision 7) is proven on:
 * for every schema here, pushed to a live server, the one-statement digest
 * must equal `fingerprintLive` of a full introspection, before and after the
 * catalog is changed behind the estate's back.
 *
 * It spans what the digest reproduces in SQL: every scalar and list type with
 * and without a default (decimal scale padding, signed literals, JSON and
 * array literals, clocks, enum casts), native types, mapped and quoted names,
 * indexes of each method, unique constraints and total unique indexes, and,
 * from `relation-ddl-corpus.ts`, every relation shape the estate builds:
 * foreign keys with their actions, compound and mapped keys, junctions.
 */

import type { AnyDriver } from "@drivers/driver";
import { controlTableNames, DEFAULT_CONTROL_BASE } from "@migrations/control";
import { postgresCatalogDigest } from "@migrations/drivers/postgres/catalog-digest";
import type { MigrationClient } from "@migrations/push/planner";
import { getPushMigrationDriver } from "@migrations/push/planner";
import { fingerprintLive } from "@migrations/push-fingerprint";
import { introspectManaged } from "@migrations/push-plan";
import { MANAGED_TABLES } from "@migrations/target";
import { s, TYPES } from "@schema";
import type { AnyModel } from "@schema/model";
import { relationDdlCorpus } from "@tests/fixtures/relation-ddl-corpus";

const { PG } = TYPES;

export interface DigestCase {
  readonly id: string;
  readonly build: () => Record<string, AnyModel>;
  /** SQL that changes the catalog behind the estate, `{ns}` its schema. */
  readonly drift: readonly string[];
}

const scalars = (): Record<string, AnyModel> => ({
  everything: s
    .model({
      id: s.string().id(),
      count: s.int().default(0),
      below: s.int().default(-5),
      big: s.bigInt().default(12n),
      negativeBig: s.bigInt().default(-9_007_199_254_740_993n),
      ratio: s.number().default(1.5),
      tiny: s.number().default(0.000_001),
      negativeRatio: s.number().default(-2.25),
      flag: s.boolean().default(true),
      off: s.boolean().default(false),
      country: s.string().default("FR"),
      quoted: s.string().default("it's"),
      empty: s.string().default(""),
      accented: s.string().default("été"),
      note: s.string().nullable(),
      payload: s.json().nullable(),
      object: s.json().default({}),
      list: s.json().default([]),
      createdAt: s.dateTime().now(),
      updatedAt: s.dateTime().updatedAt(),
      seenAt: s.dateTime().nullable(),
      local: s.dateTime().withoutTimezone().now(),
      at: s.time().now(),
      day: s.date().now(),
      tags: s.string().array().default([]),
      scores: s.int().array().nullable(),
      state: s.enum(["draft", "live", "gone"]).default("draft"),
      states: s.enum(["x", "y"]).array().nullable(),
      price: s.decimal({ precision: 10, scale: 2 }).default("12.5"),
      debt: s.decimal({ precision: 10, scale: 2 }).default("-12.5"),
      whole: s.decimal({ precision: 6, scale: 0 }).default("12"),
      rates: s.decimal({ precision: 8, scale: 3 }).array().nullable(),
      uid: s.string().uuid(),
      handle: s.string({ pg: PG.STRING.VARCHAR(40) }).default("anon"),
      code: s.string({ pg: PG.STRING.CHAR(3) }).nullable(),
      small: s.int({ pg: PG.INT.SMALLINT }).default(7),
      single: s.number({ pg: PG.FLOAT.REAL }).nullable(),
      document: s.json({ pg: PG.JSON.JSON }).nullable(),
      stamp: s.dateTime({ pg: PG.DATETIME.TIMESTAMP(3) }).nullable(),
      blob: s.blob().nullable(),
    })
    .index(["count"])
    .index(["country", "count"], { unique: true })
    .index(["tags"], { type: "gin" })
    .index(["handle"], { type: "hash" })
    .map("EverythingTable"),
});

const keys = (): Record<string, AnyModel> => {
  const author = s
    .model({
      tenant: s.string(),
      handle: s.string(),
      email: s.string().unique(),
      posts: s.toMany(() => post),
    })
    .id(["tenant", "handle"])
    .map("authors");
  const post = s
    .model({
      id: s.int().id().increment(),
      tenant: s.string(),
      authorHandle: s.string().map("author_handle"),
      title: s.string(),
      author: s
        .toOne(() => author)
        .fields("tenant", "authorHandle")
        .references("tenant", "handle")
        .onDelete("cascade")
        .onUpdate("restrict"),
    })
    .unique(["tenant", "title"])
    .map("posts");
  return { author, post };
};

export const catalogDigestCorpus: readonly DigestCase[] = [
  {
    id: "scalars",
    build: scalars,
    drift: [
      `ALTER TABLE "{ns}"."EverythingTable" ALTER COLUMN "count" SET DEFAULT 1`,
      `ALTER TABLE "{ns}"."EverythingTable" ALTER COLUMN "note" SET NOT NULL`,
      `ALTER TABLE "{ns}"."EverythingTable" ADD COLUMN "extra" numeric(12,4) DEFAULT -3.5`,
      `CREATE INDEX "extra_idx" ON "{ns}"."EverythingTable" ("extra")`,
      `CREATE TYPE "{ns}"."mood" AS ENUM ('calm', 'été')`,
    ],
  },
  {
    id: "keys",
    build: keys,
    drift: [
      `ALTER TABLE "{ns}"."posts" ALTER COLUMN "title" DROP NOT NULL`,
      `ALTER TABLE "{ns}"."authors" ADD CONSTRAINT "authors_handle_key" UNIQUE ("handle")`,
    ],
  },
  ...relationDdlCorpus
    .filter(
      (item) =>
        item.dialects.includes("postgres") &&
        (item.intendedVerdict ?? item.headVerdict) === "valid"
    )
    .map((item) => ({ id: item.id, build: item.build, drift: [] })),
];

/**
 * A soft-delete estate: partial indexes on the tombstone column, one also
 * comparing an enum, whose predicates PostgreSQL stores parsed and deparses
 * its own way (`("deletedAt" IS NULL)`, `'churned'::…`).
 */
const softDeleteFields = () => ({
  id: s.string().id(),
  email: s.string(),
  status: s.enum(["trial", "active", "churned"]).default("trial"),
  country: s.string().default("FR"),
  deletedAt: s.dateTime().nullable(),
});
const LIVE_EMAIL = {
  name: "accounts_live_email",
  unique: true,
  where: `"deletedAt" IS NULL`,
} as const;
const LIVE_COUNTRY = {
  name: "accounts_live_country",
  where: `"deletedAt" IS NULL AND "status" <> 'churned'`,
} as const;

/** The estate, and with `nickname` its next state: one more column. */
export const softDeleteAccounts = (
  nickname = false
): Record<string, AnyModel> => ({
  account: nickname
    ? s
        .model({ ...softDeleteFields(), nickname: s.string().nullable() })
        .index(["email"], LIVE_EMAIL)
        .index(["country", "status"], LIVE_COUNTRY)
        .map("accounts")
    : s
        .model(softDeleteFields())
        .index(["email"], LIVE_EMAIL)
        .index(["country", "status"], LIVE_COUNTRY)
        .map("accounts"),
});

/**
 * The one-statement digest beside the fingerprint of a full introspection,
 * for the client's whole namespace or only the managed tables `tables` lists.
 */
export async function digestAndFingerprint(
  orm: MigrationClient & { readonly $driver: AnyDriver },
  tables?: readonly string[]
): Promise<{
  readonly digest: string | undefined;
  readonly fingerprint: string;
}> {
  const scoped: MigrationClient = {
    $driver: orm.$driver,
    $schema: orm.$schema,
    [MANAGED_TABLES]: tables,
  };
  const driver = getPushMigrationDriver(tables ? scoped : orm);
  const live = await introspectManaged(orm.$driver, driver);
  return {
    digest: await postgresCatalogDigest(
      orm.$driver,
      driver,
      controlTableNames(DEFAULT_CONTROL_BASE)
    ),
    fingerprint: await fingerprintLive(live, driver, orm.$driver),
  };
}
