/**
 * S12 — timestamps written by SQL migrations (plan decision 4).
 *
 * SQLite's own zone-less text (`datetime('now')`, `CURRENT_TIMESTAMP`) is UTC.
 * After every manual transition, inside its transaction, apply rewrites the
 * destination's text DateTime and Time columns (scalar and JSON list) into the
 * canonical text typed queries compare, and checks decimal-list members. A
 * value that cannot be rewritten aborts the transition atomically. Each test
 * runs over 10,000 rows of a 15-field model.
 */

import { createClient } from "@client/client";
import { isMigrationError, VibORMErrorCode } from "@errors";
import {
  auditStorage,
  createMigrationClient,
  type ManualMigrationInput,
} from "@migrations";
import { appendLedger, DEFAULT_CONTROL_BASE } from "@migrations/control";
import { loadMigrationGraph, parentTransition } from "@migrations/graph";
import { getPushMigrationDriver } from "@migrations/push/planner";
import { eventIdFor } from "@migrations/v1-parse";
import { s, TYPES } from "@schema";
import { sql } from "@sql";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema as push } from "@tests/fixtures/sync-schema";
import { describe, expect, it } from "vitest";
import { MemoryStorage } from "./_estate";

const ROWS = 10_000;
const CANONICAL_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CANONICAL_TIME = /^\d{2}:\d{2}:\d{2}\.\d{3}$/;

const schema = () => ({
  event: s
    .model({
      id: s.string().id(),
      title: s.string(),
      kind: s.enum(["meeting", "call", "task"]),
      location: s.string().nullable(),
      payload: s.json().nullable(),
      priority: s.int().default(0),
      durationMinutes: s.int(),
      occurredAt: s.dateTime(),
      endedAt: s.dateTime().nullable(),
      startsAt: s.time(),
      reminders: s.dateTime().array(),
      prices: s.decimal({ precision: 10, scale: 2 }).array(),
      cancelled: s.boolean().default(false),
      createdAt: s.dateTime().now(),
      updatedAt: s.dateTime().updatedAt(),
    })
    .map("s12_events"),
});

type ManualTransition = ManualMigrationInput["transitions"][number];

const populated = () =>
  ({
    kind: "trusted-read",
    query: sql.raw(`SELECT count(*) > 0 FROM "s12_events"`),
    equals: true,
  }) as const;

/** A v1 database holding ROWS canonical events, and a manual transition running `up`. */
async function withManualTransition(
  up: readonly string[],
  options: {
    readonly execution?: ManualTransition["execution"];
    readonly rollback?: readonly string[];
  } = {}
) {
  const driver = createInMemorySQLite3Driver();
  const client = createClient({ schema: schema(), driver });
  const storage = new MemoryStorage();
  const migrations = createMigrationClient(client, { storage });
  const v1 = await migrations.generate({ name: "v1" });
  await migrations.apply();
  for (let start = 0; start < ROWS; start += 1000) {
    await client.event.createMany({
      data: Array.from({ length: 1000 }, (_, offset) => {
        const i = start + offset;
        return {
          id: `evt-${i}`,
          title: `Event ${i}`,
          kind: (["meeting", "call", "task"] as const)[i % 3]!,
          payload: { seats: i % 12 },
          durationMinutes: 30,
          occurredAt: new Date(Date.UTC(2025, 0, 1, 0, 0, i % 60)),
          startsAt: new Date(Date.UTC(1970, 0, 1, 9, i % 60)),
          reminders: [new Date(Date.UTC(2025, 0, 1))],
          prices: ["1.50", "20.00"],
        };
      }),
    });
  }
  const v2 = await migrations.generate({
    name: "sql-backfill",
    manualMigration: {
      transitions: [
        {
          from: v1.stateId,
          execution: options.execution ?? "transactional",
          originChecks: [populated()],
          up: up.map((text) => sql.raw(text)),
          rollback: options.rollback
            ? {
                kind: "manual",
                execution: "transactional",
                sql: options.rollback.map((text) => sql.raw(text)),
              }
            : { kind: "irreversible", reason: "test" },
        },
      ],
      // Stepwise manual work, and `resolve` completing it, need proofs.
      destinationChecks: [populated()],
    },
  });
  return {
    driver,
    client,
    storage,
    migrations,
    v1: v1.stateId!,
    v2: v2.stateId!,
  };
}

