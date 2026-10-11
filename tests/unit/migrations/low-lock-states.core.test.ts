/**
 * T5b at generate: asked with `lowLock: true`, a PostgreSQL change that builds
 * an index on, or adds a foreign key to, a table the migration does not create
 * is published as
 * states whose commits each do one low-lock thing — every build its own
 * `CREATE INDEX CONCURRENTLY` state, the keys added `NOT VALID`, then
 * validated by a state of their own. Everything else keeps today's one
 * transactional state.
 */

import { createClient } from "@client/client";
import type { Schema } from "@client/types";
import { createMigrationClient } from "@migrations";
import {
  classifyStoredAtomicity,
  groupContiguousAtomicity,
  lowLockStates,
  stepStatements,
} from "@migrations/compile";
import { emptyManagedSnapshot } from "@migrations/empty-snapshot";
import { normalizeGenerateOptions } from "@migrations/generate-input";
import { loadMigrationGraph, parentTransition } from "@migrations/graph";
import type { DiffOperation, SchemaSnapshot } from "@migrations/types";
import { s } from "@schema";
import { getPushMigrationDriver } from "@src/migrations/push/planner";
import { describe, expect, it, vi } from "vitest";
import { MemoryStorage, pgEstateDriver } from "./_estate";

// Fails the last state's compile on demand, after the steps before it seal.
const lastStateCompile = vi.hoisted(() => ({ fails: false }));
vi.mock("@migrations/compile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@migrations/compile")>();
  return {
    ...actual,
    compileValidationTransition: (
      ...args: Parameters<typeof actual.compileValidationTransition>
    ) => {
      if (lastStateCompile.fails) throw new Error("last state failed");
      return actual.compileValidationTransition(...args);
    },
  };
});

const NICKNAME = /ADD COLUMN "nickname"/;
const V2 = /^v2\b/;
const TEAMS = /CREATE TABLE "public"."teams"/;
const LOW_LOCK = /CONCURRENTLY|NOT VALID|VALIDATE/;
const STEP_FORM = /CONCURRENTLY|NOT VALID/;
const ORG_BUILD = /^CREATE INDEX CONCURRENTLY "accounts_orgId_idx"/;
const ADDED_THEN_VALIDATED = /NOT VALID[\s\S]*VALIDATE CONSTRAINT/;

const fields = () => ({
  id: s.string().id(),
  email: s.string().unique(),
  country: s.string(),
  orgId: s.string().nullable(),
});

/**
 * `orgs` and `accounts`. `.index` needs a model of one fixed shape, so an
 * indexed `accounts` is either bare or carries every other change too.
 */
function schemaWith(options: {
  linked?: boolean;
  indexed?: boolean;
  nickname?: boolean;
  team?: boolean;
}): Schema {
  const org = s
    .model({
      id: s.string().id(),
      ...(options.linked ? { accounts: s.toMany(() => account) } : {}),
      ...(options.team ? { teams: s.toMany(() => team) } : {}),
    })
    .map("orgs");
  const relation = () =>
    s
      .toOne(() => org)
      .fields("orgId")
      .references("id");
  const model = s.model({
    ...fields(),
    ...(options.nickname ? { nickname: s.string().nullable() } : {}),
    ...(options.linked ? { org: relation() } : {}),
  });
  const account = (() => {
    if (!options.indexed) return model;
    if (!options.linked) return s.model(fields()).index(["country"]);
    return s
      .model({
        ...fields(),
        nickname: s.string().nullable(),
        org: relation(),
      })
      .index(["country"]);
  })().map("accounts");
  const team = s
    .model({
      id: s.string().id(),
      orgId: s.string(),
      org: relation(),
    })
    .map("teams");
  return options.team ? { org, account, team } : { org, account };
}

