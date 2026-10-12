/**
 * What `readControlState` reads of the ledger (plan D5, new defect 6): every
 * event by default, as `log()` needs; with `{ ledger: "open" }` and a marker,
 * the events of unfinished attempts and the latest `failed` one, never the
 * closed history. Events written in one millisecond keep their causal order,
 * whatever their ids sort to: attempt after attempt along the state chain,
 * and inside one, it opens, confirms its steps, then closes.
 */

import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createMigrationClient, MemoryEstateStorage } from "@migrations";
import { s } from "@schema";
import {
  appendLedger,
  casMarker,
  ensureControlTables,
  markerFromPath,
  readControlState,
} from "@src/migrations/control";
import { getMigrationDriver } from "@src/migrations/drivers";
import { emptyManagedSnapshot } from "@src/migrations/empty-snapshot";
import { hashSnapshot } from "@src/migrations/push-fingerprint";
import { eventIdFor } from "@src/migrations/v1-parse";
import type { LedgerEventV1 } from "@src/migrations/v1-types";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";

const ESTATE = "e".repeat(64);
const INSTANT = "2026-10-10T12:00:00.000Z";

function event(
  attempt: string,
  kind: LedgerEventV1["kind"],
  startedAt = INSTANT,
  dispatchId: string | null = null,
  [from, to]: readonly [string | null, string] = [null, "f"]
): LedgerEventV1 {
  const body = {
    format: "1" as const,
    attemptId: attempt.repeat(64),
    kind,
    estateHash: ESTATE,
    snapshotHash: hashSnapshot(emptyManagedSnapshot()),
    sqlHash: null,
    fromState: from === null ? null : from.repeat(64),
    toState: to.repeat(64),
    transitionHash: "c".repeat(64),
    direction: "forward" as const,
    operationId: dispatchId ? "op" : null,
    dispatchId,
    effectState:
      kind === "step-confirmed" ? ("committed" as const) : ("none" as const),
    startedAt,
    finishedAt: null,
    toolVersion: "v1",
    failure: kind === "failed" ? "V2001: refused" : null,
  };
  return { ...body, eventId: eventIdFor(body) };
}

async function ledgerOf(
  events: readonly LedgerEventV1[],
  options: { readonly marker: boolean; readonly open?: boolean }
) {
  const driver = createInMemorySQLite3Driver();
  const command = getMigrationDriver(driver);
  try {
    await ensureControlTables(driver, command);
    if (options.marker) {
      await casMarker(
        driver,
        command,
        null,
        markerFromPath(ESTATE, hashSnapshot(emptyManagedSnapshot()), [], 1)
      );
    }
    await appendLedger(driver, command, ...events);
    const { ledger } = await readControlState(
      driver,
      command,
      options.open ? { ledger: "open" } : {}
    );
    return ledger.map(({ attemptId, kind }) => `${attemptId[0]}:${kind}`);
  } finally {
    await driver._disconnect();
  }
}

const history = [
  event("a", "started", "2026-10-10T11:00:00.000Z"),
  event("a", "applied", "2026-10-10T11:00:00.000Z"),
  event("b", "failed", "2026-10-10T11:30:00.000Z"),
  event("c", "failed", "2026-10-10T11:40:00.000Z"),
  event("d", "started"),
  event("d", "step-confirmed", INSTANT, "1".repeat(64)),
];

describe("the ledger a command reads", () => {
  test("with a marker: the open attempts and the latest failure only", async () => {
    expect(await ledgerOf(history, { marker: true, open: true })).toEqual([
      "c:failed",
      "d:started",
      "d:step-confirmed",
    ]);
  });

  test("without a marker, and for log(): every event", async () => {
    const all = [
      "a:started",
      "a:applied",
      "b:failed",
      "c:failed",
      "d:started",
      "d:step-confirmed",
    ];
    expect(await ledgerOf(history, { marker: false, open: true })).toEqual(all);
    expect(await ledgerOf(history, { marker: true })).toEqual(all);
  });

  test("events of one millisecond keep their causal order", async () => {
    const attempt = [
      event("e", "applied"),
      event("e", "step-confirmed", INSTANT, "2".repeat(64)),
      event("e", "started"),
    ];
    expect(await ledgerOf(attempt, { marker: true })).toEqual([
      "e:started",
      "e:step-confirmed",
      "e:applied",
    ]);
  });

  test("attempts of one millisecond follow the state chain", async () => {
    // Stepwise: 1→2 closes in the millisecond 2→3 starts in. Transactional:
    // one group closes 3→4 and 4→5 together. The ids sort the other way.
    const earlier = "2026-10-10T11:59:59.999Z";
    const chain = [
      event("f", "started", earlier, null, ["1", "2"]),
      event("f", "applied", INSTANT, null, ["1", "2"]),
      event("e", "started", INSTANT, null, ["2", "3"]),
      event("e", "applied", INSTANT, null, ["2", "3"]),
      event("b", "applied", INSTANT, null, ["3", "4"]),
      event("a", "applied", INSTANT, null, ["4", "5"]),
    ];
    expect(await ledgerOf(chain, { marker: true })).toEqual([
      "f:started",
      "f:applied",
      "e:started",
      "e:applied",
      "b:applied",
      "a:applied",
    ]);
  });
});

describe("log() of a transactional path applied in one millisecond", () => {
  const toISOString = Date.prototype.toISOString;
  afterEach(() => {
    Date.prototype.toISOString = toISOString;
  });

  test("returns every closed attempt, in path order", async () => {
    const database = new Database(":memory:");
    const storage = new MemoryEstateStorage();
    const versions: Parameters<typeof s.model>[0][] = [
      { id: s.string().id() },
      { id: s.string().id(), name: s.string().nullable() },
      {
        id: s.string().id(),
        name: s.string().nullable(),
        age: s.int().default(0),
      },
      {
        id: s.string().id(),
        name: s.string().nullable(),
        age: s.int().default(0),
        bio: s.string().nullable(),
      },
      {
        id: s.string().id(),
        name: s.string().nullable(),
        age: s.int().default(0),
        bio: s.string().nullable(),
        active: s.boolean().default(true),
      },
    ];
    const clients = versions.map((fields) =>
      createMigrationClient(
        createClient({
          schema: { account: s.model(fields) },
          driver: new SQLite3Driver({ client: database }),
        }),
        { storage }
      )
    );
    const states: (string | null)[] = [];
    for (const [index, client] of clients.entries()) {
      states.push((await client.generate({ name: `v${index + 1}` })).stateId);
    }
    const latest = clients.at(-1)!;
    // A fast machine writes the whole group in one millisecond.
    Date.prototype.toISOString = () => INSTANT;
    expect((await latest.apply()).path).toEqual(states);
    Date.prototype.toISOString = toISOString;
    const events = await latest.log();
    expect(events.map(({ kind, toState }) => [kind, toState])).toEqual(
      states.map((state) => ["applied", state])
    );
    database.close();
  });
});