/**
 * What VibORM 1.1.0 left on SQLite when a stepwise transition stopped after its
 * SQL ran: the SQL's effect, and an attempt that started and confirmed its one
 * dispatch but never finished. 1.2.0 refuses to apply such a transition.
 */
async function seedUnfinishedStepwiseAttempt(
  client: Parameters<typeof getPushMigrationDriver>[0],
  storage: MemoryStorage,
  from: string,
  to: string,
  up: string,
  confirmed: "committed" | "none" = "committed"
) {
  await client.$driver._executeRaw(up);
  const graph = await loadMigrationGraph(storage);
  const command = getPushMigrationDriver(client);
  const state = graph.states.get(to)!;
  const transition = parentTransition(graph, from, to);
  const operation = transition.operations[0]!;
  const event = (
    attemptId: string,
    kind: "started" | "step-confirmed",
    effectState: "none" | "committed"
  ) => ({
    format: "1" as const,
    attemptId,
    kind,
    estateHash: graph.estateHash,
    snapshotHash: state.snapshotHash,
    sqlHash: state.sqlHash,
    fromState: from,
    toState: to,
    transitionHash: transition.transitionHash,
    direction: "forward" as const,
    operationId: kind === "started" ? null : operation.id,
    dispatchId:
      kind === "started" ? null : operation.steps[0]!.execute.dispatchId,
    effectState,
    startedAt: new Date().toISOString(),
    finishedAt: kind === "started" ? null : new Date().toISOString(),
    toolVersion: "v1",
    failure: null,
  });
  const attemptId = eventIdFor(event("0".repeat(64), "started", "none"));
  for (const seeded of [
    event(attemptId, "started", "none"),
    event(attemptId, "step-confirmed", "none"),
    ...(confirmed === "committed"
      ? [event(attemptId, "step-confirmed", "committed")]
      : []),
  ]) {
    await appendLedger(client.$driver, command, DEFAULT_CONTROL_BASE, {
      ...seeded,
      eventId: eventIdFor(seeded),
    });
  }
}

async function noncanonical(
  driver: ReturnType<typeof createInMemorySQLite3Driver>
) {
  const { rows } = await driver._executeRaw<Record<string, string | null>>(
    `SELECT "occurredAt", "endedAt", "createdAt", "updatedAt", "startsAt", "reminders" FROM "s12_events"`
  );
  const bad: string[] = [];
  for (const row of rows) {
    for (const column of ["occurredAt", "createdAt", "updatedAt"])
      if (!CANONICAL_DATETIME.test(row[column]!)) bad.push(row[column]!);
    if (row.endedAt !== null && !CANONICAL_DATETIME.test(row.endedAt!))
      bad.push(row.endedAt!);
    if (!CANONICAL_TIME.test(row.startsAt!)) bad.push(row.startsAt!);
    for (const member of JSON.parse(row.reminders!) as string[])
      if (!CANONICAL_DATETIME.test(member)) bad.push(member);
  }
  return bad;
}

