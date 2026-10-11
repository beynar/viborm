/**
 * The transaction-scoped migration protocol on PostgreSQL (plan D1), on PGlite.
 *
 * Every locked command runs its decisions and its transactional effects in
 * transactions that each open with `BEGIN`, their own `SET LOCAL` limits and a
 * bounded `pg_try_advisory_xact_lock`: the lock ends with the transaction, so a
 * transaction pooler can hand each transaction to any server session and no
 * lock outlives it. The marker, ledger and drift reads run under that lock,
 * before the first effect. Stepwise work alone keeps a session lock, taken
 * inside the locked transaction before it commits, so there is no moment
 * without a lock between the decision and the stepwise statements.
 *
 * The assertion surface is the statement stream PGlite receives: every
 * statement reaches `execProtocolStream`, where a Parse or simple Query message
 * carries its text.
 */

import type { Schema } from "@client/types";
import { createClient } from "@drivers/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { VibORMErrorCode } from "@errors";
import { createMigrationClient } from "@migrations";
import { MemoryEstateStorage } from "@migrations/storage/memory";
import { s } from "@schema";
import { sql } from "@sql";
import { openTestPGlite } from "@tests/fixtures/pglite-lifecycle";
import { beforeAll, describe, expect, it } from "vitest";

const SESSION_LOCK = /pg_try_advisory_lock\(|pg_advisory_lock\(/;
const UNLOCK = /pg_advisory_unlock\(/;
const XACT_LOCK = /pg_try_advisory_xact_lock\(/;
const BEGIN = /^BEGIN\b/;
const END = /^(COMMIT|ROLLBACK)\b/;
const SET_LOCAL = /^SELECT set_config\('lock_timeout', '\d+', true\)/;
const CONCURRENTLY = /INDEX CONCURRENTLY/;
const STATE_READ = /^SELECT payload FROM "[^"]+"\."_viborm_migration_state"/;
const COMMIT = /^COMMIT$/;
const ADD_NICKNAME = /^ALTER TABLE .*ADD COLUMN "nickname"/;
const ADD_TIER = /^ALTER TABLE .*ADD COLUMN "tier"/;
const DROP_TIER = /DROP COLUMN "tier"/;
const DROP_CONCURRENTLY = /^DROP INDEX CONCURRENTLY/;
const EFFECT =
  /^(ALTER|CREATE|DROP|INSERT|UPDATE|DELETE)\b(?!.*pg_catalog)|^(CREATE|DROP) INDEX/;

const fields = () => ({
  id: s.string().id(),
  email: s.string().unique(),
  name: s.string(),
  status: s.enum(["trial", "active", "churned"]).default("trial"),
  balance: s.int().default(0),
  score: s.number().nullable(),
  settings: s.json().nullable(),
  country: s.string().default("FR"),
  age: s.int().nullable(),
  verified: s.boolean().default(false),
  notes: s.string().nullable(),
  lastSeenAt: s.dateTime().nullable(),
  deletedAt: s.dateTime().nullable(),
  createdAt: s.dateTime().now(),
  updatedAt: s.dateTime().updatedAt(),
});
const v1 = { account: s.model(fields()).map("accounts") };
const v2 = {
  account: s
    .model({ ...fields(), nickname: s.string().nullable() })
    .index(["country"])
    .map("accounts"),
};
/** v2 without its index, and v2 with one more column. */
const nicknamed = {
  account: s
    .model({ ...fields(), nickname: s.string().nullable() })
    .map("accounts"),
};
const nicknamedTiered = {
  account: s
    .model({
      ...fields(),
      nickname: s.string().nullable(),
      tier: s.string().nullable(),
    })
    .index(["country"])
    .map("accounts"),
};
const indexed = {
  account: s.model(fields()).index(["country"]).map("accounts"),
};

const database: PGlite = openTestPGlite();
const decoder = new TextDecoder();
let namespaces = 0;

beforeAll(() => database.waitReady);

/** Every statement `command` sends, whitespace-collapsed, in order. */
async function record(command: () => Promise<unknown>) {
  const send = database.execProtocolStream;
  const statements: string[] = [];
  database.execProtocolStream = (message, options) => {
    if (message[0] === 0x50 || message[0] === 0x51) {
      const start = message[0] === 0x50 ? message.indexOf(0, 5) + 1 : 5;
      const text = decoder.decode(
        message.subarray(start, message.indexOf(0, start))
      );
      statements.push(text.replace(/\s+/g, " ").trim());
    }
    return send.call(database, message, options);
  };
  let failure: unknown;
  try {
    await command();
  } catch (error) {
    failure = error;
  } finally {
    database.execProtocolStream = send;
  }
  return { statements, failure };
}

async function namespace(): Promise<string> {
  namespaces += 1;
  const name = `d1_${namespaces}`;
  await database.exec(`CREATE SCHEMA "${name}"`);
  return name;
}

function client<S extends Schema>(schema: S, name: string) {
  return createClient({ client: database, schema, namespace: name });
}

/**
 * The protocol, read off one command's statements: the session-lock
 * statements (none are expected), every BEGIN not followed by its limits and
 * the transaction lock, every statement that ran outside a locked transaction,
 * and where the first marker read and the first effect are.
 */
function readProtocol(statements: readonly string[]) {
  let open = false;
  let locked = false;
  const outside: string[] = [];
  const unlockedBegins: number[] = [];
  statements.forEach((q, i) => {
    if (BEGIN.test(q)) {
      open = true;
      locked = false;
      const limits = statements[i + 1] ?? "";
      const lock = statements[i + 2] ?? "";
      if (!(SET_LOCAL.test(limits) && XACT_LOCK.test(lock))) {
        unlockedBegins.push(i);
      }
    } else if (XACT_LOCK.test(q)) {
      locked = true;
    } else if (END.test(q)) {
      open = false;
    } else if (!((open && locked) || SET_LOCAL.test(q))) {
      outside.push(q);
    }
  });
  return {
    sessionLocks: statements.filter(
      (q) => SESSION_LOCK.test(q) || UNLOCK.test(q)
    ),
    unlockedBegins,
    outside,
    first: statements[0] ?? "",
    last: statements.at(-1) ?? "",
    lock: statements.findIndex((q) => XACT_LOCK.test(q)),
    firstRead: statements.findIndex((q) => STATE_READ.test(q)),
    firstEffect: statements.findIndex((q) => EFFECT.test(q)),
  };
}

/** What every transaction-scoped command's statements read as. */
const SCOPED = {
  sessionLocks: [],
  unlockedBegins: [],
  outside: [],
  first: "BEGIN",
  last: "COMMIT",
};

describe("every locked PostgreSQL command is transaction-scoped (D1)", () => {
  it("apply reads the marker under the transaction lock and commits its effects in that transaction", async () => {
    const name = await namespace();
    const storage = new MemoryEstateStorage();
    const first = createMigrationClient(client(v1, name), { storage });
    await first.generate({ name: "v1" });
    await first.apply();
    const second = createMigrationClient(client(v2, name), { storage });
    await second.generate({ name: "v2" });

    const { statements, failure } = await record(() => second.apply());

    expect(failure).toBeUndefined();
    const applied = readProtocol(statements);
    expect(applied).toMatchObject(SCOPED);
    expect(applied.firstRead).toBeGreaterThan(applied.lock);
    expect(applied.firstEffect).toBeGreaterThan(applied.firstRead);
    // One transaction: decisions and effects commit together.
    expect(statements.filter((q) => BEGIN.test(q))).toHaveLength(1);

    const verified = await record(() => second.verify());
    expect(verified.failure).toBeUndefined();
    expect(readProtocol(verified.statements)).toMatchObject(SCOPED);

    const down = await record(() =>
      createMigrationClient(client(v1, name), { storage }).down({
        steps: 1,
        expectRevision: 2,
      })
    );
    expect(down.failure).toBeUndefined();
    const rolled = readProtocol(down.statements);
    expect(rolled).toMatchObject(SCOPED);
    expect(rolled.firstEffect).toBeGreaterThan(rolled.firstRead);

    const reset = await record(() =>
      createMigrationClient(client(v1, name), { storage }).reset()
    );
    expect(reset.failure).toBeUndefined();
    expect(readProtocol(reset.statements)).toMatchObject(SCOPED);
  });

  it("push plans and executes under one transaction lock", async () => {
    const name = await namespace();
    const { statements, failure } = await record(() =>
      createMigrationClient(client(v1, name)).push()
    );
    expect(failure).toBeUndefined();
    const pushed = readProtocol(statements);
    expect(pushed).toMatchObject(SCOPED);
    expect(pushed.firstEffect).toBeGreaterThan(pushed.lock);
  });

  it("baseline proves live equality and publishes the marker under one transaction lock", async () => {
    const name = await namespace();
    await createMigrationClient(client(v1, name)).push();
    const storage = new MemoryEstateStorage();
    const migrations = createMigrationClient(client(v1, name), { storage });
    const { stateId } = await migrations.generate({ name: "v1" });
    if (stateId === null) throw new Error("v1 published no state");

    const { statements, failure } = await record(() =>
      migrations.baseline({ to: { id: stateId } })
    );
    expect(failure).toBeUndefined();
    expect(readProtocol(statements)).toMatchObject(SCOPED);
  });

  it("resolve decides under the transaction lock and rolls it back when there is nothing to resolve", async () => {
    const name = await namespace();
    const storage = new MemoryEstateStorage();
    const migrations = createMigrationClient(client(v1, name), { storage });
    await migrations.generate({ name: "v1" });
    await migrations.apply();

    const { statements, failure } = await record(() =>
      migrations.resolve({ outcome: "complete" })
    );
    expect(failure).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
    });
    // A failed command's producer is discarded, never reused, and PGlite's
    // reservation resets a discarded session with this statement.
    expect(statements.at(-1)).toBe("SELECT pg_advisory_unlock_all()");
    const refused = readProtocol(statements.slice(0, -1));
    expect(refused).toMatchObject({ ...SCOPED, last: "ROLLBACK" });
    expect(refused.firstRead).toBeGreaterThan(refused.lock);
  });

  it("an edge that adds an enum value commits alone; the next edge re-locks and re-reads the marker first", async () => {
    const name = await namespace();
    const storage = new MemoryEstateStorage();
    const plans = (values: string[], fallback: string) => ({
      account: s
        .model({
          ...fields(),
          plan: s.enum(values).default(fallback),
        })
        .map("accounts"),
    });
    const base = createMigrationClient(client(plans(["free"], "free"), name), {
      storage,
    });
    await base.generate({ name: "v1" });
    await base.apply();
    await createMigrationClient(client(plans(["free", "vip"], "free"), name), {
      storage,
    }).generate({ name: "add vip" });
    const last = createMigrationClient(
      client(plans(["free", "vip"], "vip"), name),
      { storage }
    );
    await last.generate({ name: "default vip" });

    const { statements, failure } = await record(() => last.apply());

    expect(failure).toBeUndefined();
    expect(readProtocol(statements)).toMatchObject(SCOPED);
    const begins = statements.flatMap((q, i) => (BEGIN.test(q) ? [i] : []));
    expect(begins).toHaveLength(2);
    const relocked = readProtocol(statements.slice(begins[1]));
    expect(relocked.firstRead).toBeGreaterThan(relocked.lock);
    expect(relocked.firstEffect).toBeGreaterThan(relocked.firstRead);
  });
});

describe("stepwise PostgreSQL work keeps a session lock, with no gap (D1)", () => {
  it("the session lock is taken inside the locked transaction that read the marker, and released after the stepwise statements", async () => {
    const name = await namespace();
    const storage = new MemoryEstateStorage();
    const first = createMigrationClient(client(v1, name), { storage });
    const root = await first.generate({ name: "v1" });
    await first.apply();
    const check = (text: string) => ({
      kind: "trusted-read" as const,
      query: sql.raw(text),
      equals: true,
    });
    const second = createMigrationClient(client(indexed, name), { storage });
    await second.generate({
      name: "concurrent index",
      manualMigration: {
        transitions: [
          {
            from: root.stateId,
            execution: "stepwise",
            originChecks: [
              check(
                `SELECT NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE relname = 'accounts_country_idx' AND relnamespace = '${name}'::regnamespace) AS ok`
              ),
            ],
            up: [
              sql.raw(
                `CREATE INDEX CONCURRENTLY "accounts_country_idx" ON "${name}"."accounts" ("country")`
              ),
            ],
            rollback: { kind: "irreversible", reason: "test transition" },
          },
        ],
        destinationChecks: [
          check(
            `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE relname = 'accounts_country_idx' AND relnamespace = '${name}'::regnamespace) AS ok`
          ),
        ],
      },
    });

    const { statements, failure } = await record(() => second.apply());

    expect(failure).toBeUndefined();
    const at = (pattern: RegExp) =>
      statements.findIndex((q) => pattern.test(q));
    const xact = at(XACT_LOCK);
    const read = at(STATE_READ);
    const session = at(SESSION_LOCK);
    const commit = statements.findIndex(
      (q, i) => i > session && q === "COMMIT"
    );
    const concurrently = at(CONCURRENTLY);
    const unlock = at(UNLOCK);
    expect(statements[0]).toMatch(BEGIN);
    expect(xact).toBeGreaterThan(0);
    expect(read).toBeGreaterThan(xact);
    expect(session).toBeGreaterThan(read);
    // Taken before the locked transaction ends: no moment without a lock.
    expect(statements.slice(xact, session).some((q) => END.test(q))).toBe(
      false
    );
    expect(commit).toBeGreaterThan(session);
    expect(concurrently).toBeGreaterThan(commit);
    expect(unlock).toBeGreaterThan(concurrently);
    expect(statements.filter((q) => SESSION_LOCK.test(q))).toHaveLength(1);
  });
});

const trusted = (text: string) => ({
  kind: "trusted-read" as const,
  query: sql.raw(text),
  equals: true,
});
const countryIndex = (name: string, present: boolean) =>
  trusted(
    `SELECT ${present ? "" : "NOT "}EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE relname = 'accounts_country_idx' AND relnamespace = '${name}'::regnamespace) AS ok`
  );
const tiered = {
  account: s
    .model({ ...fields(), tier: s.string().nullable() })
    .index(["country"])
    .map("accounts"),
};

/**
 * A v1 estate, then a stepwise manual transition building the country index
 * concurrently (its rollback drops it concurrently, stepwise too), then a
 * generated edge adding a column: a transactional group around a stepwise one.
 */
async function stepwiseBetween(name: string, storage: MemoryEstateStorage) {
  const first = createMigrationClient(client(v1, name), { storage });
  const root = await first.generate({ name: "v1" });
  await first.apply();
  const v1Marker = await markerPayload(name);
  await createMigrationClient(client(indexed, name), { storage }).generate({
    name: "concurrent index",
    manualMigration: {
      transitions: [
        {
          from: root.stateId,
          execution: "stepwise",
          originChecks: [countryIndex(name, false)],
          up: [
            sql.raw(
              `CREATE INDEX CONCURRENTLY "accounts_country_idx" ON "${name}"."accounts" ("country")`
            ),
          ],
          rollback: {
            kind: "manual",
            execution: "stepwise",
            sql: [
              sql.raw(
                `DROP INDEX CONCURRENTLY "${name}"."accounts_country_idx"`
              ),
            ],
          },
        },
      ],
      destinationChecks: [countryIndex(name, true)],
    },
  });
  const last = createMigrationClient(client(tiered, name), { storage });
  await last.generate({ name: "tier" });
  return { last, v1Marker };
}

async function markerPayload(name: string): Promise<string> {
  const { rows } = await database.query<{ payload: string }>(
    `SELECT payload FROM "${name}"."_viborm_migration_state"`
  );
  return rows[0]!.payload;
}

/**
 * Runs `command` while another runner moves the marker back to `payload` in
 * the first gap between two of its locked transactions — right before the
 * BEGIN that follows its first COMMIT.
 */
async function withMarkerMovedInGap(
  name: string,
  payload: string,
  command: () => Promise<unknown>
) {
  const send = database.execProtocolStream;
  const moved = encodeQuery(
    `UPDATE "${name}"."_viborm_migration_state" SET payload = '${payload.replaceAll("'", "''")}'`
  );
  let committed = false;
  let injected = false;
  database.execProtocolStream = async (message, options) => {
    if (message[0] === 0x50 || message[0] === 0x51) {
      const start = message[0] === 0x50 ? message.indexOf(0, 5) + 1 : 5;
      const text = decoder
        .decode(message.subarray(start, message.indexOf(0, start)))
        .trim();
      if (committed && !injected && BEGIN.test(text)) {
        injected = true;
        await send.call(database, moved);
      }
      committed ||= text === "COMMIT";
    }
    return send.call(database, message, options);
  };
  try {
    return { ...(await record(command)), injected };
  } finally {
    database.execProtocolStream = send;
  }
}

/** One simple-query protocol message. */
function encodeQuery(text: string): Uint8Array {
  const body = new TextEncoder().encode(text);
  const message = new Uint8Array(body.length + 6);
  message[0] = 0x51;
  new DataView(message.buffer).setInt32(1, body.length + 5);
  message.set(body, 5);
  return message;
}

/** Whether statement `index` runs inside a BEGIN … COMMIT/ROLLBACK. */
function insideTransaction(statements: readonly string[], index: number) {
  let open = false;
  for (const q of statements.slice(0, index)) {
    if (BEGIN.test(q)) open = true;
    else if (END.test(q)) open = false;
  }
  return open;
}

const advisoryLocks = async () =>
  (
    await database.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'"
    )
  ).rows[0]!.n;

