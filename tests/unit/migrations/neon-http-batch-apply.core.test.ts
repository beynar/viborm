/**
 * Plan D7 at the layer the migration coverage gate measures: on a PostgreSQL
 * transport with no session but an atomic batch that reports its commit
 * (Neon HTTP's shape), `apply()` sends each transactional group as ONE
 * request, and settles what that request did from the server's answer.
 *
 * The recording driver stands in for the server. It answers the reads the
 * command sends before the request (the control catalog, the D5 decision read,
 * the marker, the ledger, the drift proof's digest), and its batch hook records
 * each request and answers it: committed, refused with a SQLSTATE, or lost.
 * The same flows run against PostgreSQL semantics in
 * `neon-http-batch-apply-pglite.test.ts` and, one session per request, in
 * `neon-http-batch-apply-docker.test.ts`.
 */

import { createClient } from "@client/client";
import type {
  BatchQuery,
  CommittedBatchNotification,
  QueryResult,
} from "@drivers/types";
import { VibORMErrorCode } from "@errors";
import { createMigrationClient } from "@migrations";
import { canonicalizeJsonText } from "@migrations/canonical-json";
import { markerFromPath } from "@migrations/control";
import { loadMigrationGraph, parentTransition } from "@migrations/graph";
import type { Sha256 } from "@migrations/identity";
import { fingerprintLive } from "@migrations/push-fingerprint";
import type { MigrationMarkerV1 } from "@migrations/v1-types";
import { s } from "@schema";
import { sql } from "@sql";
import { getPushMigrationDriver } from "@src/migrations/push/planner";
import { nekiRefusals } from "@tests/fixtures/sql-shape";
import { describe, expect, it } from "vitest";
import {
  controlCatalogAnswer,
  MemoryStorage,
  pgEstateDriver,
  postgresControlCatalogAnswer,
  RecordingDriver,
} from "./_estate";

