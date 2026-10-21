/**
 * The Permissions acceptance estate on PlanetScale's Neki itself (plan §6.1 U0, §7
 * "Nk": the recursion runs), each in a schema of its own, dropped after and
 * the drop verified:
 *
 * - the §1.1 fixture pushed and seeded (`viborm_permissions_<random>`), the
 *   hand-written policy, whose document and team arms recurse, against the
 *   independent oracle for a sample of actors;
 * - W-K1a..g (`domain-predicate-behavior.ts`): admission, the four cycles,
 *   alias shadowing, the 101-deep closure and the layers' defaults, each
 *   case on fresh tables in `viborm_permissions_t` (recreated per case);
 * - W-R1..W-R9 through `viborm/permissions` (`permissions-entry-behavior.ts`, the sampled
 *   actors), whose document reads recurse (`up()`) at every scope, in
 *   `viborm_permissions_t_entry`.
 *
 * - the largest `$access` read, as the first statement of a node-postgres and
 *   of a postgres.js driver given no `relationsPerStatement`: each reads Neki
 *   from its first connection's startup and bounds the read to 256
 *   (`viborm_permissions_nb_<random>`), with PGlite's rows.
 *
 * Select with `-t` (the W-K1 and W-R ids) to run only the recursion
 * witnesses: each estate is created only for the cases selected.
 *
 * Runs only with NEKI_DEV_CONNECTION_STRING (a Neki development branch).
 */

import { randomBytes } from "node:crypto";
import type { AnyDriver } from "@drivers/driver";
import { PgDriver } from "@drivers/pg";
import { PGliteDriver } from "@drivers/pglite";
import { PostgresDriver } from "@drivers/postgres";
import { softDelete } from "@src/soft-delete/index";
import { runDomainPredicateBehavior } from "@tests/contracts/engine/query/domain-predicate-behavior";
import {
  createPermissionsAppClient,
  loadPermissionsSeed,
  runPermissionsAppBehavior,
} from "@tests/contracts/public-client/permissions-app-behavior";
import { runPermissionsEntryBehavior } from "@tests/contracts/public-client/permissions-entry-behavior";
import { SAMPLED_ACTORS } from "@tests/contracts/public-client/permissions-sampled-actors";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { TOMBSTONED_MODELS } from "@tests/package/fixtures/permissions-app/oracle";
import { actors } from "@tests/package/fixtures/permissions-app/seed";
import { policy } from "@tests/types/permissions/acceptance-policy";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const NEKI_URL = process.env.NEKI_DEV_CONNECTION_STRING;
const TIMEOUT = 300_000;

/** node-postgres reads `sslrootcert=system` as a file: verify against the system store instead. */
function poolConfig(url: string): pg.PoolConfig {
  const parsed = new URL(url);
  parsed.searchParams.delete("sslrootcert");
  parsed.searchParams.delete("sslmode");
  return {
    connectionString: parsed.toString(),
    ssl: { rejectUnauthorized: true },
    max: 4,
  };
}

const namespace = `viborm_permissions_${randomBytes(5).toString("hex")}`;
const UNSTATED = `viborm_permissions_nb_${randomBytes(5).toString("hex")}`;
const DOMAIN_PREDICATES = "viborm_permissions_t";
const ENTRY = "viborm_permissions_t_entry";

async function admin<T extends pg.QueryResultRow>(
  statement: string,
  values: unknown[] = []
): Promise<T[]> {
  const connection = new pg.Client(poolConfig(NEKI_URL as string));
  await connection.connect();
  try {
    return (await connection.query<T>(statement, values)).rows;
  } finally {
    await connection.end();
  }
}

