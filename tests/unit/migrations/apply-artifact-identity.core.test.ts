/**
 * The artifact `apply()` executes is the one the entry it RECORDS names.
 *
 * `apply()` reads every pending artifact in its preflight, before its first
 * durable effect, and then rereads the authoritative journal after each commit
 * because the next entry must be chosen from the journal as it is now. Those two
 * facts meet on one question: when the reread returns an entry the preflight
 * also saw, is the artifact the preflight read still THAT entry's artifact?
 *
 * It is not, whenever the journal entry changed. The preflight cache used to be
 * keyed by `entry.name` alone, while the tracking row is written from
 * `(name, checksum)` and the artifact path from `(idx, name)` — so a journal
 * republished between two commits handed the loop a name it had a cached answer
 * for, and the command executed the OLD SQL while recording the NEW checksum.
 * One estate then holds a history row that names a migration whose SQL never
 * ran, and the artifact that did run is recorded nowhere.
 *
 * The interleaving below is the exact one: A and B are pending, storage
 * publishes a second version of B — new checksum, new SQL, same path — the
 * moment A's tracking row lands, and the assertion is that the old SQL never
 * executes under the new identity. It runs on both commit models, because the
 * defect is in the entry-to-artifact binding and not in either program's
 * transaction discipline.
 */

import { apply } from "@migrations";
import type { MigrationClient } from "@migrations/push";
import type { MigrationEntry, MigrationJournal } from "@migrations/types";
import { s } from "@schema";
import { describe, expect, it } from "vitest";
import {
  MemoryStorage,
  mysqlEstateDriver,
  pgEstateDriver,
  type RecordingDriver,
} from "./_estate";

// =============================================================================
// FIXTURES
// =============================================================================

const schema = {
  org: s.model({ id: s.string().id() }).map("ns_orgs"),
};

function clientFor(driver: RecordingDriver): MigrationClient {
  return { $driver: driver, $schema: schema };
}

function entry(idx: number, name: string, checksum: string): MigrationEntry {
  return {
    idx,
    version: "20240101000000",
    name,
    when: 1,
    checksum,
    mode: "generated",
    rollback: { kind: "automatic" },
  };
}

/** The entry that commits first, and so opens the window. */
const A = entry(0, "a", "a-1");
/** B as the preflight sees it. */
const B_OLD = entry(1, "b", "b-old");
/** B as the post-commit reread sees it: same path, new tracking identity. */
const B_NEW = entry(1, "b", "b-new");

/** One artifact set per dialect, in that dialect's own spelling. */
interface Artifacts {
  readonly a: string;
  readonly bOld: string;
  readonly bNew: string;
}

const MYSQL_ARTIFACTS: Artifacts = {
  a: "CREATE TABLE `a` (id INT);",
  bOld: "CREATE TABLE `b_old` (id INT);",
  bNew: "CREATE TABLE `b_new` (id INT);",
};

const PG_ARTIFACTS: Artifacts = {
  a: 'CREATE TABLE "a" (id int);',
  bOld: 'CREATE TABLE "b_old" (id int);',
  bNew: 'CREATE TABLE "b_new" (id int);',
};

function journalFor(
  dialect: "mysql" | "postgresql",
  entries: readonly MigrationEntry[]
): MigrationJournal {
  return {
    version: "3",
    target:
      dialect === "mysql"
        ? { dialect: "mysql" }
        : { dialect: "postgresql", namespace: "alpha" },
    entries: [...entries],
  };
}

/** The artifact path storage serves an entry from, as the entry names it. */
function artifactPath(migrationEntry: MigrationEntry): string {
  return `${String(migrationEntry.idx).padStart(4, "0")}_${migrationEntry.name}.sql`;
}

/**
 * Publish one whole version of the estate: its journal and every artifact.
 *
 * Both versions of B write the SAME path, which is the point — an artifact is
 * addressed by `(idx, name)` and a republished entry keeps both.
 */
async function publish(
  storage: MemoryStorage,
  journal: MigrationJournal,
  artifacts: ReadonlyMap<string, string>
): Promise<void> {
  await storage.writeJournal(journal);
  for (const journalEntry of journal.entries) {
    const sql = artifacts.get(journalEntry.name);
    if (sql !== undefined) {
      await storage.writeMigration(journalEntry, sql);
    }
  }
}

/**
 * Storage serving version one, with version two captured and ready to replace
 * it — which is what a concurrent writer does between two of this command's
 * commits.
 *
 * Version two is published FIRST and its bytes captured, so the replacement is
 * the storage driver's own rendering of that version rather than a second
 * spelling of it invented here.
 */
