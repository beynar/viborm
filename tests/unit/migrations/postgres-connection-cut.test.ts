/**
 * The connection-cut fault lane (plan M0.3): the migration session dies at each
 * phase of a locked `apply()` or `push()`, over node-postgres and postgres.js,
 * and the lane records what the caller observes.
 *
 * PGlite behind the wire bridge plays the server, so the lane needs no Docker:
 * `killSessionOn(text, at)` destroys the client socket on the statement that
 * opens a phase, and the session then ends as a PostgreSQL backend's does, its
 * transaction rolled back and its advisory locks released. Every await on the
 * cut command is bounded: one that does not settle within `BOUND_MS` is a
 * hang, and an exception that escapes to the process is a crash.
 *
 * The target (plan S2) is one typed error at every cut: no hang, no crash, no
 * cleanup statement sent to the dead session. 1.1.0 missed it (review finding
 * PGF-03): postgres.js wrote VibORM's ROLLBACK or unlock to the dead reserved
 * connection, threw out of a timer and never settled; node-postgres reported
 * the cut and the ROLLBACK sent after it as one AggregateError. Every cut now
 * ends in the retryable connection failure V1001, on both drivers — except an
 * apply cut after its COMMIT ran, which cannot re-read the marker it may have
 * committed and says so with the ambiguous commit V11020 (plan S3).
 *
 * The phases are D1's: the lock is a transaction lock taken right after
 * `BEGIN`, and the marker is read under it; the transaction's end releases the
 * lock. Only stepwise work keeps a session lock and sends an unlock statement,
 * cut once more after that work committed.
 */

import { createClient as createPgClient } from "@drivers/pg";
import { createClient as createPostgresClient } from "@drivers/postgres";
import { createMigrationClient } from "@migrations";
import { MemoryEstateStorage } from "@migrations/storage/memory";
import { s } from "@schema";
import { sql } from "@sql";
import { openTestPGlite } from "@tests/fixtures/pglite-lifecycle";
import {
  type CutPoint,
  pgliteWireServer,
} from "@tests/fixtures/pglite-wire-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BOUND_MS = 2500;

const fields = {
  id: s.string().id(),
  tenantId: s.string(),
  email: s.string().unique(),
  displayName: s.string(),
  plan: s.enum(["free", "team", "enterprise"]).default("free"),
  seats: s.int().default(1),
  balanceCents: s.bigInt().default(0n),
  creditRate: s.decimal({ precision: 12, scale: 4 }).nullable(),
  active: s.boolean().default(true),
  verified: s.boolean().default(false),
  trialEndsAt: s.dateTime().nullable(),
  lastSeenAt: s.dateTime().nullable(),
  settings: s.json().nullable(),
  createdAt: s.dateTime().now(),
  updatedAt: s.dateTime().updatedAt(),
};
const v1 = { account: s.model(fields).map("accounts") };
/** The stepwise migration under the cut: an index built concurrently. */
const indexed = {
  account: s.model(fields).index(["plan"]).map("accounts"),
};
/** The migration under the cut: two columns on the existing table. */
const v2 = {
  account: s
    .model({
      ...fields,
      region: s.string().nullable(),
      score: s.int().default(0),
    })
    .map("accounts"),
};

type Versions = typeof v1 | typeof v2 | typeof indexed;

/** A manual stepwise transition from `from` building the plan index. */
function concurrentIndex(namespace: string, from: string | null) {
  const holds = (present: boolean) => ({
    kind: "trusted-read" as const,
    query: sql.raw(
      `SELECT ${present ? "" : "NOT "}EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE relname = 'accounts_plan_idx' AND relnamespace = '${namespace}'::regnamespace) AS ok`
    ),
    equals: true,
  });
  return {
    name: "plan index",
    manualMigration: {
      transitions: [
        {
          from,
          execution: "stepwise" as const,
          originChecks: [holds(false)],
          up: [
            sql.raw(
              `CREATE INDEX CONCURRENTLY "accounts_plan_idx" ON "${namespace}"."accounts" ("plan")`
            ),
          ],
          rollback: { kind: "irreversible" as const, reason: "test index" },
        },
      ],
      destinationChecks: [holds(true)],
    },
  };
}

