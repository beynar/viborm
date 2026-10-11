/**
 * S13: `generate` puts drops and type changes to the resolve callback exactly
 * as push does, saves the approval in the published state, and `show()`
 * displays it. `apply` then runs the approved state without asking again.
 *
 * 1.1.0 published (and applied) a dropColumn, a dropTable and a type change
 * without ever calling the callback, even with `rejectAllResolver`.
 */

import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { s } from "@schema";
import { VibORMErrorCode } from "@src/errors";
import { createMigrationClient } from "@src/migrations/client";
import { utf8Bytes } from "@src/migrations/identity";
import { rejectAllResolver } from "@src/migrations/resolver";
import { composeSqlBlob } from "@src/migrations/sql-blob";
import { MemoryEstateStorage } from "@src/migrations/storage/memory";
import type { ResolveCallback, ResolveChange } from "@src/migrations/types";
import {
  encodeDispatchIdentity,
  encodeStateManifest,
  encodeTransitionHash,
  parseStateManifest,
} from "@src/migrations/v1-parse";
import type { MigrationParentTransitionV1 } from "@src/migrations/v1-types";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

const ROWS = 10_000;

const accountFields = {
  id: s.string().id(),
  email: s.string().unique(),
  name: s.string(),
  handle: s.string(),
  country: s.string(),
  city: s.string().nullable(),
  phone: s.string().nullable(),
  score: s.int(),
  balance: s.int().default(0),
  visits: s.int().default(0),
  active: s.boolean().default(true),
  verified: s.boolean().default(false),
  notes: s.string().nullable(),
  settings: s.json().nullable(),
};
const legacyAccount = s.model({
  ...accountFields,
  legacyCode: s.string().nullable(),
});
const audit = s.model({ id: s.string().id(), note: s.string() });
const { score: _score, ...unscored } = accountFields;
const nextAccount = s.model({ ...unscored, score: s.string() });

const proceed: ResolveCallback = (change) =>
  change.type === "destructive" ? change.proceed() : undefined;

function asked(log: string[]): ResolveCallback {
  return (change: ResolveChange) => {
    if (change.type === "destructive")
      log.push(`${change.operation}:${change.table}.${change.column ?? ""}`);
    return proceed(change);
  };
}

/** One database at ten thousand rows, migrated to the 1.1.0 shape. */
async function seededEstate() {
  const database = new Database(":memory:");
  const storage = new MemoryEstateStorage();
  const first = createClient({
    schema: { account: legacyAccount, audit },
    driver: new SQLite3Driver({ client: database }),
  });
  const seeding = createMigrationClient(first, { storage });
  await seeding.generate({ name: "base" });
  await seeding.apply();
  const insert = database.prepare(
    'INSERT INTO "account" ("id", "email", "name", "handle", "country", "score", "legacyCode") VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  database.transaction(() => {
    for (let index = 0; index < ROWS; index++) {
      insert.run(
        `a${index}`,
        `a${index}@example.test`,
        `Name ${index}`,
        `h${index}`,
        "FR",
        index,
        `L${index}`
      );
    }
  })();
  const next = createClient({
    schema: { account: nextAccount },
    driver: new SQLite3Driver({ client: database }),
  });
  return {
    database,
    storage,
    migrations: createMigrationClient(next, { storage }),
    close: async () => {
      await first.$disconnect();
      await next.$disconnect();
      database.close();
    },
  };
}

