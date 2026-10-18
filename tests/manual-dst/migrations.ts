// biome-ignore-all lint/suspicious/noMisplacedAssertion: node:assert oracles are called by the manual campaign.
// biome-ignore-all lint/suspicious/noBitwiseOperators: seeded PRNG arithmetic intentionally uses unsigned 32-bit words.
import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { VibORMErrorCode } from "@errors";
import { s } from "@schema";
import { createMigrationClient, MemoryEstateStorage } from "@src/migrations";
import Database from "better-sqlite3";

/** Additive-only schema evolution; each world owns a fresh in-memory database. */
export async function runMigrationSeed(seed: number) {
  assert(Number.isSafeInteger(seed) && seed >= 0);
  let random = (seed ^ 0x24_3f_6a_88) >>> 0;
  const pick = (limit: number) => {
    random ^= random << 13;
    random ^= random >>> 17;
    random ^= random << 5;
    return (random >>> 0) % limit;
  };
  const recipe = {
    seed,
    rows: Array.from({ length: 1 + pick(5) }, (_, index) => ({
      id: index + 1,
      tenantId: `tenant-${pick(2)}`,
      label: `row-${seed}-${index}`,
      score: pick(100),
    })),
    note: `note-${pick(1000)}`,
    increment: 1 + pick(7),
  };
  const worlds: {
    mode: "push" | "history";
    actions: string[];
    observations: { step: string; state: unknown }[];
  }[] = [];

  for (const mode of ["push", "history"] as const) {
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    const driver = new SQLite3Driver({ client: database });
    const actions: string[] = [];
    const observations: { step: string; state: unknown }[] = [];
    const snapshot = () => ({
      catalog: database
        .prepare(
          "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name"
        )
        .all(),
      rows: database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='entry'"
        )
        .get()
        ? database.prepare('SELECT * FROM "entry" ORDER BY id').all()
        : [],
    });
    const observe = (step: string) => {
      actions.push(step);
      observations.push({ step, state: snapshot() });
    };
    const baseFields = {
      id: s.int().id(),
      tenantId: s.string(),
      label: s.string(),
      score: s.int(),
    };
    const first = createClient({
      driver,
      schema: { entry: s.model(baseFields) },
    });
    const second = createClient({
      driver,
      schema: {
        entry: s.model({ ...baseFields, note: s.string().nullable() }),
      },
    });
    const third = createClient({
      driver,
      schema: {
        entry: s
          .model({
            ...baseFields,
            note: s.string().nullable(),
            enabled: s.boolean().default(true),
          })
          .index(["tenantId", "score"]),
      },
    });
    const storage = new MemoryEstateStorage();
    const stages = [first, second, third].map((client) =>
      createMigrationClient(client, { storage })
    );
    try {
      for (const [index, migrations] of stages.entries()) {
        const before = snapshot();
        if (mode === "push") {
          const preview = await migrations.push({ dryRun: true });
          assert.equal(preview.outcome, "planned");
          assert.equal(preview.destructive, false);
          assert.deepEqual(
            snapshot(),
            before,
            "push dry-run changed live state"
          );
          assert.equal(
            await storage.readEstate(),
            null,
            "push wrote migration history"
          );
          assert.equal(
            (await migrations.push({ consent: preview.consent })).outcome,
            "applied"
          );
          const after = snapshot();
          await assert.rejects(migrations.push({ consent: preview.consent }), {
            code: VibORMErrorCode.MIGRATION_CONSENT_MISMATCH,
          });
          assert.deepEqual(
            snapshot(),
            after,
            "stale consent changed live state"
          );
          assert.equal((await migrations.push()).outcome, "noop");
          assert.equal(
            (await migrations.push({ dryRun: true })).outcome,
            "noop"
          );
          assert.deepEqual(
            snapshot(),
            after,
            "idempotent push changed live state"
          );
        } else {
          const generated = await migrations.generate({
            name: `seed-${seed}-stage-${index}`,
          });
          assert.equal(generated.outcome, "published");
          assert.deepEqual(snapshot(), before, "generate changed live state");
          const preview = await migrations.apply({ dryRun: true });
          assert.equal(preview.outcome, "preview");
          assert.deepEqual(
            snapshot(),
            before,
            "apply dry-run changed live state"
          );
          assert.equal((await migrations.apply()).outcome, "applied");
          const after = snapshot();
          const logBefore = await migrations.log();
          const markerBefore = (await migrations.status()).marker;
          assert.equal((await migrations.apply()).outcome, "noop");
          assert.equal((await migrations.push()).outcome, "noop");
          assert.deepEqual(
            snapshot(),
            after,
            "no-op history operation changed live state"
          );
          assert.deepEqual(
            await migrations.log(),
            logBefore,
            "no-op changed migration history"
          );
          assert.deepEqual(
            (await migrations.status()).marker,
            markerBefore,
            "no-op changed migration marker"
          );
          assert.equal((await migrations.verify()).ok, true);
          const log = await migrations.log();
          assert.equal(
            log.filter((event) => event.kind === "applied").length,
            index + 1
          );
        }
        observe(`stage-${index}-${mode}`);
        if (index === 0) {
          await first.entry.createMany({ data: recipe.rows });
          assert.deepEqual(snapshot().rows, recipe.rows);
        } else {
          const expected = recipe.rows.map((row) => ({
            ...row,
            score:
              row.score + (index === 2 && row.id === 1 ? recipe.increment : 0),
            note: index === 2 && row.id === 1 ? recipe.note : null,
            ...(index === 2 ? { enabled: 1 } : {}),
          }));
          assert.deepEqual(
            snapshot().rows,
            expected,
            "schema evolution lost stored values"
          );
          if (index === 1) {
            await second.entry.update({
              where: { id: 1 },
              data: {
                note: recipe.note,
                score: { increment: recipe.increment },
              },
            });
          }
        }
        observe(`stage-${index}-rows`);
      }
      const columns = database
        .prepare<[], { name: string }>('PRAGMA table_info("entry")')
        .all();
      assert.deepEqual(
        columns.map((column) => column.name),
        ["id", "tenantId", "label", "score", "note", "enabled"]
      );
      const indexes = database
        .prepare<[], { name: string }>('PRAGMA index_list("entry")')
        .all();
      assert(
        indexes.some((index) => {
          const columns = database
            .prepare<[string], { name: string }>(
              "SELECT name FROM pragma_index_info(?) ORDER BY seqno"
            )
            .all(index.name);
          return (
            columns.map((column) => column.name).join(",") === "tenantId,score"
          );
        }),
        "additive compound index was not installed"
      );
      const read = await third.entry.findMany({ orderBy: { id: "asc" } });
      assert.deepEqual(
        read,
        recipe.rows.map((row) => ({
          ...row,
          score: row.score + (row.id === 1 ? recipe.increment : 0),
          note: row.id === 1 ? recipe.note : null,
          enabled: true,
        }))
      );
      if (mode === "history") {
        const changed = createClient({
          driver,
          schema: { ...third.$schema, extra: s.model({ id: s.int().id() }) },
        });
        const before = snapshot();
        await assert.rejects(createMigrationClient(changed).push(), {
          code: VibORMErrorCode.MIGRATION_INVALID_STATE,
        });
        assert.deepEqual(
          snapshot(),
          before,
          "push bypassed the migration marker"
        );
        observe("history-interlock-refusal");
      }
      assert.equal(database.inTransaction, false);
      worlds.push({ mode, actions, observations });
    } catch (cause) {
      throw new Error(
        `Migration DST failed: ${JSON.stringify({ recipe, mode, actions, observations })}`,
        { cause }
      );
    } finally {
      await driver.disconnect();
      if (database.open) database.close();
    }
  }
  return { recipe, worlds };
}