const DRIVERS = {
  pg: (url: string, namespace: string, schema: Versions) =>
    createPgClient({
      schema,
      databaseUrl: url,
      namespace,
      options: { max: 1, connectionTimeoutMillis: 2000 },
    }),
  postgres: (url: string, namespace: string, schema: Versions) =>
    createPostgresClient({
      schema,
      databaseUrl: url,
      namespace,
      options: { max: 1, connect_timeout: 2 },
    }),
};
type DriverName = keyof typeof DRIVERS;
/** `stepwise` applies a manual stepwise transition: the one kind of work that
 * keeps a session lock, and so the one that sends an unlock statement. */
type Command = "apply" | "push" | "stepwise";

/** What the caller observed, and whether the migration landed. */
interface Observed {
  readonly cut: boolean;
  /** `resolved <outcome>`, `rejected <code>`, or `pending` past `BOUND_MS`. */
  readonly command: string;
  /** The same, for `$disconnect()` of the client the cut hit. */
  readonly disconnect: string;
  /** Exceptions that escaped to the process. */
  readonly crashes: readonly string[];
  readonly landed: boolean;
}

interface Cut {
  readonly phase: string;
  readonly text: (namespace: string) => string;
  readonly at: CutPoint;
  readonly commands: readonly Command[];
  /** Whether v2 is in the database afterwards: only a cut after it committed. */
  readonly lands: boolean;
  /** What `apply` settles with, when it does not reject with V1001. */
  readonly apply?: string;
}

/** One cut per phase of a locked command, on the statement that opens it. */
const CUTS: readonly Cut[] = [
  {
    phase: "before BEGIN",
    text: () => "BEGIN",
    at: "before",
    commands: ["apply", "push"],
    lands: false,
  },
  {
    phase: "after BEGIN",
    text: () => "BEGIN",
    at: "after",
    commands: ["apply", "push"],
    lands: false,
  },
  {
    phase: "during lock acquisition",
    text: () => "pg_try_advisory_xact_lock",
    at: "after",
    commands: ["apply", "push"],
    lands: false,
  },
  {
    phase: "during the marker read, under the lock",
    text: (namespace) =>
      `SELECT payload FROM "${namespace}"."_viborm_migration_state"`,
    at: "after",
    commands: ["apply"],
    lands: false,
  },
  {
    phase: "during the DDL",
    text: () => "ALTER TABLE",
    at: "after",
    commands: ["apply", "push"],
    lands: false,
  },
  {
    phase: "after the marker CAS",
    text: (namespace) => `UPDATE "${namespace}"."_viborm_migration_state"`,
    at: "after",
    commands: ["apply"],
    lands: false,
  },
  {
    phase: "at COMMIT, before its reply",
    text: () => "COMMIT",
    at: "after",
    commands: ["apply", "push"],
    lands: true,
    apply: "rejected V11020",
  },
  {
    phase: "during the session-lock release, after the stepwise work",
    text: () => "pg_advisory_unlock(",
    at: "after",
    commands: ["stepwise"],
    lands: true,
    // The path committed before the release: apply keeps that outcome, and
    // the server frees the session lock with the session (plan S3).
    apply: "resolved applied",
  },
];

/** S2's target: the command rejects with the retryable connection failure,
 * nothing escapes, and the client still closes. */
const TARGET: Omit<Observed, "cut" | "landed"> = {
  command: "rejected V1001",
  disconnect: "resolved",
  crashes: [],
};

const PENDING = Symbol("pending");

/** `promise`, or `PENDING` once `BOUND_MS` passed. */
async function within<T>(promise: Promise<T>): Promise<T | typeof PENDING> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<typeof PENDING>((resolve) => {
    timer = setTimeout(() => resolve(PENDING), BOUND_MS);
  });
  try {
    return await Promise.race([promise, bound]);
  } finally {
    clearTimeout(timer);
  }
}

function describeFailure(failure: unknown): string {
  if (failure instanceof AggregateError) {
    return `AggregateError(${failure.errors.map(describeFailure).join(", ")})`;
  }
  if (!(failure instanceof Error)) return String(failure);
  return "code" in failure && typeof failure.code === "string"
    ? failure.code
    : failure.name;
}

