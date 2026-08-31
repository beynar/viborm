/**
 * What the control-plane authenticator does with a probe that FAILS.
 *
 * `assertControlTablesAuthentic` and its partial-state sibling each run three
 * separate reads — the catalog, the singleton CHECK, and the attachment probe —
 * and each read is wrapped on its own. The wrapping is not decoration: a
 * provider failure has to become "cannot be authenticated" so no caller reads
 * an unanswered probe as an answered one, while a refusal this layer already
 * diagnosed has to survive its own catch instead of being flattened into that
 * generic sentence. Both directions are asserted here, for the pair path and
 * for the recoverable state-only path.
 */

import type { AnyDriver } from "@drivers/driver";
import { VibORMErrorCode } from "@src/errors";
import {
  assertControlTablesAuthentic,
  DEFAULT_CONTROL_BASE,
  inspectControlPresence,
} from "@src/migrations/control";
import { getMigrationDriver } from "@src/migrations/drivers";
import { describe, expect, test } from "vitest";
import {
  controlCatalogAnswer,
  type RecordingDriver,
  sqliteControlDefinitionAnswer,
  sqliteEstateDriver,
} from "./_estate";

type Presence = { readonly state: boolean; readonly log: boolean };

/** Catalog presence plus the `sqlite_master` definitions a healthy pair has. */
function controlEstate(presence: Presence) {
  return (sql: string, params: unknown[]): unknown[] | undefined =>
    controlCatalogAnswer(sql, params, presence) ??
    sqliteControlDefinitionAnswer(sql, presence);
}

/**
 * A SQLite control estate, optionally with ONE named read failing at the
 * provider the way a permission or catalog outage fails it.
 */
function controlDriver(
  presence: Presence,
  failing?: {
    readonly reads: (sql: string) => boolean;
    readonly failure: Error;
  }
): RecordingDriver {
  const driver = sqliteEstateDriver();
  const answer = controlEstate(presence);
  driver.respond = (sql, params) =>
    failing?.reads(sql) ? failing.failure : (answer(sql, params) ?? []);
  return driver;
}

/** A producer that answers ONE statement itself and delegates the rest. */
function producerAnswering(
  driver: RecordingDriver,
  match: (sql: string) => boolean,
  rows: unknown[]
): AnyDriver {
  const producer: AnyDriver = Object.create(driver);
  Object.defineProperty(producer, "_executeRaw", {
    value: (sql: string, params?: unknown[]) =>
      match(sql)
        ? Promise.resolve({ rows, rowCount: rows.length })
        : driver._executeRaw(sql, params),
  });
  return producer;
}

describe("an authenticated pair refuses every unanswered probe", () => {
  test("an unreadable singleton CHECK is a refusal, not a missing constraint", async () => {
    const driver = controlDriver(
      { state: true, log: true },
      {
        reads: (sql) => sql.startsWith("SELECT sql FROM sqlite_master"),
        failure: new Error("definition unavailable"),
      }
    );

    await expect(
      assertControlTablesAuthentic(
        driver,
        getMigrationDriver(driver),
        DEFAULT_CONTROL_BASE
      )
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: "Migration control tables cannot be authenticated",
      originalCause: expect.any(Error),
    });
  });

  test("an unreadable attachment probe is a refusal, not an unattached pair", async () => {
    const driver = controlDriver(
      { state: true, log: true },
      {
        reads: (sql) => sql.includes("AS attached"),
        failure: new Error("trigger catalog unavailable"),
      }
    );

    await expect(
      assertControlTablesAuthentic(
        driver,
        getMigrationDriver(driver),
        DEFAULT_CONTROL_BASE
      )
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: "Migration control tables cannot be authenticated",
      originalCause: expect.any(Error),
    });
  });
});

describe("partial control state keeps the diagnosis it already made", () => {
  test("an ambiguous attachment probe reports itself, not a generic failure", async () => {
    const driver = controlDriver({ state: true, log: false });
    const producer = producerAnswering(
      driver,
      (sql) => sql.includes("AS attached"),
      [{ attached: 0 }, { attached: 0 }]
    );

    await expect(
      inspectControlPresence(
        producer,
        getMigrationDriver(driver),
        DEFAULT_CONTROL_BASE
      )
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: "Migration control attachment probe must return exactly one row",
    });
  });
});