/** Drops `schema` and proves it gone. */
async function dropped(schema: string): Promise<void> {
  await admin(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  const [left] = await admin<{ n: number }>(
    "SELECT count(*)::int AS n FROM pg_catalog.pg_namespace WHERE nspname = $1",
    [schema]
  );
  if (left?.n !== 0) throw new Error(`the schema ${schema} was left`);
}

// Neki refuses a statement referencing more than 256 relations (SQLSTATE
// 54000); a governed read repeats relation bodies, so the driver states each
// once (W-R1, E5.2), and past 256 trades plans for fewer relations.
const driverIn = (schema: string) => () =>
  new PgDriver({
    options: poolConfig(NEKI_URL as string),
    namespace: schema,
    sharedRelationBodies: true,
    relationsPerStatement: 256,
  });

// The largest of the nine `$access` reads (tests/providers/local/pglite-permissions-relations.test.ts):
// 634 relations with every walk in place.
const LARGEST = {
  where: { parentId: null },
  include: {
    $access: true,
    grants: { include: { $access: true } },
    children: {
      include: {
        $access: true,
        children: {
          include: { $access: true, grants: { include: { $access: true } } },
        },
      },
    },
  },
};
const tombstones = softDelete({
  models: Object.fromEntries(
    TOMBSTONED_MODELS.map((model) => [model, { deletedAt: "deletedAt" }])
  ),
});
type Governed = {
  $as(actor: unknown): {
    document: { findMany(args: object): Promise<unknown> };
  };
};
/** The acceptance policy over `driver`, recording each statement it sends. */
function governed(driver: AnyDriver, statements: string[] = []) {
  const base = createPermissionsAppClient(driver);
  const recorded = base.$extends({
    name: "statements",
    statement(context) {
      statements.push(context.statement.toStatement());
      return context.statement;
    },
  });
  const db = policy.methods(
    tombstones.methods(policy.rows(tombstones.rows(recorded)))
  ) as unknown as Governed;
  return { base, db };
}
// Neki's count: every `FROM` item, aliased `q<n>` or a bare shared member.
const relationsOf = (statement: string) =>
  (statement.match(/ AS "q\d+"/g) ?? []).length +
  (statement.match(/(?:FROM|JOIN) "__shared_\d+"(?! AS)/g) ?? []).length;

describe.skipIf(!NEKI_URL)("Neki", () => {
  describe("a driver given no relationsPerStatement", () => {
    const local = governed(new PGliteDriver());
    let expected: unknown;
    beforeAll(async () => {
      await admin(`CREATE SCHEMA "${UNSTATED}"`);
      const seeding = createPermissionsAppClient(driverIn(UNSTATED)());
      await syncLiveSchema(seeding);
      await loadPermissionsSeed(seeding);
      await seeding.$disconnect();
      await syncLiveSchema(local.base);
      await loadPermissionsSeed(local.base);
      expected = await local.db.$as(actors.u02).document.findMany(LARGEST);
    }, TIMEOUT);
    afterAll(async () => {
      await local.base.$disconnect();
      await dropped(UNSTATED);
    }, TIMEOUT);
    test.each([
      [
        "node-postgres",
        () =>
          new PgDriver({
            options: poolConfig(NEKI_URL as string),
            namespace: UNSTATED,
          }),
      ],
      [
        "postgres.js",
        () =>
          new PostgresDriver({
            databaseUrl: NEKI_URL as string,
            namespace: UNSTATED,
          }),
      ],
    ])(
      "%s bounds the largest $access read, its first statement, to Neki's 256",
      async (_name, createDriver) => {
        const statements: string[] = [];
        const driver = createDriver();
        const neki = governed(driver, statements);
        try {
          expect(
            driver.adapter.capabilities.relationsPerStatement
          ).toBeUndefined();
          const rows = await neki.db.$as(actors.u02).document.findMany(LARGEST);
          expect(driver.adapter.capabilities.relationsPerStatement).toBe(256);
          const widest = statements.reduce((a, b) =>
            b.length > a.length ? b : a
          );
          expect(relationsOf(widest)).toBeLessThanOrEqual(256);
          expect(rows).toEqual(expected);
        } finally {
          await neki.base.$disconnect();
        }
      },
      TIMEOUT
    );
  });

  runPermissionsAppBehavior({
    name: "Neki",
    createDriver: driverIn(namespace),
    prepare: async (client) => {
      await admin(`CREATE SCHEMA "${namespace}"`);
      await syncLiveSchema(client);
    },
    release: () => dropped(namespace),
    actors: [
      "u01",
      "u05",
      "u22",
      "u46",
      "k05-documents-share",
      "k21-everything",
    ],
    timeout: TIMEOUT,
  });

  describe("domain predicates", () => {
    afterAll(() => dropped(DOMAIN_PREDICATES), TIMEOUT);
    runDomainPredicateBehavior({
      name: "Neki",
      createDriver: driverIn(DOMAIN_PREDICATES),
      // Each case reads fresh tables: the previous case's client is closed.
      prepare: async (client) => {
        await dropped(DOMAIN_PREDICATES);
        await admin(`CREATE SCHEMA "${DOMAIN_PREDICATES}"`);
        await syncLiveSchema(client);
      },
    });
  });

  runPermissionsEntryBehavior({
    name: "Neki",
    createDriver: driverIn(ENTRY),
    prepare: async (client) => {
      await dropped(ENTRY);
      await admin(`CREATE SCHEMA "${ENTRY}"`);
      await syncLiveSchema(client);
    },
    release: () => dropped(ENTRY),
    actors: SAMPLED_ACTORS,
    exhaustive: false,
    timeout: 1_800_000,
  });
});
