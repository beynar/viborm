import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { s } from "@schema";
import { defineContract } from "@tests/contracts/contract";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

/**
 * PHASE 7.2 — the multi-row `INSERT … RETURNING` fold (query-performance-plan,
 * Decision 7.2).
 *
 * `createMany` with a `select` used to send ONE `INSERT … RETURNING` PER INPUT
 * ROW, so that each provider result carried an exact input ordinal. On a driver
 * with a RETURNING clause the same rows come back from ONE multi-row
 * `INSERT … VALUES (…),(…),(…) RETURNING …`, and the returned rows are mapped to
 * the input rows POSITIONALLY.
 *
 * That mapping is the accepted trust of this phase: the SQL standard does not
 * order a RETURNING result, and PostgreSQL documents no ordering guarantee for
 * it either. What is relied on is the implementation guarantee that a single
 * `INSERT … VALUES` processes its rows in the order they are written and emits
 * each row's RETURNING projection as it processes it — the same stance Prisma
 * takes. The bound is exactly that: ONE `INSERT … VALUES` list, no `INSERT …
 * SELECT`, no parallel plan (PostgreSQL never parallelizes the VALUES scan of a
 * data-modifying statement), no `ORDER BY`.
 *
 * These witnesses are what only a test that can SEE the traffic can prove: the
 * COUNT, the ORDER against a payload whose input order disagrees with every
 * storage order, the per-run grouping, and that the non-returning driver kept
 * its documented per-row path. They run on every driver leg.
 */

const foldRow = s
  .model({
    id: s.int().id(),
    code: s.string().unique(),
    label: s.string(),
  })
  .map("p72_fold_rows");

const foldAutoRow = s
  .model({
    id: s.int().id().increment(),
    label: s.string(),
  })
  .map("p72_fold_auto_rows");

const schema = { foldRow, foldAutoRow };

type FoldClient = VibORMClient<VibORMConfig<typeof schema>>;

type ExecuteSeam = (
  client: unknown,
  sql: string,
  params: unknown[] | undefined,
  context?: unknown
) => Promise<unknown>;

/**
 * Record every statement the driver sends, on ANY driver.
 *
 * The seam is the driver's own `execute`/`executeRaw` — the two methods every
 * concrete driver implements and through which a transaction-bound driver also
 * routes — so one hook sees both substrates on all five legs. Patched as an own
 * property of the instance so it shadows the prototype method the driver calls
 * on itself.
 */
function recordStatements(driver: AnyDriver): {
  start(): void;
  drain(): string[];
} {
  const statements: string[] = [];
  let recording = false;
  const seam = driver as unknown as Record<string, ExecuteSeam>;
  for (const method of ["execute", "executeRaw"]) {
    const original = seam[method]?.bind(driver);
    if (!original) continue;
    seam[method] = (client, sql, params, context) => {
      if (recording) statements.push(sql);
      return original(client, sql, params, context);
    };
  }
  return {
    start() {
      recording = true;
    },
    drain() {
      recording = false;
      return statements.splice(0, statements.length);
    },
  };
}

const isInsert = (statement: string) =>
  statement.trim().toUpperCase().startsWith("INSERT");
const isSelect = (statement: string) =>
  statement.trim().toUpperCase().startsWith("SELECT");