async function interleavedStorage(
  dialect: "mysql" | "postgresql",
  artifacts: Artifacts
): Promise<{ storage: MemoryStorage; republish: () => void }> {
  const storage = new MemoryStorage();

  await publish(
    storage,
    journalFor(dialect, [A, B_NEW]),
    new Map([
      [A.name, artifacts.a],
      [B_NEW.name, artifacts.bNew],
    ])
  );
  const version2 = new Map(storage.files);

  await publish(
    storage,
    journalFor(dialect, [A, B_OLD]),
    new Map([
      [A.name, artifacts.a],
      [B_OLD.name, artifacts.bOld],
    ])
  );
  storage.writes.length = 0;
  storage.reads.length = 0;

  return {
    storage,
    republish: () => {
      for (const [path, content] of version2) {
        storage.files.set(path, content);
      }
    },
  };
}

/**
 * The estate an interleaved apply runs against.
 *
 * `tracked` is the tracking table: the command writes it, rereads it to choose
 * the next entry, and it is where a recorded identity can be read back and
 * compared with the SQL that actually ran.
 */
interface InterleavedEstate {
  readonly driver: RecordingDriver;
  readonly storage: MemoryStorage;
  /** Migration name to the checksum the tracking table holds for it. */
  readonly tracked: Map<string, string>;
}

async function interleavedEstate(
  dialect: "mysql" | "postgresql",
  artifacts: Artifacts,
  options: { readonly republishAfterA: boolean }
): Promise<InterleavedEstate> {
  const { storage, republish } = await interleavedStorage(dialect, artifacts);
  const driver =
    dialect === "mysql"
      ? mysqlEstateDriver({ namespace: "alpha", attested: true })
      : pgEstateDriver("alpha");
  const tracked = new Map<string, string>();

  driver.respond = (sql: string, params: unknown[]): unknown[] => {
    // A MySQL pinned migration session PROVES its `sql_mode` before any DDL
    // (plan 3.3 / `migrations/pinned-session.ts`).
    if (sql.includes("@@SESSION.sql_mode")) {
      return [
        {
          sql_mode: "STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION",
          server_version: "8.4.0",
        },
      ];
    }
    if (sql.includes("pg_namespace")) {
      return [{ present: 1 }];
    }
    if (sql.includes("SCHEMATA")) {
      return [{ SCHEMA_NAME: "alpha" }];
    }
    if (sql.includes("SELECT name, checksum, applied_at")) {
      return [...tracked].map(([name, checksum]) => ({
        name,
        checksum,
        applied_at: 1,
      }));
    }
    if (sql.startsWith("INSERT INTO")) {
      const name = String(params[0]);
      tracked.set(name, String(params[1]));
      // A's history row is durable now, which is exactly the moment another
      // writer's second version of B becomes visible to this command.
      if (options.republishAfterA && name === A.name) {
        republish();
      }
      return [];
    }
    return [];
  };

  return { driver, storage, tracked };
}

// =============================================================================
// A REPUBLISHED ENTRY IS A DIFFERENT ENTRY
// =============================================================================

function runInterleavingFalsifier(
  label: string,
  dialect: "mysql" | "postgresql",
  artifacts: Artifacts
): void {
  it(`${label} never executes the superseded artifact`, async () => {
    const { driver, storage, tracked } = await interleavedEstate(
      dialect,
      artifacts,
      { republishAfterA: true }
    );

    const result = await apply(clientFor(driver), { storageDriver: storage });

    expect(result.applied.map((e) => e.name)).toEqual([A.name, B_NEW.name]);
    // The three facts of the interleaving, together: which SQL ran, and which
    // identity the estate now records for it. Recording `b-new` while running
    // `b_old` is the defect; the entry the reread chose owns both or neither.
    const oldRan = driver.statements.includes(artifacts.bOld);
    const newRan = driver.statements.includes(artifacts.bNew);
    expect({ oldRan, newRan, tracked: tracked.get(B_NEW.name) }).toEqual({
      oldRan: false,
      newRan: true,
      tracked: B_NEW.checksum,
    });
    // A is the control: its entry never changed, so its artifact and its
    // tracking row still agree.
    expect(driver.statements).toContain(artifacts.a);
    expect(tracked.get(A.name)).toBe(A.checksum);
  });

  it(`${label} answers an unchanged entry from the preflight`, async () => {
    // The other half of the same binding, and the reason it is a binding rather
    // than an unconditional reread: rereading every artifact inside the durable
    // program would also never run stale SQL, and would move every artifact
    // read after the first effect — which is precisely what the preflight
    // exists to prevent. An entry whose facts did not change is read once.
    const { driver, storage, tracked } = await interleavedEstate(
      dialect,
      artifacts,
      { republishAfterA: false }
    );

    await apply(clientFor(driver), { storageDriver: storage });

    expect(driver.statements).toContain(artifacts.bOld);
    expect(tracked.get(B_OLD.name)).toBe(B_OLD.checksum);
    const bReads = storage.reads.filter((path) => path === artifactPath(B_OLD));
    expect(bReads).toHaveLength(1);
  });
}

describe("apply() binds each artifact to the entry it records", () => {
  runInterleavingFalsifier(
    "the transactional program",
    "postgresql",
    PG_ARTIFACTS
  );
  runInterleavingFalsifier(
    "the MySQL sequential program",
    "mysql",
    MYSQL_ARTIFACTS
  );
});