describe("transactional groups around a stepwise group (D1)", () => {
  it("apply commits each transactional group atomically, and the stepwise group re-reads the marker under the session lock", async () => {
    const name = await namespace();
    const storage = new MemoryEstateStorage();
    const first = createMigrationClient(client(v1, name), { storage });
    await first.generate({ name: "v1" });
    await first.apply();
    // v1 → nickname (transactional) → index (stepwise) → tier (transactional)
    const added = await createMigrationClient(client(nicknamed, name), {
      storage,
    }).generate({ name: "nickname" });
    await createMigrationClient(client(v2, name), {
      storage,
    }).generate({
      name: "concurrent index",
      manualMigration: {
        transitions: [
          {
            from: added.stateId,
            execution: "stepwise",
            originChecks: [countryIndex(name, false)],
            up: [
              sql.raw(
                `CREATE INDEX CONCURRENTLY "accounts_country_idx" ON "${name}"."accounts" ("country")`
              ),
            ],
            rollback: { kind: "irreversible", reason: "test transition" },
          },
        ],
        destinationChecks: [countryIndex(name, true)],
      },
    });
    const last = createMigrationClient(client(nicknamedTiered, name), {
      storage,
    });
    await last.generate({ name: "tier" });

    const { statements, failure } = await record(() => last.apply());

    expect(failure).toBeUndefined();
    const at = (pattern: RegExp, from = 0) =>
      statements.findIndex((q, i) => i >= from && pattern.test(q));
    const nickname = at(ADD_NICKNAME);
    const concurrently = at(CONCURRENTLY);
    const tier = at(ADD_TIER);
    const firstCommit = at(COMMIT);
    expect(nickname).toBeGreaterThan(0);
    expect(insideTransaction(statements, nickname)).toBe(true);
    expect(firstCommit).toBeGreaterThan(nickname);
    expect(firstCommit).toBeLessThan(concurrently);
    // The stepwise group locks again — the session lock inside a locked
    // transaction — and re-reads the marker before its statement.
    const session = at(SESSION_LOCK, firstCommit);
    expect(session).toBeGreaterThan(firstCommit);
    const reread = at(STATE_READ, session);
    expect(reread).toBeGreaterThan(session);
    expect(concurrently).toBeGreaterThan(reread);
    expect(insideTransaction(statements, concurrently)).toBe(false);
    // The last transactional group is atomic again, under the session lock.
    expect(tier).toBeGreaterThan(concurrently);
    expect(insideTransaction(statements, tier)).toBe(true);
    expect(at(UNLOCK, tier)).toBeGreaterThan(tier);
    await expect(last.status()).resolves.toMatchObject({ pending: [] });
    expect(await advisoryLocks()).toBe(0);
  });

  it("down runs a stepwise group that follows a committed group under the session lock, re-read first", async () => {
    const name = await namespace();
    const { last } = await stepwiseBetween(name, new MemoryEstateStorage());
    await last.apply();

    const { statements, failure } = await record(() =>
      last.down({ steps: 2, expectRevision: 3 })
    );

    expect(failure).toBeUndefined();
    const at = (pattern: RegExp, from = 0) =>
      statements.findIndex((q, i) => i >= from && pattern.test(q));
    const firstCommit = at(COMMIT);
    const drop = at(DROP_CONCURRENTLY);
    expect(firstCommit).toBeGreaterThan(at(DROP_TIER));
    const session = at(SESSION_LOCK, firstCommit);
    const reread = at(STATE_READ, session);
    expect(session).toBeGreaterThan(firstCommit);
    expect(reread).toBeGreaterThan(session);
    expect(drop).toBeGreaterThan(reread);
    expect(await advisoryLocks()).toBe(0);
  });

  it("down refuses with V11015, before its stepwise group, when another command moved the marker in the gap", async () => {
    const name = await namespace();
    const { last, v1Marker } = await stepwiseBetween(
      name,
      new MemoryEstateStorage()
    );
    await last.apply();

    const { statements, failure, injected } = await withMarkerMovedInGap(
      name,
      v1Marker,
      () => last.down({ steps: 2, expectRevision: 3 })
    );

    expect(injected).toBe(true);
    expect(failure).toMatchObject({
      code: VibORMErrorCode.MIGRATION_MARKER_CONFLICT,
    });
    expect(statements.some((q) => DROP_CONCURRENTLY.test(q))).toBe(false);
    expect(await advisoryLocks()).toBe(0);
  });

  it("reset refuses with V11015, before its stepwise replay, when another command moved the marker in the gap", async () => {
    const name = await namespace();
    const { last, v1Marker } = await stepwiseBetween(
      name,
      new MemoryEstateStorage()
    );
    await last.apply();

    const { statements, failure, injected } = await withMarkerMovedInGap(
      name,
      v1Marker,
      () => last.reset()
    );

    expect(injected).toBe(true);
    expect(failure).toMatchObject({
      code: VibORMErrorCode.MIGRATION_MARKER_CONFLICT,
    });
    // The clear and the first replay group committed; the stepwise replay
    // never ran.
    expect(statements.some((q) => CONCURRENTLY.test(q))).toBe(false);
    expect(await advisoryLocks()).toBe(0);
  });
});