describe("generate asks before destructive changes", () => {
  test("rejectAllResolver refuses the drop and publishes nothing", async () => {
    const estate = await seededEstate();
    const before = await estate.migrations.list();
    await expect(
      estate.migrations.generate({ name: "drop", resolve: rejectAllResolver })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED,
    });
    expect(await estate.migrations.list()).toEqual(before);
    await estate.close();
  });

  test("no resolver refuses with consent required and names every change", async () => {
    const estate = await seededEstate();
    const before = await estate.migrations.list();
    const refusal = await estate.migrations
      .generate({ name: "drop" })
      .catch((error: unknown) => error);
    expect(refusal).toMatchObject({
      code: VibORMErrorCode.MIGRATION_CONSENT_REQUIRED,
      meta: { hint: expect.stringContaining("migrations.resolve") },
    });
    const { message } = refusal as Error;
    expect(message).toContain('Drop column "legacyCode" from table "account"');
    expect(message).toContain('Drop table "audit"');
    expect(message).toContain('Change type of "account"."score"');
    expect(await estate.migrations.list()).toEqual(before);
    await estate.close();
  });

  test("an allowing resolver is asked once per change, the approval is shown, and apply runs it", async () => {
    const estate = await seededEstate();
    const log: string[] = [];
    const preview = await estate.migrations.generate({
      name: "drop",
      dryRun: true,
    });
    const generated = await estate.migrations.generate({
      name: "drop",
      resolve: asked(log),
    });
    expect(log.sort()).toEqual([
      "alterColumn:account.score",
      "dropColumn:account.legacyCode",
      "dropTable:audit.",
    ]);
    expect(generated.outcome).toBe("published");
    // A dry run without a resolver previews the state an approval publishes.
    expect(preview.stateId).toBe(generated.stateId);
    // ...but its review does not claim an approval nobody gave.
    expect(preview.reviewSql).toContain(
      "-- Needs approval at generate: dropColumn account.legacyCode"
    );
    expect(preview.reviewSql).not.toContain("Approved at generate");

    const shown = await estate.migrations.show({ id: generated.stateId! });
    expect(shown.incoming).toHaveLength(1);
    expect(
      [...shown.incoming[0]!.approvals].sort((left, right) =>
        left.operation.localeCompare(right.operation)
      )
    ).toEqual([
      { operation: "alterColumn", table: "account", column: "score" },
      { operation: "dropColumn", table: "account", column: "legacyCode" },
      { operation: "dropTable", table: "audit", column: null },
    ]);
    expect(generated.reviewSql).toContain(
      "-- Approved at generate: dropColumn account.legacyCode"
    );

    await expect(estate.migrations.apply()).resolves.toMatchObject({
      outcome: "applied",
    });
    expect(
      estate.database
        .prepare(
          'SELECT COUNT(*) AS n, MIN("email") AS first FROM "account" WHERE "score" IS NOT NULL'
        )
        .get()
    ).toEqual({ n: ROWS, first: "a0@example.test" });
    await estate.close();
  });

  test("an addAndDrop answer approves its drop without asking again", async () => {
    const database = new Database(":memory:");
    const storage = new MemoryEstateStorage();
    const before = s.model({ id: s.string().id(), oldCode: s.string() });
    const after = s.model({ id: s.string().id(), newCode: s.string() });
    const open = (model: typeof before | typeof after) =>
      createClient({
        schema: { item: model },
        driver: new SQLite3Driver({ client: database }),
      });
    await createMigrationClient(open(before), { storage }).generate({
      name: "base",
    });
    const log: string[] = [];
    const generated = await createMigrationClient(open(after), {
      storage,
    }).generate({
      name: "swap",
      resolve: (change) => {
        if (change.type === "enumValueRemoval") return;
        log.push(`${change.type}:${change.operation}`);
        return change.type === "ambiguous"
          ? change.addAndDrop()
          : change.proceed();
      },
    });
    expect(log).toEqual(["ambiguous:renameColumn", "destructive:addColumn"]);
    const shown = await createMigrationClient(open(after), { storage }).show({
      id: generated.stateId!,
    });
    expect(
      [...shown.incoming[0]!.approvals].sort((left, right) =>
        left.operation.localeCompare(right.operation)
      )
    ).toEqual([
      { operation: "addColumn", table: "item", column: "newCode" },
      { operation: "dropColumn", table: "item", column: "oldCode" },
    ]);
    database.close();
  });

  test("a state without destructive changes carries no approval", async () => {
    const storage = new MemoryEstateStorage();
    const client = createClient({
      schema: { audit },
      driver: new SQLite3Driver({ client: new Database(":memory:") }),
    });
    const migrations = createMigrationClient(client, { storage });
    const generated = await migrations.generate({ name: "base" });
    const bytes = await storage.readState(generated.stateId!);
    expect(new TextDecoder().decode(bytes!)).not.toContain("approvals");
    const shown = await migrations.show({ id: generated.stateId! });
    expect(shown.incoming[0]!.approvals).toEqual([]);
    await client.$disconnect();
  });
});

