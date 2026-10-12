/**
 * Exactly once on SQLite (plan S5).
 *
 * SQLite takes no migration lock: what serializes two runners is the write
 * lock of `BEGIN IMMEDIATE`, and only if the decision is read under it. Each
 * race below starts two OS processes on one database file at the same instant
 * (10,000 accounts of 15 fields) and lets both apply the estate's head: the
 * migration must land once, and the loser must report a no-op or a marker
 * conflict (V11015), never another error.
 *
 * A loser waits for the write lock as long as the command's `lockWait`, past
 * the connection's own busy timeout: under load the winner's transaction
 * outlasted better-sqlite3's 5 s, and the loser reported V11005 instead.
 *
 * The children run the repository's sources through jiti, so the race needs no
 * build. Within one process, two `apply()` calls on one client are serialized
 * by the driver's connection queue, and the second is a no-op.
 */

import { spawn } from "node:child_process";
import { copyFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@drivers/sqlite3";
import { VibORMErrorCode } from "@errors";
import { createMigrationClient } from "@migrations";
import type { Sha256 } from "@migrations/identity";
import { createFsStorageWriter } from "@migrations/storage/fs";
import { sql } from "@sql";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { publishLegacyStepwise } from "./_legacy-stepwise";
import { type RaceVersion, raceSchema } from "./_sqlite-race-schema";

const ROWS = 10_000;
const CREDIT = 10;
const ROUNDS = 4;
const CHILD_TIMEOUT_MS = 60_000;
const RESULT_LINE = /RESULT (.*)\n/;
/** Longer than better-sqlite3's 5 s busy timeout, shorter than `lockWait`. */
const HOLD_MS = 6000;

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const child = join(here, "_sqlite-race-child.ts");
const jiti = join(
  dirname(createRequire(import.meta.url).resolve("jiti/package.json")),
  "lib/jiti-cli.mjs"
);
const betterSqlite3 = createRequire(import.meta.url).resolve("better-sqlite3");
const scratch = mkdtempSync(join(tmpdir(), "viborm-s5-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The repository's path aliases, as jiti reads them. */
function aliases(): string {
  const tsconfig = createRequire(import.meta.url)(join(root, "tsconfig.json"));
  const paths: Record<string, string[]> = tsconfig.compilerOptions.paths;
  const out: Record<string, string> = {};
  for (const [key, [target = ""]] of Object.entries(paths)) {
    if (key.endsWith("/*"))
      out[key.slice(0, -2)] = join(root, target.slice(0, -2));
    else out[key] ??= join(root, target);
  }
  return JSON.stringify(out);
}
const JITI_ALIAS = aliases();

interface RunnerResult {
  readonly outcome?: string;
  readonly code?: unknown;
  readonly message?: string;
}

function runChild(
  file: string,
  estate: string,
  startAt: number,
  version: RaceVersion
): Promise<RunnerResult> {
  return new Promise((done) => {
    const proc = spawn(
      process.execPath,
      [jiti, child, file, estate, String(startAt), version],
      {
        cwd: root,
        env: { ...process.env, JITI_ALIAS },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: CHILD_TIMEOUT_MS,
      }
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
      done(
        line?.[1]
          ? JSON.parse(line[1])
          : { message: `child exited ${code ?? signal}: ${err.slice(-400)}` }
      );
    });
  });
}

/** One number the query answers as `n`, read through a third connection. */
const read = (file: string, query: string): number => {
  const db = new Database(file, { readonly: true });
  try {
    return db.prepare<[], { n: number }>(query).get()?.n ?? Number.NaN;
  } finally {
    db.close();
  }
};
const balanceSum = (file: string) =>
  read(file, `SELECT sum("balance") AS n FROM "account"`);
const appliedEvents = (file: string) =>
  read(
    file,
    `SELECT count(*) AS n FROM "_viborm_migration_log" WHERE "kind" = 'applied'`
  );

const anyRow = {
  kind: "trusted-read" as const,
  query: sql.raw(`SELECT EXISTS (SELECT 1 FROM "account") AS ok`),
  equals: true,
};
function credit(from: string | null, execution: "transactional" | "stepwise") {
  return {
    transitions: [
      {
        from,
        execution,
        originChecks: [anyRow],
        up: [sql.raw(`UPDATE "account" SET "balance" = "balance" + ${CREDIT}`)],
        rollback: { kind: "irreversible" as const, reason: "test credit" },
      },
    ],
    destinationChecks: [anyRow],
  };
}

let fixtures = 0;

/**
 * A database at `init` holding ROWS accounts, and an estate whose head is the
 * next transition: a credit (a data migration), or a generated one that adds
 * a column in place or rebuilds the table.
 */
async function prepare(
  kind: "transactional" | "stepwise" | "column" | "rebuild"
): Promise<{
  template: string;
  estate: string;
  version: RaceVersion;
  init: string | null;
  head: string | null;
}> {
  fixtures += 1;
  const template = join(scratch, `template-${kind}-${fixtures}.sqlite`);
  const estate = join(scratch, `estate-${kind}-${fixtures}`);
  const storage = createFsStorageWriter(estate);
  const client = createClient({ schema: raceSchema("v1"), dataDir: template });
  try {
    const migrations = createMigrationClient(client, { storage });
    const init = await migrations.generate({ name: "init" });
    await migrations.apply();
    const tiers = ["free", "pro", "enterprise"] as const;
    for (let start = 0; start < ROWS; start += 1000) {
      await client.account.createMany({
        data: Array.from({ length: 1000 }, (_, offset) => {
          const i = start + offset;
          return {
            id: `acc-${i}`,
            email: `user${i}@example.test`,
            name: `User ${i}`,
            status: "active" as const,
            tier: tiers[i % 3] ?? "free",
            balance: 100,
            country: i % 4 === 0 ? null : "FR",
            metadata: { segment: i % 7, tags: ["a", "b"] },
            lastLoginAt: new Date(Date.UTC(2026, 0, 1 + (i % 28))),
          };
        }),
      });
    }
    if (kind === "column" || kind === "rebuild") {
      const next = createClient({
        schema: raceSchema(kind),
        dataDir: template,
      });
      try {
        const head = await createMigrationClient(next, { storage }).generate({
          name: kind,
        });
        return {
          template,
          estate,
          version: kind,
          init: init.stateId,
          head: head.stateId,
        };
      } finally {
        await next.$disconnect();
      }
    }
    const head = await migrations.generate({
      name: `credit-${kind}`,
      manualMigration: credit(init.stateId, "transactional"),
    });
    if (kind === "stepwise") {
      // Generate refuses it since 1.2.0 (plan S5): the head is 1.1.0's.
      const legacy = `${estate}-1.1.0`;
      cpSync(estate, legacy, {
        recursive: true,
        filter: (path) => basename(path) !== `${head.stateId}.json`,
      });
      return {
        template,
        estate: legacy,
        version: "v1",
        init: init.stateId,
        head: await publishLegacyStepwise(
          storage,
          createFsStorageWriter(legacy),
          head.stateId as Sha256
        ),
      };
    }
    return {
      template,
      estate,
      version: "v1",
      init: init.stateId,
      head: head.stateId,
    };
  } finally {
    await client.$disconnect();
  }
}

describe("two processes applying one SQLite migration (S5)", () => {
  for (const kind of ["transactional", "column", "rebuild"] as const) {
    it(`a ${kind} migration lands once, and the loser is a no-op or a marker conflict`, async () => {
      const prepared = await prepare(kind);
      const rounds: string[] = [];
      for (let round = 0; round < ROUNDS; round += 1) {
        const file = join(scratch, `${kind}-${round}.sqlite`);
        copyFileSync(prepared.template, file);
        const before = balanceSum(file);
        const eventsBefore = appliedEvents(file);
        const startAt = Date.now() + 4000;
        const results = await Promise.all([
          runChild(file, prepared.estate, startAt, prepared.version),
          runChild(file, prepared.estate, startAt, prepared.version),
        ]);
        const credits =
          prepared.version === "v1"
            ? (balanceSum(file) - before) / (ROWS * CREDIT)
            : 1;
        rounds.push(
          JSON.stringify({
            credits,
            events: appliedEvents(file) - eventsBefore,
            outcomes: results.map(
              (r) => r.outcome ?? `${String(r.code)} ${r.message}`
            ),
          })
        );
      }
      const conflict = `${VibORMErrorCode.MIGRATION_MARKER_CONFLICT} `;
      for (const line of rounds) {
        const { credits, events, outcomes } = JSON.parse(line);
        const losers: string[] = outcomes.filter(
          (outcome: string) => outcome !== "applied"
        );
        expect({ credits, events, losers: losers.length }, line).toEqual({
          credits: 1,
          events: 1,
          losers: 1,
        });
        expect(
          losers.every(
            (loser) => loser === "noop" || loser.startsWith(conflict)
          ),
          line
        ).toBe(true);
      }
    }, 300_000);
  }
});

describe("a writer holding the database past the busy timeout (S5)", () => {
  it("the command waits lockWait for BEGIN IMMEDIATE, then applies", async () => {
    const prepared = await prepare("transactional");
    const file = join(scratch, "held.sqlite");
    copyFileSync(prepared.template, file);
    const before = balanceSum(file);
    // Another process takes the write lock and keeps it 6 s, beyond the
    // connection's 5 s busy timeout, then lets it go without a change.
    const holder = spawn(
      process.execPath,
      [
        "-e",
        `const db = new (require(${JSON.stringify(betterSqlite3)}))(${JSON.stringify(file)});
db.exec("BEGIN IMMEDIATE");
process.stdout.write("HELD\\n");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${HOLD_MS});
db.exec("ROLLBACK");
db.close();`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] }
    );
    await new Promise<void>((held) => {
      holder.stdout.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("HELD")) held();
      });
    });
    const client = createClient({ schema: raceSchema("v1"), dataDir: file });
    try {
      const started = Date.now();
      await expect(
        createMigrationClient(client, {
          storage: createFsStorageWriter(prepared.estate),
        }).apply()
      ).resolves.toMatchObject({ outcome: "applied" });
      expect(Date.now() - started).toBeGreaterThan(HOLD_MS - 1000);
      expect(balanceSum(file) - before).toBe(ROWS * CREDIT);
    } finally {
      await client.$disconnect();
      holder.kill();
    }
  }, 120_000);
});

