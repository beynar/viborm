// S5: exactly once on SQLite. Two processes apply the same data migration to one
// SQLite file at the same instant: the credit must land once, and the loser must
// report a marker conflict (MigrationError V11015) or a no-op, never another
// error. A manual `execution: 'stepwise'` transition must be refused on SQLite.
// When 1.1.0 still accepts stepwise, the race is run on it too, to show the
// review's double application (FI-02).
import { spawn } from "node:child_process";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { s, sql } from "viborm";
import { createMigrationClient, isMigrationError } from "viborm/migrations";
import { createFsStorageWriter } from "viborm/migrations/storage/fs";
import { createClient } from "viborm/sqlite3";

export const meta = {
  id: "S5",
  title: "SQLite data migrations apply exactly once under concurrent apply",
  plan: "phase-1/lane-L/S5",
  needs: [],
  source:
    "docs/architecture/migrations-durable-objects-review-2026-10-09 FI-02/FI-12 (evidence/fault-injection/harness/race.mjs, probes/p03-manual-inprocess-race.mjs); completion-plan-2026-10/code-check-probes/migrations-sqlite/probes/concurrency-probe.mjs",
};

const CHILD_FLAG = "--viborm-s5-child";
const ROWS = 10_000;
const CREDIT = 10;
const ROUNDS = 3;
const CHILD_TIMEOUT_MS = 30_000;
const MARKER_CONFLICT = "V11015";
const RESULT_LINE = /RESULT (.*)\n/;

const schema = (version = "v1") => ({
  account: s.model({
    ...(version === "v2"
      ? { referrer: s.string().nullable(), score: s.int().default(0) }
      : {}),
    id: s.string().id(),
    email: s.string().unique(),
    name: s.string(),
    status: s.enum(["active", "suspended", "closed"]),
    tier: s.enum(["free", "pro", "enterprise"]),
    balance: s.int(),
    creditLimit: s.int().default(0),
    currency: s.string().default("EUR"),
    country: s.string().nullable(),
    metadata: s.json().nullable(),
    flags: s.int().default(0),
    note: s.string().nullable(),
    lastLoginAt: s.dateTime().nullable(),
    createdAt: s.dateTime().now(),
    updatedAt: s.dateTime().updatedAt(),
  }),
});

const describe = (error) =>
  `${isMigrationError(error) ? "MigrationError" : (error?.name ?? "Error")}/${error?.code ?? "-"}: ${String(error?.message).slice(0, 140)}`;

// ---------------------------------------------------------------- child side
async function child(dbPath, estateDir, startAt, version) {
  const client = createClient({ schema: schema(version), dataDir: dbPath });
  const migrations = createMigrationClient(client, {
    storage: createFsStorageWriter(estateDir),
  });
  while (Date.now() < startAt) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  let result;
  try {
    result = { outcome: (await migrations.apply()).outcome };
  } catch (error) {
    result = {
      error: describe(error),
      migrationError: isMigrationError(error),
      code: error?.code,
    };
  }
  process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
  await client.$disconnect();
}

if (process.argv[2] === CHILD_FLAG) {
  const [dbPath, estateDir, startAt, version] = process.argv.slice(3);
  await child(dbPath, estateDir, Number(startAt), version);
  process.exit(0);
}

// --------------------------------------------------------------- parent side
function runChild(dbPath, estateDir, startAt, version = "v1") {
  return new Promise((resolve) => {
    const proc = spawn(
      process.execPath,
      [
        fileURLToPath(import.meta.url),
        CHILD_FLAG,
        dbPath,
        estateDir,
        String(startAt),
        version,
      ],
      { stdio: ["ignore", "pipe", "pipe"], timeout: CHILD_TIMEOUT_MS }
    );
    let out = "";
    let err = "";
    proc.stdout.on("data", (chunk) => {
      out += chunk;
    });
    proc.stderr.on("data", (chunk) => {
      err += chunk;
    });
    proc.on("close", (code, signal) => {
      const line = RESULT_LINE.exec(out);
      resolve(
        line
          ? JSON.parse(line[1])
          : { error: `child exited ${code ?? signal}: ${err.slice(-200)}` }
      );
    });
  });
}

const balanceSum = (dbPath) => {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(`SELECT sum("balance") AS s FROM "account"`).get().s;
  } finally {
    db.close();
  }
};

const credit = (from, execution) => {
  const anyRow = {
    kind: "trusted-read",
    query: sql.raw(`SELECT EXISTS (SELECT 1 FROM "account") AS ok`),
    equals: true,
  };
  return {
    transitions: [
      {
        from,
        execution,
        originChecks: [anyRow],
        up: [sql.raw(`UPDATE "account" SET "balance" = "balance" + ${CREDIT}`)],
        rollback: { kind: "irreversible", reason: "probe" },
      },
    ],
    destinationChecks: [anyRow],
  };
};

/**
 * A template database at `init` holding ROWS accounts, and an estate whose head
 * is the next transition: a credit (`stepwise` or `transactional` data
 * migration) or the generated `v2` (`structural`: a column and a default).
 */