async function generated(
  options: Parameters<typeof schemaWith>[0],
  lowLock = true,
  /** `null` generates without a name. */
  name: string | null = "v2"
) {
  const storage = new MemoryStorage();
  const migrationsFor = (shape: Parameters<typeof schemaWith>[0]) => {
    const client = createClient({
      schema: schemaWith(shape),
      driver: pgEstateDriver("public"),
    });
    return {
      client,
      migrations: createMigrationClient(client, { storage }),
    };
  };
  const root = await migrationsFor({}).migrations.generate({ name: "v1" });
  const { client, migrations } = migrationsFor(options);
  const result = await migrations.generate({
    ...(name === null ? {} : { name }),
    lowLock,
  });
  const graph = await loadMigrationGraph(storage);
  const driver = getPushMigrationDriver(client);
  // The states from v1 to v2, in order, with what each one runs.
  const states: {
    name: string;
    boundary: "transactional" | "stepwise";
    statements: string[];
    rollback: string[];
    snapshotHash: string;
  }[] = [];
  let to = result.stateId!;
  while (to !== root.stateId) {
    const state = graph.states.get(to)!;
    const transition = parentTransition(graph, state.parents[0]!.fromState, to);
    const blob = graph.sql.get(state.sqlHash)!;
    states.unshift({
      name: state.name,
      boundary: classifyStoredAtomicity(
        driver,
        transition.requestedForwardBoundary,
        transition.operations,
        blob
      ),
      statements: stepStatements(blob, transition.operations),
      rollback:
        transition.rollback.kind === "irreversible"
          ? []
          : stepStatements(blob, transition.rollback.operations),
      snapshotHash: state.snapshotHash,
    });
    to = state.parents[0]!.fromState!;
  }
  return { result, states };
}

describe("a generated PostgreSQL change on tables that hold rows", () => {
  it("is split into one state per index build, then the keys NOT VALID, then their validation", async () => {
    const { result, states } = await generated({
      linked: true,
      indexed: true,
      nickname: true,
      team: true,
    });
    expect(states.map(({ name, boundary }) => [name, boundary])).toEqual([
      ["v2 (step 1 of 5)", "transactional"],
      ["v2 (step 2 of 5)", "stepwise"],
      ["v2 (step 3 of 5)", "stepwise"],
      ["v2 (step 4 of 5)", "transactional"],
      ["v2", "transactional"],
    ]);
    const [plain, country, orgId, keys, validation] = states;
    // The column and the new table (whose key needs no step: it is empty).
    expect(plain!.statements.join("\n")).toMatch(NICKNAME);
    expect(plain!.statements.join("\n")).toMatch(TEAMS);
    expect(plain!.statements.join("\n")).not.toMatch(STEP_FORM);
    expect(country!.statements).toEqual([
      'CREATE INDEX CONCURRENTLY "accounts_country_idx" ON "public"."accounts" ("country")',
    ]);
    expect(country!.rollback).toEqual([
      'DROP INDEX "public"."accounts_country_idx"',
    ]);
    expect(orgId!.statements).toHaveLength(1);
    expect(orgId!.statements[0]).toMatch(ORG_BUILD);
    expect(keys!.statements).toEqual([
      'ALTER TABLE "public"."accounts" ADD CONSTRAINT "accounts_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "public"."orgs" ("id") ON DELETE SET NULL ON UPDATE NO ACTION NOT VALID',
    ]);
    expect(validation!.statements).toEqual([
      'ALTER TABLE "public"."accounts" VALIDATE CONSTRAINT "accounts_orgId_fkey"',
    ]);
    // Undoing a validation is nothing: the key its parent added stays.
    expect(validation!.rollback).toEqual([]);
    expect(validation!.snapshotHash).toBe(keys!.snapshotHash);
    expect(validation!.snapshotHash).toBe(result.snapshotHash);
    expect(new Set(states.map(({ snapshotHash }) => snapshotHash)).size).toBe(
      4
    );
    // The review shows every state the call published.
    expect(result.reviewSql.match(/VibORM review/g)).toHaveLength(5);
  });

  it("names the steps after the generated name when none is given", async () => {
    const { states } = await generated(
      { linked: true, indexed: true, nickname: true, team: true },
      true,
      null
    );
    const final = states.at(-1)!.name;
    expect(final).not.toMatch(V2);
    expect(states.map(({ name }) => name)).toEqual([
      `${final} (step 1 of 5)`,
      `${final} (step 2 of 5)`,
      `${final} (step 3 of 5)`,
      `${final} (step 4 of 5)`,
      final,
    ]);
  });

  it("keeps one state when a single build is the whole change", async () => {
    const { states } = await generated({ indexed: true });
    expect(states.map(({ name, boundary }) => [name, boundary])).toEqual([
      ["v2", "stepwise"],
    ]);
    expect(states[0]!.statements).toEqual([
      'CREATE INDEX CONCURRENTLY "accounts_country_idx" ON "public"."accounts" ("country")',
    ]);
  });

  it("refuses a lowLock that is not a boolean", () => {
    expect(() => normalizeGenerateOptions({ lowLock: "yes" })).toThrow(
      "generate lowLock must be a boolean"
    );
  });

  it("keeps today's one transactional state unless lowLock is asked for", async () => {
    const { states } = await generated(
      { linked: true, indexed: true, nickname: true },
      false
    );
    expect(states.map(({ name, boundary }) => [name, boundary])).toEqual([
      ["v2", "transactional"],
    ]);
    expect(states[0]!.statements.join("\n")).not.toMatch(LOW_LOCK);
  });

  it("keeps one transactional state with nothing to split", async () => {
    const { states } = await generated({ nickname: true, team: true });
    expect(states.map(({ name, boundary }) => [name, boundary])).toEqual([
      ["v2", "transactional"],
    ]);
    expect(states[0]!.statements.join("\n")).not.toMatch(LOW_LOCK);
  });

  it("previews the split without publishing it", async () => {
    const storage = new MemoryStorage();
    const migrationsFor = (shape: Parameters<typeof schemaWith>[0]) =>
      createMigrationClient(
        createClient({
          schema: schemaWith(shape),
          driver: pgEstateDriver("public"),
        }),
        { storage }
      );
    await migrationsFor({}).generate({ name: "v1" });
    const before = storage.writes.length;
    const preview = await migrationsFor({
      linked: true,
      nickname: true,
    }).generate({
      name: "v2",
      dryRun: true,
      lowLock: true,
    });
    expect(preview.outcome).toBe("preview");
    expect(storage.writes.length).toBe(before);
    expect(preview.sql).toMatch(ADDED_THEN_VALIDATED);
  });
});