describe("approval identity", () => {
  const blob = composeSqlBlob([
    'ALTER TABLE "account" DROP COLUMN "legacyCode"',
  ]);
  const execute = {
    dispatchId: encodeDispatchIdentity(blob.sqlHash, 0, blob.bytes.length, []),
    sqlHash: blob.sqlHash,
    offset: 0,
    length: blob.bytes.length,
    parameters: [],
  };
  const body: Omit<MigrationParentTransitionV1, "transitionHash"> = {
    fromState: null,
    originChecks: [],
    requestedForwardBoundary: null,
    operations: [
      {
        id: "op",
        label: "Drop column account.legacyCode",
        origin: "generated",
        risk: "destructive",
        steps: [{ retry: "opaque", execute }],
      },
    ],
    rollback: { kind: "irreversible", reason: "drop" },
  };
  const manifest = (
    parent: Omit<MigrationParentTransitionV1, "transitionHash">
  ) =>
    encodeStateManifest({
      format: "1",
      estateHash: "e".repeat(64),
      name: "drop",
      snapshotHash: "5".repeat(64),
      sqlHash: blob.sqlHash,
      destinationChecks: [],
      parents: [{ ...parent, transitionHash: encodeTransitionHash(parent) }],
    });

  test("a transition without approvals keeps the ids 1.1.0 gave it", () => {
    // Golden vectors computed by the 1.1.0 encoder before approvals existed.
    expect(encodeTransitionHash(body)).toBe(
      "d56a04963d90212d68ab3501e206209b1774d8f19791f381e7dd45b32f980e23"
    );
    expect(manifest(body).stateId).toBe(
      "e279d164de32d723a9abd1ccbd31afb609aae99ecf7e804d4984c8e9ad8b8cfb"
    );
  });

  test("approvals are part of the transition hash and survive the parser", () => {
    const approved = {
      ...body,
      approvals: [
        { operation: "dropColumn", table: "account", column: "legacyCode" },
      ] as const,
    };
    const encoded = manifest(approved);
    expect(encodeTransitionHash(approved)).not.toBe(encodeTransitionHash(body));
    expect(encoded.stateId).not.toBe(manifest(body).stateId);
    expect(
      parseStateManifest(encoded.bytes, encoded.stateId).parents[0]!.approvals
    ).toEqual(approved.approvals);

    const tampered = utf8Bytes(
      new TextDecoder()
        .decode(encoded.bytes)
        .replace('"legacyCode"', '"otherCode"')
    );
    expect(() => parseStateManifest(tampered, encoded.stateId)).toThrow(
      expect.objectContaining({ code: VibORMErrorCode.MIGRATION_CORRUPTION })
    );
  });

  test.each([
    [[], "must be a non-empty array"],
    [
      [{ operation: "renameTable", table: "account", column: null }],
      "is not a destructive operation",
    ],
    [[{ operation: "dropTable", table: "", column: null }], "table must be"],
    [[{ operation: "dropTable", table: "audit" }], "is missing column"],
  ])("the parser refuses approvals %j", (approvals, message) => {
    const encoded = manifest(body);
    const parsed = JSON.parse(new TextDecoder().decode(encoded.bytes));
    parsed.parents[0].approvals = approvals;
    expect(() =>
      parseStateManifest(utf8Bytes(JSON.stringify(parsed)), encoded.stateId)
    ).toThrow(message);
  });
});