describe("one process (S5)", () => {
  it("two apply() calls on one client run one after the other: one applies, the other is a no-op", async () => {
    const prepared = await prepare("transactional");
    const file = join(scratch, "one-client.sqlite");
    copyFileSync(prepared.template, file);
    const client = createClient({ schema: raceSchema("v1"), dataDir: file });
    try {
      const migrations = createMigrationClient(client, {
        storage: createFsStorageWriter(prepared.estate),
      });
      const before = balanceSum(file);
      const results = await Promise.allSettled([
        migrations.apply(),
        migrations.apply(),
      ]);
      expect(
        results.map((r) =>
          r.status === "fulfilled" ? r.value.outcome : r.reason
        )
      ).toEqual(["applied", "noop"]);
      expect(balanceSum(file) - before).toBe(ROWS * CREDIT);
    } finally {
      await client.$disconnect();
    }
  }, 120_000);

  it("generate refuses a manual stepwise transition or rollback on SQLite before publishing it", async () => {
    const prepared = await prepare("transactional");
    const client = createClient({
      schema: raceSchema("v1"),
      dataDir: prepared.template,
    });
    try {
      const storage = createFsStorageWriter(prepared.estate);
      const states = await storage.listStates();
      const migrations = createMigrationClient(client, { storage });
      const forward = credit(prepared.init, "stepwise");
      const [transactional] = credit(
        prepared.init,
        "transactional"
      ).transitions;
      const rollback = {
        ...forward,
        transitions: [
          {
            ...transactional!,
            rollback: {
              kind: "manual" as const,
              execution: "stepwise" as const,
              sql: [
                sql.raw(
                  `UPDATE "account" SET "balance" = "balance" - ${CREDIT}`
                ),
              ],
            },
          },
        ],
      };
      for (const manualMigration of [forward, rollback]) {
        await expect(
          migrations.generate({ name: "credit-stepwise", manualMigration })
        ).rejects.toMatchObject({
          code: VibORMErrorCode.MIGRATION_UNSUPPORTED_PROVIDER,
          meta: { dialect: "sqlite", feature: "stepwise execution" },
        });
      }
      expect(await storage.listStates()).toEqual(states);
    } finally {
      await client.$disconnect();
    }
  }, 120_000);

  it("a manual stepwise transition 1.1.0 published is refused on SQLite before any effect, and the upgrade step applies it as transactional", async () => {
    const prepared = await prepare("stepwise");
    const file = join(scratch, "stepwise.sqlite");
    copyFileSync(prepared.template, file);
    const client = createClient({ schema: raceSchema("v1"), dataDir: file });
    try {
      const before = balanceSum(file);
      const eventsBefore = appliedEvents(file);
      // A transactional apply writes no `started` event (plan D5), so the
      // count to keep is the one before this apply, not the applied count.
      const startedEvents = () =>
        read(
          file,
          `SELECT count(*) AS n FROM "_viborm_migration_log" WHERE "kind" = 'started'`
        );
      const startedBefore = startedEvents();
      await expect(
        createMigrationClient(client, {
          storage: createFsStorageWriter(prepared.estate),
        }).apply()
      ).rejects.toMatchObject({
        code: VibORMErrorCode.MIGRATION_UNSUPPORTED_PROVIDER,
      });
      expect(balanceSum(file)).toBe(before);
      expect(appliedEvents(file)).toBe(eventsBefore);
      expect(startedEvents()).toBe(startedBefore);

      // The upgrade step: no database applied it, so its state leaves the
      // estate (its `states/<id>.json` file) and is generated again from the
      // same parent with the same SQL, as transactional.
      const upgraded = `${prepared.estate}-upgraded`;
      cpSync(prepared.estate, upgraded, {
        recursive: true,
        filter: (path) => basename(path) !== `${prepared.head}.json`,
      });
      const storage = createFsStorageWriter(upgraded);
      const migrations = createMigrationClient(client, { storage });
      await migrations.generate({
        name: "credit-transactional",
        manualMigration: credit(prepared.init, "transactional"),
      });
      await expect(migrations.apply()).resolves.toMatchObject({
        outcome: "applied",
      });
      expect(balanceSum(file) - before).toBe(ROWS * CREDIT);
      // One leaf: the next migration generates and applies on top of it.
      const next = createClient({
        schema: raceSchema("column"),
        dataDir: file,
      });
      try {
        const following = createMigrationClient(next, { storage });
        await following.generate({ name: "column" });
        await expect(following.apply()).resolves.toMatchObject({
          outcome: "applied",
        });
      } finally {
        await next.$disconnect();
      }
    } finally {
      await client.$disconnect();
    }
  }, 120_000);
});