describe("a generate({ lowLock: true }) that cannot or did not finish", () => {
  const migrationsFor = (
    storage: MemoryStorage,
    shape: Parameters<typeof schemaWith>[0]
  ) =>
    createMigrationClient(
      createClient({
        schema: schemaWith(shape),
        driver: pgEstateDriver("public"),
      }),
      { storage }
    );

  it("warns when an enum drop after the build keeps the blocking forms", async () => {
    const storage = new MemoryStorage();
    const tiered = s.model({
      ...fields(),
      tier: s.enum(["free", "paid"]).default("free"),
    });
    const client = (schema: Parameters<typeof createClient>[0]["schema"]) =>
      createMigrationClient(
        createClient({ schema, driver: pgEstateDriver("public") }),
        { storage }
      );
    await client({ account: tiered.map("accounts") }).generate({
      name: "v1",
    });
    const result = await client({
      account: s.model(fields()).index(["country"]).map("accounts"),
    }).generate({
      name: "v2",
      lowLock: true,
      resolve: (change) =>
        change.type === "destructive" ? change.proceed() : undefined,
    });
    expect(result.warnings).toContainEqual(
      expect.stringContaining("lowLock: this change keeps its blocking")
    );
    expect(result.sql).not.toMatch(LOW_LOCK);
    expect(await client({}).list()).toHaveLength(2);
  });

  it("publishes no step state when the last state fails to seal", async () => {
    const storage = new MemoryStorage();
    await migrationsFor(storage, {}).generate({ name: "v1" });
    const before = storage.writes.length;
    lastStateCompile.fails = true;
    try {
      await expect(
        migrationsFor(storage, {
          linked: true,
          indexed: true,
          nickname: true,
        }).generate({ name: "v2", lowLock: true })
      ).rejects.toThrow("last state failed");
    } finally {
      lastStateCompile.fails = false;
    }
    expect(storage.writes.length).toBe(before);
    expect(await migrationsFor(storage, {}).list()).toHaveLength(1);
  });

  it("publishes the missing states again from the state it started from", async () => {
    const full = { linked: true, indexed: true, nickname: true };
    // An uninterrupted run, for the ids.
    const reference = new MemoryStorage();
    const v1 = await migrationsFor(reference, {}).generate({ name: "v1" });
    const finished = await migrationsFor(reference, full).generate({
      name: "v2",
      lowLock: true,
    });
    // The same run, stopped after the keys' state: before the validation.
    let published = 0;
    const storage = new (class extends MemoryStorage {
      override publishState(
        id: Parameters<MemoryStorage["publishState"]>[0],
        bytes: Uint8Array
      ) {
        published += 1;
        if (published === 6) throw new Error("storage went away");
        return super.publishState(id, bytes);
      }
    })();
    await migrationsFor(storage, {}).generate({ name: "v1" });
    await expect(
      migrationsFor(storage, full).generate({ name: "v2", lowLock: true })
    ).rejects.toThrow("storage went away");
    const stopped = await migrationsFor(storage, {}).list();
    expect(stopped.map(({ name }) => name)).toContain("v2 (step 4 of 5)");

    // Its schema is the target's, so a plain re-drive is a noop...
    await expect(
      migrationsFor(storage, full).generate({ name: "v2", lowLock: true })
    ).resolves.toMatchObject({ outcome: "noop" });
    // ...and `from` publishes the same states, then the validation.
    const resumed = await migrationsFor(storage, full).generate({
      name: "v2",
      lowLock: true,
      from: v1.stateId,
    });
    expect(resumed.stateId).toBe(finished.stateId);
    const ids = async (from: MemoryStorage) =>
      (await migrationsFor(from, {}).list())
        .map(({ stateId }) => stateId)
        .sort();
    expect(await ids(storage)).toEqual(await ids(reference));
  });
});