export function runCreateManyReturnFoldBehavior(options: {
  readonly driverName: string;
  readonly createDriver: () => AnyDriver;
}): void {
  describe(`${options.driverName} createMany select fold`, () => {
    const supportsReturning =
      options.createDriver().adapter.capabilities.supportsReturning;
    let client: FoldClient | undefined;
    let recorder: ReturnType<typeof recordStatements> | undefined;

    beforeEach(async () => {
      const driver = options.createDriver();
      recorder = recordStatements(driver);
      client = createClient({ schema, driver });
      await syncLiveSchema(client);
      await client.foldRow.deleteMany({});
      await client.foldAutoRow.deleteMany({});
    });

    afterEach(async () => {
      if (client) {
        await client.$disconnect();
        client = undefined;
      }
      recorder = undefined;
    });

    test("four same-shape rows are ONE statement, and the rows come back in input order", async () => {
      // Every storage order disagrees with the input order: the primary keys
      // descend, and the unique `code` values are non-monotonic. A result that
      // arrived by primary-key order would read 10,20,30,40; by `code` index
      // order it would read "a","b","c","d". Input order is none of those.
      recorder?.start();
      const rows = await client!.foldRow.createMany({
        data: [
          { id: 40, code: "c", label: "first" },
          { id: 10, code: "a", label: "second" },
          { id: 30, code: "d", label: "third" },
          { id: 20, code: "b", label: "fourth" },
        ],
        select: { id: true, code: true, label: true },
      });
      const statements = recorder?.drain() ?? [];

      expect(rows.map((row) => row.label)).toEqual([
        "first",
        "second",
        "third",
        "fourth",
      ]);
      expect(rows.map((row) => row.id)).toEqual([40, 10, 30, 20]);

      if (supportsReturning) {
        // THE measurement: four statements became one.
        expect(statements).toHaveLength(1);
        expect(statements[0]).toContain("RETURNING");
        expect(isInsert(statements[0] ?? "")).toBe(true);
      } else {
        // The documented non-returning path, unchanged: one INSERT per input row,
        // each interleaved with the refetch that reads it back by its created
        // identity. Nothing here folds — the refetch needs one INSERT to address.
        expect(statements).toHaveLength(8);
        expect(statements.map(isInsert)).toEqual([
          true,
          false,
          true,
          false,
          true,
          false,
          true,
          false,
        ]);
        expect(statements.filter(isSelect)).toHaveLength(4);
      }

      // The persisted effect is the same whichever path ran.
      const stored = await client!.foldRow.findMany({ orderBy: { id: "asc" } });
      expect(stored.map((row) => row.id)).toEqual([10, 20, 30, 40]);
    });

    test("row shapes that differ split into one statement per contiguous run, still in input order", async () => {
      // Two runs: the two rows that supply an increment id, then the two that
      // omit it. The fold is per RUN, so this is two statements on a returning
      // driver — and the runs' rows concatenate back into input order.
      recorder?.start();
      const rows = await client!.foldAutoRow.createMany({
        data: [
          { id: 300, label: "explicit-high" },
          { id: 200, label: "explicit-low" },
          { label: "generated-first" },
          { label: "generated-second" },
        ],
        select: { id: true, label: true },
      });
      const statements = recorder?.drain() ?? [];

      expect(rows.map((row) => row.label)).toEqual([
        "explicit-high",
        "explicit-low",
        "generated-first",
        "generated-second",
      ]);
      expect(rows[0]?.id).toBe(300);
      expect(rows[1]?.id).toBe(200);
      expect(new Set(rows.map((row) => row.id)).size).toBe(4);

      expect(statements.filter(isInsert)).toHaveLength(
        supportsReturning ? 2 : 4
      );
    });

    test("skipDuplicates with select is ONE statement whose rows are exactly the rows inserted", async () => {
      await client!.foldRow.create({
        data: { id: 1, code: "taken", label: "existing" },
      });

      const call = () =>
        client!.foldRow.createMany({
          data: [
            // Collides with the row already stored.
            { id: 2, code: "taken", label: "skipped-existing" },
            { id: 3, code: "fresh", label: "inserted" },
            // Collides with the row two lines up — INSIDE the same statement.
            { id: 4, code: "fresh", label: "skipped-self" },
          ],
          skipDuplicates: true,
          select: { id: true, label: true },
        });

      if (!supportsReturning) {
        // U-E6.9 (maintainer-authorized): no longer a refusal. This file is about the
        // FOLD, which is a returning-driver property — one statement, `RETURNING`. A
        // non-returning driver reaches the same ANSWER by the opposite arrangement (one
        // skippable INSERT per row, then a refetch per surviving row), so what it owes
        // here is the answer, not the statement count. Crucially the within-payload
        // collision two lines up is skipped too: row 4 conflicts with the row row 3 just
        // inserted, inside the same operation.
        const perRow = await call();
        expect(perRow).toEqual([{ id: 3, label: "inserted" }]);
        const written = await client!.foldRow.findMany({
          orderBy: { id: "asc" },
        });
        expect(written.map((row) => row.label)).toEqual([
          "existing",
          "inserted",
        ]);
        return;
      }

      recorder?.start();
      const rows = await call();
      const statements = recorder?.drain() ?? [];

      // THE CONTRACT the fold pins for a skip: RETURNING yields exactly the rows
      // the statement inserted, in the payload's order. A skipped row is ABSENT
      // from the result — it does not shift the surviving rows, because the
      // result is a row list, not an input-indexed slot map. This is what the
      // per-row path already produced, measured statement for statement.
      expect(rows).toEqual([{ id: 3, label: "inserted" }]);
      expect(statements).toHaveLength(1);
      expect(statements[0]).toContain("RETURNING");

      const stored = await client!.foldRow.findMany({ orderBy: { id: "asc" } });
      expect(stored.map((row) => row.label)).toEqual(["existing", "inserted"]);
    });
  });
}

export const createManyReturnFoldContract = defineContract({
  id: "drivers.create-many-return-fold",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution"],
  register: runCreateManyReturnFoldBehavior,
});