const DECISION = /AS digest WHERE pg_try_advisory_xact_lock\(/;
const CONTROL_CATALOG = "AS control(position, name)";
const LOCKED_DIGEST = "END AS digest\nFROM projection";
const XACT_LOCK = /pg_try_advisory_xact_lock/;
const DIGEST = /END AS digest/;
const DDL = /^\s*(ALTER TABLE|CREATE (UNIQUE )?INDEX|CREATE TABLE)/i;
const MARKER_WRITE =
  /^(UPDATE|INSERT INTO) "public"\."_viborm_migration_state"/;

const fields = () => ({
  id: s.string().id(),
  email: s.string().unique(),
});
const v1 = { account: s.model(fields()).map("accounts") };
const v2 = {
  account: s
    .model({ ...fields(), nickname: s.string().nullable() })
    .map("accounts"),
};

type Reply =
  | "commit"
  /** The server committed, and the reply was lost on the way back. */
  | "lost-after-commit"
  /** The request never reached the server. */
  | "lost"
  /** The server refused a statement, with this SQLSTATE, and rolled back. */
  | { readonly sqlState: string };

/**
 * Neon HTTP's shape on a recording driver: a native atomic batch that
 * reports its commit, and no session to pin (the hook is absent, which is
 * what `canPinSession` reads).
 */
class BatchOnlyDriver extends RecordingDriver {
  override readonly supportsBatch = true;
  override readonly supportsOrderedCommittedSegments = true;
  readonly requests: string[][] = [];
  reply: Reply = "commit";
  /** What the decision read finds once a request was sent. */
  afterRequest: Partial<Database> = {};

  constructor() {
    const { adapter } = pgEstateDriver("public");
    super("postgresql", "neon-http", adapter);
    Object.defineProperty(this, "pinnedSession", { value: undefined });
  }

  protected override async executeBatch<T>(
    _client: unknown,
    queries: BatchQuery[],
    _context?: unknown,
    committed?: CommittedBatchNotification
  ): Promise<QueryResult<T>[]> {
    this.requests.push(queries.map((query) => query.sql));
    const { reply } = this;
    if (reply === "lost") throw new TypeError("fetch failed");
    if (typeof reply === "object") {
      throw Object.assign(new Error("refused"), { code: reply.sqlState });
    }
    await committed?.();
    if (reply === "lost-after-commit") throw new TypeError("fetch failed");
    return queries.map(() => ({ rows: [], rowCount: 0 }));
  }
}

/** The state a `generate` published. */
function published({ stateId }: { readonly stateId: string | null }): Sha256 {
  if (stateId === null) throw new Error("generate published no state");
  return stateId as Sha256;
}

/** An estate at v1 with a v2 change, and what a database at each holds. */
async function estate() {
  const storage = new MemoryStorage();
  const generator = pgEstateDriver("public");
  const migrations = (schema: typeof v1 | typeof v2) =>
    createMigrationClient(createClient({ driver: generator, schema }), {
      storage,
    });
  const root = published(await migrations(v1).generate({ name: "v1" }));
  const target = published(await migrations(v2).generate({ name: "v2" }));
  const graph = await loadMigrationGraph(storage);
  const edge = (from: Sha256 | null, to: Sha256) => ({
    stateId: to,
    transitionHash: parentTransition(graph, from, to).transitionHash,
    baselineBoundary: false,
  });
  const snapshotOf = (id: Sha256) => graph.states.get(id)!.snapshotHash;
  const atRoot = markerFromPath(
    graph.estateHash,
    snapshotOf(root),
    [edge(null, root)],
    1
  );
  const atTarget = markerFromPath(
    graph.estateHash,
    snapshotOf(target),
    [edge(null, root), edge(root, target)],
    2
  );
  const digest = await fingerprintLive(
    graph.snapshots.get(snapshotOf(root))!,
    getPushMigrationDriver(createClient({ driver: generator, schema: v1 })),
    generator
  );
  return { storage, root, target, atRoot, atTarget, digest };
}

/** One JSON aggregate of `{ payload }` rows, or SQL NULL for none. */
function payloadAggregate(
  marker: MigrationMarkerV1 | null | undefined
): string | null {
  return marker
    ? JSON.stringify([{ payload: canonicalizeJsonText(marker) }])
    : null;
}

interface Database {
  /** The marker the database holds; `undefined` is no control tables. */
  marker: MigrationMarkerV1 | null | undefined;
  readonly digest: Sha256 | null;
  /** The D5 decision read finds the lock taken by another command. */
  lockHeld?: boolean;
}

function driverOver(database: Database): BatchOnlyDriver {
  const driver = new BatchOnlyDriver();
  driver.respond = (text, params) => {
    // The bootstrap creates the pair before the first request.
    if (
      text.startsWith(
        'CREATE TABLE IF NOT EXISTS "public"."_viborm_migration_log"'
      )
    ) {
      database.marker ??= null;
    }
    const present = database.marker !== undefined;
    if (text.startsWith("SELECT EXISTS")) {
      return (
        controlCatalogAnswer(text, params, { state: present, log: present }) ??
        []
      );
    }
    if (text.startsWith("SELECT 1 AS present FROM pg_catalog.pg_namespace")) {
      return [{ present: 1 }];
    }
    if (text.includes(CONTROL_CATALOG)) {
      return (
        postgresControlCatalogAnswer(text, {
          state: present,
          log: present,
          check: "CHECK ((singleton = 1))",
        }) ?? []
      );
    }
    if (DECISION.test(text)) {
      const seen =
        driver.requests.length > 0
          ? { ...database, ...driver.afterRequest }
          : database;
      if (seen.lockHeld) return [];
      return [
        {
          marker: payloadAggregate(seen.marker),
          ledger: null,
          digest: seen.digest,
        },
      ];
    }
    if (text.startsWith("SELECT payload FROM") && text.includes("_state")) {
      return database.marker
        ? [{ payload: canonicalizeJsonText(database.marker) }]
        : [];
    }
    if (text.includes(LOCKED_DIGEST)) return [{ digest: database.digest }];
    return [];
  };
  return driver;
}

/** `generate` is offline: any driver of the dialect publishes the same state. */
function offline(storage: MemoryStorage) {
  return createMigrationClient(
    createClient({ driver: pgEstateDriver("public"), schema: v2 }),
    { storage }
  );
}

function migrationsOver(
  driver: BatchOnlyDriver,
  storage: MemoryStorage,
  schema: typeof v1 | typeof v2 = v2
) {
  return createMigrationClient(createClient({ driver, schema }), { storage });
}

/** The requests that carried DDL. */
function ddlRequests(driver: BatchOnlyDriver): string[][] {
  return driver.requests.filter((request) =>
    request.some((text) => DDL.test(text))
  );
}

describe("apply over a sessionless batch transport (plan D7)", () => {
  it("sends the lock, the marker assertion, the DDL, the digest and the marker move as one request", async () => {
    const { storage, target, atRoot, digest } = await estate();
    const driver = driverOver({ marker: atRoot, digest });

    await expect(
      migrationsOver(driver, storage).apply({ to: { id: target } })
    ).resolves.toMatchObject({ outcome: "applied" });

    const requests = ddlRequests(driver);
    expect(requests).toHaveLength(1);
    const [request = []] = requests;
    const at = (pattern: RegExp) =>
      request.findIndex((text) => pattern.test(text));
    expect(at(XACT_LOCK)).toBeLessThan(at(DDL));
    expect(at(DDL)).toBeLessThan(at(MARKER_WRITE));
    expect(at(DIGEST)).toBeLessThan(at(MARKER_WRITE));
    expect(
      request.some((text) => text.includes('"_viborm_migration_log"'))
    ).toBe(true);
    expect(nekiRefusals(request)).toEqual([]);
    // Nothing that moves the marker goes out alone.
    expect(driver.statements.some((text) => MARKER_WRITE.test(text))).toBe(
      false
    );
  });

  it("creates missing control tables first, then applies the first state in one request", async () => {
    const { storage, root } = await estate();
    const driver = driverOver({ marker: undefined, digest: null });

    await expect(
      migrationsOver(driver, storage, v1).apply({ to: { id: root } })
    ).resolves.toMatchObject({ outcome: "applied" });

    expect(
      driver.statements.filter((text) =>
        text.startsWith("CREATE TABLE IF NOT EXISTS")
      )
    ).toHaveLength(2);
    expect(ddlRequests(driver)).toHaveLength(1);
    expect(
      ddlRequests(driver)[0]?.some((text) =>
        text.startsWith('INSERT INTO "public"."_viborm_migration_state"')
      )
    ).toBe(true);
  });

  it.each([
    ["P0V00", VibORMErrorCode.MIGRATION_LOCK_FAILED],
    ["P0V01", VibORMErrorCode.MIGRATION_MARKER_CONFLICT],
    ["42601", VibORMErrorCode.MIGRATION_FAILED],
  ])("maps a request the server refused with %s to its refusal", async (sqlState, code) => {
    const { storage, target, atRoot, digest } = await estate();
    const driver = driverOver({ marker: atRoot, digest });
    driver.reply = { sqlState };

    await expect(
      migrationsOver(driver, storage).apply({ to: { id: target } })
    ).rejects.toMatchObject({ code });
  });

  it("reports applied when the reply is lost after the commit was acknowledged", async () => {
    const { storage, target, atRoot, digest } = await estate();
    const driver = driverOver({ marker: atRoot, digest });
    driver.reply = "lost-after-commit";

    await expect(
      migrationsOver(driver, storage).apply({ to: { id: target } })
    ).resolves.toMatchObject({ outcome: "applied" });
  });

  it("settles a lost reply from the marker, read while no command holds the lock", async () => {
    const { storage, target, atRoot, atTarget, digest } = await estate();

    // The request committed: the marker the settling read finds is the target.
    const landed = driverOver({ marker: atRoot, digest });
    landed.reply = "lost";
    landed.afterRequest = { marker: atTarget };
    await expect(
      migrationsOver(landed, storage).apply({ to: { id: target } })
    ).resolves.toMatchObject({ outcome: "applied" });

    // It did not: the marker is still the origin, so the attempt is failed.
    const lost = driverOver({ marker: atRoot, digest });
    lost.reply = "lost";
    const failure = await migrationsOver(lost, storage)
      .apply({ to: { id: target } })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toMatchObject({
      code: VibORMErrorCode.MIGRATION_AMBIGUOUS_COMMIT,
    });
    expect(
      lost.statements.some((text) =>
        text.startsWith('INSERT INTO "public"."_viborm_migration_log"')
      )
    ).toBe(true);
  });

  it("reports V11020 for a lost reply while the lock is held, as the request may still run", async () => {
    const { storage, target, atRoot, digest } = await estate();
    const driver = driverOver({ marker: atRoot, digest });
    driver.reply = "lost";
    driver.afterRequest = { lockHeld: true };

    await expect(
      migrationsOver(driver, storage).apply({ to: { id: target } })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_AMBIGUOUS_COMMIT,
    });
  });

  it("asserts a manual transition's checks inside the request", async () => {
    const { storage, root, atRoot, digest } = await estate();
    const driver = driverOver({ marker: atRoot, digest });
    const manual = published(
      await offline(storage).generate({
        name: "manual",
        manualMigration: {
          transitions: [
            {
              from: root,
              execution: "transactional",
              originChecks: [
                {
                  kind: "trusted-read",
                  query: sql.raw("SELECT true"),
                  equals: true,
                },
              ],
              up: [
                sql.raw(
                  'ALTER TABLE "public"."accounts" ADD COLUMN "nickname" TEXT'
                ),
              ],
              rollback: { kind: "irreversible", reason: "test transition" },
            },
          ],
          destinationChecks: [
            {
              kind: "trusted-read",
              query: sql.raw("SELECT false"),
              equals: false,
            },
          ],
        },
      })
    );

    await expect(
      migrationsOver(driver, storage).apply({ to: { id: manual } })
    ).resolves.toMatchObject({ outcome: "applied" });
    const [request = []] = ddlRequests(driver);
    expect(
      request.filter((text) => text.includes("AS one(value)"))
    ).toHaveLength(2);
    expect(nekiRefusals(request)).toEqual([]);
  });

  it("refuses a stepwise transition before any request carries DDL", async () => {
    const { storage, root, atRoot, digest } = await estate();
    const driver = driverOver({ marker: atRoot, digest });
    const holds = {
      kind: "trusted-read" as const,
      query: sql.raw("SELECT true"),
      equals: true,
    };
    const stepwise = published(
      await offline(storage).generate({
        name: "stepwise",
        manualMigration: {
          transitions: [
            {
              from: root,
              execution: "stepwise",
              originChecks: [holds],
              up: [
                sql.raw(
                  'ALTER TABLE "public"."accounts" ADD COLUMN "nickname" TEXT'
                ),
              ],
              rollback: { kind: "irreversible", reason: "test transition" },
            },
          ],
          destinationChecks: [holds],
        },
      })
    );

    await expect(
      migrationsOver(driver, storage).apply({ to: { id: stepwise } })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_UNSUPPORTED_PROVIDER,
    });
    expect(driver.requests).toHaveLength(0);
  });
});