describe("lowLockStates", () => {
  const table = (name: string) => ({
    name,
    columns: [],
    indexes: [{ name: `${name}_old_idx`, columns: ["a"], unique: false }],
    foreignKeys: [],
    uniqueConstraints: [],
  });
  const snapshot = (...names: string[]): SchemaSnapshot => ({
    ...emptyManagedSnapshot(),
    tables: names.map(table),
  });
  const build: DiffOperation = {
    type: "createIndex",
    tableName: "t",
    index: { name: "t_new_idx", columns: ["a"], unique: false },
  };
  const drop: DiffOperation = {
    type: "dropIndex",
    tableName: "t",
    indexName: "t_old_idx",
  };

  it("does not split a program whose later states it cannot read back", () => {
    const current = snapshot("t");
    const desired = snapshot("u");
    // A table rename before an index drop: the dropped index's definition at
    // that point is not the origin's.
    const rename: DiffOperation = { type: "renameTable", from: "t", to: "u" };
    expect(
      lowLockStates(
        [rename, { ...build, tableName: "u" }, { ...drop, tableName: "u" }],
        current,
        desired
      )
    ).toBeUndefined();
    // Something other than a build, a drop or a key after the first build.
    const column: DiffOperation = {
      type: "dropColumn",
      tableName: "t",
      columnName: "a",
    };
    expect(
      lowLockStates([build, column], current, snapshot("t"))
    ).toBeUndefined();
    // An index the origin never had cannot be restored.
    expect(
      lowLockStates(
        [build, { ...drop, indexName: "t_missing_idx" }],
        current,
        snapshot("t")
      )
    ).toBeUndefined();
  });

  it("restores an index a later state drops, and removes one it builds", () => {
    const current = snapshot("t");
    const desired: SchemaSnapshot = {
      ...current,
      tables: [
        {
          ...table("t"),
          indexes: [{ name: "t_new_idx", columns: ["a"], unique: false }],
        },
      ],
    };
    const column: DiffOperation = {
      type: "addColumn",
      tableName: "t",
      column: { name: "b", type: "text", nullable: true },
    };
    const split = lowLockStates([column, build, drop], current, desired)!;
    expect(split.states.map(({ operations }) => operations)).toEqual([
      [column],
      [build],
      [drop],
    ]);
    expect(split.states[0]!.snapshot.tables[0]!.indexes).toEqual([
      { name: "t_old_idx", columns: ["a"], unique: false },
    ]);
    expect(
      split.states[1]!.snapshot.tables[0]!.indexes.map(
        ({ name }) => name
      ).sort()
    ).toEqual(["t_new_idx", "t_old_idx"]);
    expect(split.states[2]!.snapshot).toEqual(desired);
  });
});

describe("groupContiguousAtomicity", () => {
  it("commits an edge that validates a constraint alone", () => {
    const edge = (sql: string) => ({ boundary: "transactional", sql: [sql] });
    const add = edge(
      'ALTER TABLE "a" ADD CONSTRAINT "k" FOREIGN KEY ("b") REFERENCES "c" ("d") NOT VALID'
    );
    const validate = edge('ALTER TABLE "a" VALIDATE CONSTRAINT "k"');
    const column = edge('ALTER TABLE "a" ADD COLUMN "e" text');
    expect(
      groupContiguousAtomicity(
        [column, add, validate, column],
        ({ sql }) => sql
      ).map(({ items }) => items)
    ).toEqual([[column, add], [validate], [column]]);
  });
});
