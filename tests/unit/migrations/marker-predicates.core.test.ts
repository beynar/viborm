/**
 * The partial-index predicates a PostgreSQL apply records beside the marker,
 * as the server deparsed them (plan D5 follow-up, owner decision 2026-10-11),
 * at the layer the migration coverage gate measures. The record shares the
 * marker row without being part of the marker: every command reads the same
 * marker with or without it, a malformed record is a corrupt marker row, and
 * the no-op's expected digest is the snapshot with each predicate replaced by
 * its recorded deparse, or none when one is missing.
 * `postgres-partial-index-noop.test.ts` proves the same on PostgreSQL.
 */

import { VibORMErrorCode } from "@errors";
import { postgresMigrationDriver } from "@migrations/drivers/postgres";
import {
  fingerprintDeparsed,
  fingerprintSnapshot,
} from "@migrations/push-fingerprint";
import { serializeModels } from "@migrations/serializer";
import {
  casMarker,
  DEFAULT_CONTROL_BASE,
  ensureControlTables,
  markerFromPath,
  readControlState,
} from "@src/migrations/control";
import { getMigrationDriver } from "@src/migrations/drivers";
import { emptyManagedSnapshot } from "@src/migrations/empty-snapshot";
import { hashSnapshot } from "@src/migrations/push-fingerprint";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { describe, expect, it } from "vitest";
import { softDeleteAccounts } from "./_catalog-digest-corpus";

const RECORD = {
  table: "accounts",
  index: "accounts_live_email",
  deparsed: `("deletedAt" IS NULL)`,
};

async function markerRowWith(predicates: unknown) {
  const driver = createInMemorySQLite3Driver();
  const command = getMigrationDriver(driver);
  await ensureControlTables(driver, command, DEFAULT_CONTROL_BASE);
  const marker = markerFromPath(
    "e".repeat(64),
    hashSnapshot(emptyManagedSnapshot()),
    [],
    1
  );
  await casMarker(driver, command, DEFAULT_CONTROL_BASE, null, marker, [
    RECORD,
  ]);
  if (predicates !== undefined) {
    const { rows } = await driver._executeRaw<{ payload: string }>(
      `SELECT payload FROM "${DEFAULT_CONTROL_BASE}_state"`
    );
    await driver._executeRaw(
      `UPDATE "${DEFAULT_CONTROL_BASE}_state" SET payload = ?`,
      [JSON.stringify({ ...JSON.parse(rows[0]!.payload), predicates })]
    );
  }
  return {
    marker,
    read: () => readControlState(driver, command, DEFAULT_CONTROL_BASE),
  };
}

describe("the predicates recorded beside the marker", () => {
  it("leave the marker every command reads unchanged", async () => {
    const { marker, read } = await markerRowWith(undefined);

    expect((await read()).marker).toEqual(marker);
  });

  it.each([
    ["not an array", RECORD],
    ["an entry with an unknown key", [{ ...RECORD, extra: true }]],
    ["an entry without its deparse", [{ ...RECORD, deparsed: 1 }]],
  ])("refuse the marker row when the record is %s", async (_, predicates) => {
    const { read } = await markerRowWith(predicates);

    await expect(read()).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
    });
  });
});

describe("the digest a recorded no-op expects", () => {
  const snapshot = serializeModels(softDeleteAccounts(), {
    migrationDriver: postgresMigrationDriver,
  });
  const partial = snapshot.tables[0]!.indexes.filter((index) => index.where);
  const records = partial.map((index) => ({
    table: "accounts",
    index: index.name,
    deparsed: `(${index.where})`,
  }));

  it("is the snapshot with each predicate as recorded", () => {
    const deparsed = {
      ...snapshot,
      tables: snapshot.tables.map((table) => ({
        ...table,
        indexes: table.indexes.map((index) =>
          index.where ? { ...index, where: `(${index.where})` } : index
        ),
      })),
    };

    expect(partial).toHaveLength(2);
    expect(
      fingerprintDeparsed(snapshot, records, postgresMigrationDriver)
    ).toBe(fingerprintSnapshot(deparsed, postgresMigrationDriver));
  });

  it("is none when the record lacks one predicate", () => {
    expect(
      fingerprintDeparsed(snapshot, records.slice(1), postgresMigrationDriver)
    ).toBeUndefined();
  });

  it("is the snapshot's own fingerprint without partial indexes", () => {
    const total = {
      ...snapshot,
      tables: snapshot.tables.map((table) => ({
        ...table,
        indexes: table.indexes.filter((index) => !index.where),
      })),
    };

    expect(fingerprintDeparsed(total, [], postgresMigrationDriver)).toBe(
      fingerprintSnapshot(total, postgresMigrationDriver)
    );
  });
});
