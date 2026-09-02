/**
 * Three push-owned questions, each asked at the boundary where it is answered
 * exactly once.
 *
 * `fingerprintLive` is the dialect canonicalization owner, so the facts a
 * dialect cannot read back — a constraint name SQLite never returns — must not
 * enter its digest, and the predicates it does canonicalize must land back on
 * the indexes they came from. `detectEnumValueRemovals` reports one entry per
 * DEPENDENT column, so an operation naming none has nothing to resolve. And the
 * control interlock runs before any push effect: an unfinished attempt and a
 * marker that disagrees with the live schema each stop the command there.
 */

import { VibORMErrorCode } from "@src/errors";
import { canonicalizeJsonText } from "@src/migrations/canonical-json";
import { markerFromPath } from "@src/migrations/control";
import { mysqlMigrationDriver } from "@src/migrations/drivers/mysql";
import { postgresMigrationDriver } from "@src/migrations/drivers/postgres";
import { sqlite3MigrationDriver } from "@src/migrations/drivers/sqlite";
import {
  applyForceEnumResolutions,
  detectEnumValueRemovals,
} from "@src/migrations/push/enum-removals";
import {
  canonicalizeSnapshotPredicates,
  fingerprintSnapshot,
} from "@src/migrations/push-fingerprint";
import { pushV1 } from "@src/migrations/push-v1";
import type { DiffOperation, SchemaSnapshot } from "@src/migrations/types";
import { eventIdFor } from "@src/migrations/v1-parse";
import type { LedgerEventV1 } from "@src/migrations/v1-types";
import { describe, expect, test } from "vitest";
import {
  controlCatalogAnswer,
  type RecordingDriver,
  sqliteControlDefinitionAnswer,
  sqliteEstateDriver,
} from "./_estate";

const HASH_ESTATE = "a".repeat(64);
const HASH_SNAPSHOT = "b".repeat(64);
const HASH_STATE = "c".repeat(64);

function accountWith(overrides: {
  readonly foreignKeyName?: string;
  readonly uniqueNames?: readonly string[];
}): SchemaSnapshot {
  return {
    tables: [
      {
        name: "account",
        columns: [
          { name: "id", type: "TEXT", nullable: false },
          { name: "owner", type: "TEXT", nullable: false },
        ],
        indexes: [],
        foreignKeys: [
          {
            name: overrides.foreignKeyName ?? "account_owner_fk",
            columns: ["owner"],
            referencedTable: "person",
            referencedColumns: ["id"],
          },
        ],
        uniqueConstraints: (overrides.uniqueNames ?? ["account_owner_key"]).map(
          (name) => ({ name, columns: ["owner"] })
        ),
      },
    ],
  };
}

describe("a live fingerprint carries only facts the dialect can read back", () => {
  test("a constraint name is part of the digest exactly where introspection returns it", () => {
    const first = accountWith({ foreignKeyName: "account_owner_fk" });
    const second = accountWith({ foreignKeyName: "fk_account_owner" });

    expect(fingerprintSnapshot(first, sqlite3MigrationDriver)).toBe(
      fingerprintSnapshot(second, sqlite3MigrationDriver)
    );
    expect(fingerprintSnapshot(first, postgresMigrationDriver)).not.toBe(
      fingerprintSnapshot(second, postgresMigrationDriver)
    );
    expect(fingerprintSnapshot(first, mysqlMigrationDriver)).not.toBe(
      fingerprintSnapshot(second, mysqlMigrationDriver)
    );
  });

  test("two constraints that differ only by name are one physical fact on SQLite", () => {
    const declared = accountWith({ uniqueNames: ["owner_key", "owner_key_2"] });
    const swapped = accountWith({ uniqueNames: ["owner_key_2", "owner_key"] });

    expect(fingerprintSnapshot(declared, sqlite3MigrationDriver)).toBe(
      fingerprintSnapshot(swapped, sqlite3MigrationDriver)
    );
  });

  test("canonical predicates land back on the indexes that carried them", async () => {
    const snapshot: SchemaSnapshot = {
      tables: [
        {
          name: "account",
          columns: [{ name: "state", type: "TEXT", nullable: true }],
          indexes: [
            { name: "plain_first", columns: ["state"], unique: false },
            {
              name: "partial_first",
              columns: ["state"],
              unique: false,
              where: "state = 'live'",
            },
            { name: "plain_second", columns: ["state"], unique: false },
            {
              name: "partial_second",
              columns: ["state"],
              unique: false,
              where: "state = 'draft'",
            },
          ],
          foreignKeys: [],
          uniqueConstraints: [],
        },
      ],
    };

    const seen: string[][] = [];
    const canonicalized = await canonicalizeSnapshotPredicates(
      snapshot,
      (_table, predicates) => {
        seen.push([...predicates]);
        return Promise.resolve(predicates.map((predicate) => `(${predicate})`));
      }
    );

    expect(seen).toEqual([["state = 'live'", "state = 'draft'"]]);
    expect(
      (canonicalized.tables[0]?.indexes ?? []).map((index) => index.where)
    ).toEqual([undefined, "(state = 'live')", undefined, "(state = 'draft')"]);
  });
});