async function settle(promise: Promise<string>): Promise<string> {
  const settled = await within(
    promise.then(
      (value) => `resolved${value ? ` ${value}` : ""}`,
      (failure: unknown) => `rejected ${describeFailure(failure)}`
    )
  );
  return settled === PENDING ? "pending" : settled;
}

/** Runs `body` with every exception that escapes to the process recorded,
 * instead of failing the run from outside the test. An unhandled rejection
 * still fails the run: vitest keeps that listener. */
async function recordingCrashes<T>(
  body: (crashes: string[]) => Promise<T>
): Promise<T> {
  const crashes: string[] = [];
  const record = (failure: Error) => {
    crashes.push(`${failure.name}: ${failure.message}`);
  };
  const saved = process.listeners("uncaughtException");
  process.removeAllListeners("uncaughtException");
  process.on("uncaughtException", record);
  try {
    return await body(crashes);
  } finally {
    process.removeListener("uncaughtException", record);
    for (const listener of saved) process.on("uncaughtException", listener);
  }
}

const database = openTestPGlite();
const server = pgliteWireServer(database);
let scenarios = 0;

beforeAll(() => database.waitReady);
afterAll(() => server.stop());

/** Migrates a fresh namespace to v1, then runs `command` to v2 through `cut`. */
async function cutDuring(
  driver: DriverName,
  command: Command,
  cut: Cut
): Promise<Observed> {
  scenarios += 1;
  const namespace = `cut_${scenarios}`;
  await database.exec(`CREATE SCHEMA "${namespace}"`);
  const url = `postgres://postgres:postgres@127.0.0.1:${await server.start()}/postgres`;
  const storage = new MemoryEstateStorage();
  const current = DRIVERS[driver](url, namespace, v1);
  const next = DRIVERS[driver](
    url,
    namespace,
    command === "stepwise" ? indexed : v2
  );
  try {
    if (command === "apply") {
      const migrations = createMigrationClient(current, { storage });
      await migrations.generate({ name: "v1" });
      await migrations.apply();
      await createMigrationClient(next, { storage }).generate({ name: "v2" });
    } else if (command === "stepwise") {
      const migrations = createMigrationClient(current, { storage });
      const root = await migrations.generate({ name: "v1" });
      await migrations.apply();
      await createMigrationClient(next, { storage }).generate(
        concurrentIndex(namespace, root.stateId)
      );
    } else {
      await createMigrationClient(current).push();
    }
    await current.$disconnect();
    const observed = await recordingCrashes(async (crashes) => {
      const fired = server.killSessionOn(cut.text(namespace), cut.at);
      const run =
        command === "push"
          ? createMigrationClient(next).push()
          : createMigrationClient(next, { storage }).apply();
      return {
        command: await settle(run.then(({ outcome }) => outcome)),
        cut: (await within(fired)) !== PENDING,
        disconnect: await settle(next.$disconnect().then(() => "")),
        crashes,
      };
    });
    await server.stop();
    const { rows } = await database.query<{ landed: boolean }>(
      command === "stepwise"
        ? `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_class
             WHERE relname = 'accounts_plan_idx'
               AND relnamespace = $1::regnamespace) AS landed`
        : `SELECT EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = $1 AND table_name = 'accounts'
               AND column_name = 'region') AS landed`,
      [namespace]
    );
    return { ...observed, landed: rows[0]?.landed === true };
  } finally {
    // Whatever the clients still hold, their sockets die here.
    await server.stop();
  }
}

for (const driver of Object.keys(DRIVERS) as DriverName[]) {
  describe(`a migration session cut over ${driver}`, () => {
    for (const cut of CUTS) {
      for (const command of cut.commands) {
        it(`${command}: ${cut.phase}`, async () => {
          expect(await cutDuring(driver, command, cut)).toEqual({
            cut: true,
            landed: cut.lands,
            ...TARGET,
            ...(command !== "push" && cut.apply ? { command: cut.apply } : {}),
          });
        });
      }
    }
  });
}