async function prepare(tmpDir, kind) {
  const template = join(tmpDir, `template-${kind}.sqlite`);
  const estateDir = join(tmpDir, `estate-${kind}`);
  const storage = createFsStorageWriter(estateDir);
  const client = createClient({ schema: schema(), dataDir: template });
  const migrations = createMigrationClient(client, { storage });
  try {
    const init = await migrations.generate({ name: "init" });
    await migrations.apply();
    const tiers = ["free", "pro", "enterprise"];
    for (let start = 0; start < ROWS; start += 1000) {
      await client.account.createMany({
        data: Array.from({ length: 1000 }, (_, offset) => {
          const i = start + offset;
          return {
            id: `acc-${i}`,
            email: `user${i}@example.test`,
            name: `User ${i}`,
            status: "active",
            tier: tiers[i % 3],
            balance: 100,
            country: i % 4 === 0 ? null : "FR",
            metadata: { segment: i % 7, tags: ["a", "b"] },
            lastLoginAt: new Date(Date.UTC(2026, 0, 1 + (i % 28))),
          };
        }),
      });
    }
    if (kind === "structural") {
      const next = createClient({ schema: schema("v2"), dataDir: template });
      try {
        await createMigrationClient(next, { storage }).generate({ name: "v2" });
      } finally {
        await next.$disconnect();
      }
      return { template, estateDir, version: "v2" };
    }
    try {
      await migrations.generate({
        name: `credit-${kind}`,
        manualMigration: credit(init.stateId, kind),
      });
    } catch (error) {
      if (!isMigrationError(error)) throw error;
      return { refusedAtGenerate: describe(error) };
    }
  } finally {
    await client.$disconnect();
  }
  return { template, estateDir, version: "v1" };
}

const appliedEvents = (dbPath) => {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT count(*) AS n FROM "_viborm_migration_log" WHERE "kind" = 'applied'`
      )
      .get().n;
  } finally {
    db.close();
  }
};

/** One round: two processes apply the pending transition to a fresh copy at the same instant. */
async function race(tmpDir, prepared, label, round) {
  const dbPath = join(tmpDir, `${label}-${round}.sqlite`);
  copyFileSync(prepared.template, dbPath);
  const before = balanceSum(dbPath);
  const eventsBefore = appliedEvents(dbPath);
  const startAt = Date.now() + 1500;
  const results = await Promise.all([
    runChild(dbPath, prepared.estateDir, startAt, prepared.version),
    runChild(dbPath, prepared.estateDir, startAt, prepared.version),
  ]);
  const credits =
    prepared.version === "v1"
      ? (balanceSum(dbPath) - before) / (ROWS * CREDIT)
      : 1;
  const events = appliedEvents(dbPath) - eventsBefore;
  const applied = results.filter((r) => r.outcome === "applied").length;
  const badLosers = results.filter(
    (r) =>
      r.outcome !== "applied" &&
      r.outcome !== "noop" &&
      !(r.migrationError && r.code === MARKER_CONFLICT)
  );
  const ok =
    credits === 1 && events === 1 && applied === 1 && badLosers.length === 0;
  const summary = results.map((r) => r.outcome ?? r.error).join(" | ");
  const effect = prepared.version === "v1" ? `credited ${credits}x, ` : "";
  return {
    ok,
    line: `${label}#${round}: ${effect}${events} applied event(s); ${summary}`,
  };
}

export default async function probe(ctx) {
  const failures = [];
  const notes = [];

  // (1) A manual stepwise transition must be refused on SQLite before any effect.
  const stepwise = await prepare(ctx.tmpDir, "stepwise");
  let stepwiseAccepted = false;
  if (stepwise.refusedAtGenerate) {
    notes.push(`stepwise refused at generate: ${stepwise.refusedAtGenerate}`);
  } else {
    const probeDb = join(ctx.tmpDir, "stepwise-single.sqlite");
    copyFileSync(stepwise.template, probeDb);
    const before = balanceSum(probeDb);
    const single = await runChild(probeDb, stepwise.estateDir, 0);
    const changed = balanceSum(probeDb) !== before;
    if (single.migrationError && !changed) {
      notes.push(`stepwise refused at apply: ${single.error}`);
    } else {
      stepwiseAccepted = true;
      failures.push(
        `manual execution:'stepwise' accepted on SQLite (generate ok, apply ${single.outcome ?? single.error}${changed ? ", balances changed" : ""})`
      );
    }
  }

  // (2) Two processes race the shapes that stay: a transactional data migration
  // and a generated structural transition (FI-12: the loser's DDL collision).
  const rounds = [];
  for (const kind of ["transactional", "structural"]) {
    const prepared = await prepare(ctx.tmpDir, kind);
    if (prepared.refusedAtGenerate) {
      throw new Error(
        `${kind} refused at generate: ${prepared.refusedAtGenerate}`
      );
    }
    for (let round = 0; round < ROUNDS; round += 1) {
      rounds.push(await race(ctx.tmpDir, prepared, kind, round));
    }
  }
  // (3) Evidence only: on a version that still accepts stepwise, race it too (FI-02).
  if (stepwiseAccepted) {
    for (let round = 0; round < ROUNDS; round += 1) {
      rounds.push(await race(ctx.tmpDir, stepwise, "stepwise", round));
    }
  }
  const badRounds = rounds.filter((r) => !r.ok);
  if (badRounds.length > 0) {
    failures.push(
      `${badRounds.length}/${rounds.length} two-process rounds not exactly-once with a noop/${MARKER_CONFLICT} loser`
    );
  }
  const detail = [...notes, ...rounds.map((r) => r.line)].join("\n");
  return failures.length === 0
    ? {
        status: "pass",
        evidence: `stepwise refused on SQLite; ${rounds.length} two-process rounds applied once with a noop/${MARKER_CONFLICT} loser\n${detail}`,
      }
    : { status: "fail", evidence: `${failures.join("; ")}\n${detail}` };
}