describe("SQLite storage canonicalization after a manual transition", () => {
  it(
    "applies SQL that writes datetime('now') and leaves canonical UTC text",
    { timeout: 120_000 },
    async () => {
      const { driver, client, migrations } = await withManualTransition([
        `UPDATE "s12_events" SET "occurredAt" = datetime('now') WHERE rowid % 2 = 0`,
        `UPDATE "s12_events" SET "updatedAt" = CURRENT_TIMESTAMP WHERE rowid % 3 = 0`,
        `UPDATE "s12_events" SET "endedAt" = '2026-03-01T12:00:00.5+02:00' WHERE rowid % 4 = 0`,
        `UPDATE "s12_events" SET "startsAt" = time('now') WHERE rowid % 5 = 0`,
        `UPDATE "s12_events" SET "reminders" = json_array('2026-01-01 08:00:00', '2026-01-02T00:00:00.000Z') WHERE rowid % 7 = 0`,
        `UPDATE "s12_events" SET "prices" = '[ "150", "-2000" ]' WHERE rowid % 11 = 0`,
        `INSERT INTO "s12_events" ("id", "title", "kind", "durationMinutes", "occurredAt", "startsAt", "reminders", "prices", "createdAt", "updatedAt") VALUES ('sql', 'from sql', 'call', 15, '2026-10-10 12:34:56.7', '09:30:00', '[]', '[]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      ]);
      const before = Date.now();
      // The SQL has not run yet: the audit sees canonical storage only.
      const clean = await auditStorage(client);
      expect(
        clean.every(
          (audit) => audit.type === "decimal" || audit.noncanonical === 0
        )
      ).toBe(true);

      await expect(migrations.apply()).resolves.toMatchObject({
        outcome: "applied",
      });
      expect(await noncanonical(driver)).toEqual([]);

      // Zone-less text was read as UTC, offsets were applied, Time was padded.
      const sqlRow = await client.event.findUnique({ where: { id: "sql" } });
      expect(sqlRow?.occurredAt.toISOString()).toBe("2026-10-10T12:34:56.700Z");
      const { rows } = await driver._executeRaw<Record<string, string>>(
        `SELECT "startsAt", "createdAt", "prices" FROM "s12_events" WHERE "id" IN ('sql', 'evt-10') ORDER BY "id"`
      );
      expect(rows[0]).toMatchObject({ prices: '["150","-2000"]' });
      expect(rows[1]).toMatchObject({ startsAt: "09:30:00.000" });
      const written = Date.parse(rows[1]!.createdAt!);
      expect(Math.abs(written - before)).toBeLessThan(120_000);
      // Typed filters compare the rewritten text: every row is found.
      await expect(
        client.event.count({
          where: { endedAt: { equals: new Date("2026-03-01T10:00:00.500Z") } },
        })
      ).resolves.toBe(ROWS / 4);
      const audits = await auditStorage(client);
      expect(
        audits.filter(
          (audit) => audit.type !== "decimal" && audit.noncanonical !== 0
        )
      ).toEqual([]);
    }
  );

  it.each([
    [
      "a malformed DateTime",
      `UPDATE "s12_events" SET "occurredAt" = 'next tuesday' WHERE "id" = 'evt-7'`,
      "occurredAt",
    ],
    [
      "an invalid Time clock",
      `UPDATE "s12_events" SET "startsAt" = '25:00' WHERE "id" = 'evt-7'`,
      "startsAt",
    ],
    [
      "a zone-less DateTime with a T separator",
      `UPDATE "s12_events" SET "occurredAt" = '2026-10-10T12:34:56' WHERE "id" = 'evt-7'`,
      "occurredAt",
    ],
    [
      "a non-text DateTime-list member",
      `UPDATE "s12_events" SET "reminders" = json_array(1) WHERE "id" = 'evt-7'`,
      "reminders",
    ],
    [
      "a decimal-list member outside its scale",
      `UPDATE "s12_events" SET "prices" = '["1.5"]' WHERE "id" = 'evt-7'`,
      "prices",
    ],
  ])(
    "aborts the transition atomically on %s",
    { timeout: 120_000 },
    async (_label, statement, column) => {
      const { driver, migrations, v1 } = await withManualTransition([
        `UPDATE "s12_events" SET "occurredAt" = datetime('now')`,
        statement,
      ]);
      const failure = await migrations.apply().catch((error: unknown) => error);
      expect(isMigrationError(failure), String(failure)).toBe(true);
      expect(failure).toMatchObject({
        code: "V11014",
        message: expect.stringContaining(`"s12_events"."${column}"`),
      });
      // Nothing of the transition is stored, and the marker stayed at v1.
      const { rows } = await driver._executeRaw<{ zoneless: number }>(
        `SELECT count(*) AS zoneless FROM "s12_events" WHERE "occurredAt" NOT LIKE '%Z'`
      );
      expect(Number(rows[0]?.zoneless)).toBe(0);
      await expect(migrations.status()).resolves.toMatchObject({
        marker: { stateId: v1 },
      });
    }
  );

  it(
    "canonicalizes after a manual rollback, and aborts it on a malformed value",
    { timeout: 120_000 },
    async () => {
      const titles = [`UPDATE "s12_events" SET "title" = 'renamed'`];
      const good = await withManualTransition(titles, {
        rollback: [
          `UPDATE "s12_events" SET "updatedAt" = CURRENT_TIMESTAMP`,
          `UPDATE "s12_events" SET "startsAt" = time('now') WHERE rowid % 5 = 0`,
        ],
      });
      await good.migrations.apply();
      await expect(good.migrations.down({ steps: 1 })).resolves.toBeDefined();
      expect(await noncanonical(good.driver)).toEqual([]);
      await expect(good.migrations.status()).resolves.toMatchObject({
        marker: { stateId: good.v1 },
      });

      const bad = await withManualTransition(titles, {
        rollback: [
          `UPDATE "s12_events" SET "updatedAt" = CURRENT_TIMESTAMP`,
          `UPDATE "s12_events" SET "occurredAt" = 'next tuesday' WHERE "id" = 'evt-7'`,
        ],
      });
      await bad.migrations.apply();
      await expect(bad.migrations.down({ steps: 1 })).rejects.toMatchObject({
        code: "V11014",
        message: expect.stringContaining(`"s12_events"."occurredAt"`),
      });
      expect(await noncanonical(bad.driver)).toEqual([]);
      await expect(bad.migrations.status()).resolves.toMatchObject({
        marker: { stateId: bad.v2 },
      });
    }
  );

  it(
    "canonicalizes when resolve completes a stepwise manual transition 1.1.0 left unfinished",
    { timeout: 120_000 },
    async () => {
      const up = `UPDATE "s12_events" SET "occurredAt" = datetime('now') WHERE "id" <> 'evt-7'`;
      const { driver, client, storage, migrations, v1, v2 } =
        await withManualTransition([up], { execution: "stepwise" });
      // 1.2.0 refuses to apply it (plan S5); 1.1.0 ran its SQL and stopped.
      await seedUnfinishedStepwiseAttempt(client, storage, v1, v2, up);
      expect(await noncanonical(driver)).not.toEqual([]);
      await expect(migrations.status()).resolves.toMatchObject({
        marker: { stateId: v1 },
        unfinished: true,
      });

      await expect(
        migrations.resolve({ outcome: "complete" })
      ).resolves.toMatchObject({ outcome: "complete" });
      expect(await noncanonical(driver)).toEqual([]);
      await expect(migrations.status()).resolves.toMatchObject({
        marker: { stateId: v2 },
      });
    }
  );

  // S4: the step's SQL committed, or may have, and nothing undid it, so the
  // attempt cannot be closed as rolled back (a retried apply would run it
  // again).
  it.each([
    ["committed", VibORMErrorCode.MIGRATION_PARTIAL_EFFECT, "committed"],
    ["none", VibORMErrorCode.MIGRATION_AMBIGUOUS_COMMIT, "may-have-committed"],
  ] as const)(
    "refuses to mark a 1.1.0 stepwise attempt rolled back when its step confirmed %s",
    { timeout: 120_000 },
    async (confirmed, code, effectState) => {
      const up = `UPDATE "s12_events" SET "title" = 'renamed' WHERE "id" <> 'evt-7'`;
      const { client, storage, migrations, v1, v2 } =
        await withManualTransition([up], { execution: "stepwise" });
      await seedUnfinishedStepwiseAttempt(
        client,
        storage,
        v1,
        v2,
        up,
        confirmed
      );

      await expect(
        migrations.resolve({ outcome: "rolled-back" })
      ).rejects.toMatchObject({
        code,
        meta: { fromState: v1, toState: v2, effectState, partial: true },
      });
      await expect(migrations.status()).resolves.toMatchObject({
        marker: { stateId: v1 },
        unfinished: true,
      });
    }
  );

  it(
    "canonicalizes when reset replays a manual seed",
    { timeout: 120_000 },
    async () => {
      const driver = createInMemorySQLite3Driver();
      const client = createClient({ schema: schema(), driver });
      const migrations = createMigrationClient(client, {
        storage: new MemoryStorage(),
      });
      const v1 = await migrations.generate({ name: "v1" });
      await migrations.generate({
        name: "sql-seed",
        manualMigration: {
          transitions: [
            {
              from: v1.stateId,
              execution: "transactional",
              up: [
                sql.raw(
                  `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${ROWS}) INSERT INTO "s12_events" ("id", "title", "kind", "durationMinutes", "occurredAt", "startsAt", "reminders", "prices", "createdAt", "updatedAt") SELECT 'evt-' || i, 'seed', 'task', 30, datetime(1767225600 + i, 'unixepoch'), time('now'), json_array(datetime('now')), '[]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM n`
                ),
              ],
              rollback: { kind: "irreversible", reason: "test" },
            },
          ],
          destinationChecks: [populated()],
        },
      });
      await migrations.apply();
      expect(await noncanonical(driver)).toEqual([]);
      // Reset clears the estate and replays the same manual seed.
      await expect(migrations.reset()).resolves.toMatchObject({
        preview: false,
      });
      expect(await noncanonical(driver)).toEqual([]);
      await expect(client.event.count()).resolves.toBe(ROWS);
    }
  );
});