describe("enum removal detection reports what the operation states", () => {
  const schema: SchemaSnapshot = {
    tables: [
      {
        name: "post",
        columns: [{ name: "state", type: "TEXT", nullable: true }],
        indexes: [],
        foreignKeys: [],
        uniqueConstraints: [],
      },
    ],
  };

  test("an operation with no dependent column has nothing to resolve", () => {
    const operation: DiffOperation = {
      type: "alterEnum",
      enumName: "post_state",
      removeValues: ["archived"],
      newValues: ["draft", "live"],
    };

    expect(detectEnumValueRemovals([operation], schema)).toEqual([]);
  });

  test("an operation that states no surviving values offers none", () => {
    const operation: DiffOperation = {
      type: "alterEnum",
      enumName: "post_state",
      removeValues: ["archived"],
      dependentColumns: [{ tableName: "post", columnName: "state" }],
    };

    expect(detectEnumValueRemovals([operation], schema)).toEqual([
      {
        enumName: "post_state",
        tableName: "post",
        columnName: "state",
        isNullable: true,
        removedValues: ["archived"],
        availableValues: [],
      },
    ]);
  });

  test("force resolutions leave an enum nobody reported untouched", () => {
    const resolved: DiffOperation = {
      type: "alterEnum",
      enumName: "post_state",
      removeValues: ["archived"],
      dependentColumns: [{ tableName: "post", columnName: "state" }],
      newValues: ["draft", "live"],
    };
    const untouched: DiffOperation = {
      type: "alterEnum",
      enumName: "person_role",
      removeValues: ["guest"],
      dependentColumns: [{ tableName: "person", columnName: "role" }],
      newValues: ["member"],
    };

    const applied = applyForceEnumResolutions(
      [resolved, untouched],
      [
        {
          enumName: "post_state",
          tableName: "post",
          columnName: "state",
          isNullable: true,
          removedValues: ["archived"],
          availableValues: ["draft", "live"],
        },
      ]
    );

    expect(applied[0]).toMatchObject({
      columnValueReplacements: { "post.state": { archived: null } },
    });
    expect(applied[1]).toBe(untouched);
  });
});

/** The answers a live SQLite database with a bootstrapped control pair gives. */
function controlDriver(options: {
  readonly marker?: ReturnType<typeof markerFromPath>;
  readonly ledger?: readonly LedgerEventV1[];
}): RecordingDriver {
  const driver = sqliteEstateDriver();
  const presence = { state: true, log: true } as const;
  driver.respond = (sql, params) => {
    const catalog = controlCatalogAnswer(sql, params, presence);
    if (catalog) return catalog;
    const definition = sqliteControlDefinitionAnswer(sql, presence);
    if (definition) return definition;
    if (sql.includes("SELECT payload FROM") && sql.includes("_state")) {
      return options.marker
        ? [{ payload: canonicalizeJsonText(options.marker) }]
        : [];
    }
    if (sql.includes("SELECT payload FROM") && sql.includes("_log")) {
      return (options.ledger ?? []).map((event) => ({
        payload: canonicalizeJsonText(event),
      }));
    }
    return [];
  };
  return driver;
}

function startedEvent(): LedgerEventV1 {
  const event = {
    format: "1" as const,
    attemptId: HASH_STATE,
    kind: "started" as const,
    estateHash: HASH_ESTATE,
    snapshotHash: HASH_SNAPSHOT,
    sqlHash: null,
    fromState: null,
    toState: HASH_STATE,
    transitionHash: null,
    direction: "forward" as const,
    operationId: null,
    dispatchId: null,
    effectState: "none" as const,
    startedAt: "2026-08-31T00:00:00.000Z",
    finishedAt: null,
    toolVersion: "v1",
    failure: null,
  };
  return { ...event, eventId: eventIdFor(event) };
}

describe("the push control interlock runs before any push effect", () => {
  test("an unfinished attempt blocks push", async () => {
    const driver = controlDriver({ ledger: [startedEvent()] });

    await expect(
      pushV1({ $driver: driver, $schema: {} })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_UNFINISHED_ATTEMPT,
      message: "An unfinished migration attempt is blocking push",
    });
    expect(driver.statements.some((sql) => sql.startsWith("CREATE"))).toBe(
      false
    );
  });

  test("a no-op push against a disagreeing marker is drift, not success", async () => {
    const driver = controlDriver({
      marker: markerFromPath(HASH_ESTATE, HASH_SNAPSHOT, [], 1),
    });

    await expect(
      pushV1({ $driver: driver, $schema: {} })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_DRIFT,
      message:
        "A no-op push cannot prove agreement between the marker, live schema, and desired schema",
      meta: expect.objectContaining({ expectedChecksum: HASH_SNAPSHOT }),
    });
  });
});