describe("SQLite zone-less DateTime text in table recreation", () => {
  const adoption = (at: ReturnType<typeof s.string | typeof s.dateTime>) => ({
    event: s.model({ id: s.string().id(), at }).map("s12_adoption"),
  });

  it(
    "keeps it on same-form adoption, where the audit counts it, and converts it as UTC across forms",
    { timeout: 120_000 },
    async () => {
      const driver = createInMemorySQLite3Driver();
      await push(createClient({ schema: adoption(s.string()), driver }), {
        force: true,
      });
      await driver._executeRaw(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${ROWS}) INSERT INTO "s12_adoption" ("id", "at") SELECT 'evt-' || i, datetime(1767225600 + i, 'unixepoch') FROM n`
      );

      // Adopting text as text validates every row and keeps its spelling.
      const text = createClient({
        schema: adoption(s.dateTime(TYPES.SQLITE.DATETIME.TEXT)),
        driver,
      });
      await push(text, { force: true });
      await expect(auditStorage(text)).resolves.toEqual([
        {
          table: "s12_adoption",
          column: "at",
          type: "datetime",
          list: false,
          noncanonical: ROWS,
        },
      ]);

      // Another physical form converts each value, read as UTC.
      const integer = createClient({
        schema: adoption(s.dateTime(TYPES.SQLITE.DATETIME.INTEGER)),
        driver,
      });
      await push(integer, { force: true });
      const { rows } = await driver._executeRaw<{ at: number }>(
        `SELECT "at" FROM "s12_adoption" WHERE "id" IN ('evt-1', 'evt-${ROWS}') ORDER BY "at"`
      );
      expect(rows).toEqual([
        { at: Date.UTC(2026, 0, 1, 0, 0, 1) },
        { at: Date.UTC(2026, 0, 1, 0, 0, ROWS) },
      ]);
    }
  );
});
