import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";

import { s } from "@schema";
import { afterAll, describe, expect, test } from "vitest";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

/**
 * E6.9 — `createMany` with a `select` AND `skipDuplicates`, on a driver with no
 * `RETURNING`.
 *
 * MEASURED FIRST, at HEAD e37c611, on Docker MySQL 8.4: `UnsupportedOperationError`
 * (V8003)
 *
 *   createMany with 'select' does not support 'skipDuplicates' on a driver without
 *   RETURNING: the rows a skip actually inserted cannot be identified. Drop 'select' to
 *   get { count }, or drop 'skipDuplicates'.
 *
 * — for BOTH primary-key sub-cases (auto-increment and app-materialized), while the
 * `{ count }` arm of the same call answered `{ count: 1 }` for a two-row payload with one
 * duplicate. The reason on record was "inexpressible". The measured truth is narrower: no
 * single STATEMENT can report which rows a skip inserted, and no fragment whose reads are
 * decided before its writes run can either. Observing the writes can.
 *
 * The maintainer authorized the mechanism (expressible-shapes-plan.md, Risks item 3): the
 * existing savepoint effect per row, the id of each non-raising row, a refetch by the
 * collected ids, transaction substrate only. The cost — N inserts plus one read per
 * surviving row — is the accepted trade, documented at
 * `ManyAndReturnOperation.buildCreateManySkipCapture`.
 *
 * What the witnesses below have to say, and why each one:
 *
 *  - the rows come back in INPUT ORDER MINUS THE SKIPPED, for both PK sub-cases;
 *  - NO PRE-EXISTING ROW comes back as though it had just been created — the decoy is a
 *    duplicate whose insert fails, seeded with a value nothing else could produce, so a
 *    stale `lastInsertId()` or an unconditional refetch would hand it back;
 *  - the surviving rows are really written (the skip is not a silent no-op);
 *  - WITHOUT the flag the same payload still fails closed on the duplicate;
 *  - the `{ count }` arm is unchanged.
 *
 * These run through the routed CLIENT, because the whole point is the public spelling.
 */
export const skipSelectCaptureSchema = (() => {
  // AUTO-INCREMENT PK: the identity comes from the insert (the `insertId` capture).
  const widget = s
    .model({
      id: s.int().id().increment(),
      sku: s.string().unique(),
      name: s.string(),
    })
    .map("e69_widgets");
  // APP-MATERIALIZED PK: the identity is in the data itself; a unique OTHER than the PK
  // is what a row conflicts on, so a skipped row's own `id` names no row at all.
  const token = s
    .model({
      id: s.string().id(),
      code: s.string().unique(),
      name: s.string(),
    })
    .map("e69_tokens");
  return { widget, token };
})();

export const skipSelectCaptureTables = ["e69_widgets", "e69_tokens"] as const;

const UNIQUE_VIOLATION = /Unique constraint/;

function makeClient(driver: AnyDriver) {
  return createClient({ schema: skipSelectCaptureSchema, driver });
}
type CaptureClient = ReturnType<typeof makeClient>;

/** Rows returned by the bulk write, as `[sku, name]` pairs in the order handed back. */
function pairs(rows: readonly { sku: string; name: string }[]) {
  return rows.map((row) => [row.sku, row.name]);
}

export function runSkipSelectCaptureBehavior(options: {
  readonly name: string;
  readonly createDriver: () => AnyDriver;
  readonly dropTablesFirst?: boolean;
  /**
   * Declared by the caller, never sniffed: on a driver that HAS `RETURNING` the whole
   * call is one `INSERT … ON CONFLICT DO NOTHING RETURNING …` and none of the capture
   * runs. That leg is the CONTROL — it must produce the same answers by a different
   * mechanism, which is what says the absorption did not regress the fast path.
   */
  readonly supportsReturning: boolean;
  readonly register?: (label: string, body: () => void) => void;
}): void {
  const register = options.register ?? describe;
  register(
    `${options.name} createMany + select + skipDuplicates (E6.9)`,
    () => {
      let shared: CaptureClient | undefined;
      const setup = async () => {
        if (!shared) {
          const client = makeClient(options.createDriver());
          if (options.dropTablesFirst) {
            for (const table of skipSelectCaptureTables) {
              await (client as any).$executeRawUnsafe(
                `DROP TABLE IF EXISTS ${table}`
              );
            }
          }
          await syncLiveSchema(client);
          shared = client;
        }
        await shared.widget.deleteMany({});
        await shared.token.deleteMany({});
        return shared;
      };
      afterAll(async () => {
        await shared?.$disconnect();
        shared = undefined;
      });

      test(
        "auto-increment PK: input order minus the skipped, and no pre-existing row",
        { timeout: 120_000 },
        async () => {
          const client = await setup();
          // THE DECOY. It owns the sku the second input row duplicates, and its NAME is a
          // value no input carries — so if a skipped row's refetch ran anyway (an
          // unconditional read, or one addressed by a session `lastInsertId()` that by
          // then belongs to a LATER insert) this row is what would come back.
          const decoy = await client.widget.create({
            data: { sku: "b", name: "SEEDED-BEFORE" },
          });
          const rows = await client.widget.createMany({
            data: [
              { sku: "a", name: "first" },
              { sku: "b", name: "duplicate" },
              { sku: "c", name: "third" },
            ],
            skipDuplicates: true,
            select: { id: true, sku: true, name: true },
          });
          expect(pairs(rows)).toEqual([
            ["a", "first"],
            ["c", "third"],
          ]);
          // Not one returned row is the decoy, by id — the strongest form of "no
          // pre-existing row appears as though just created".
          expect(rows.map((row) => row.id)).not.toContain(decoy.id);
          // Each returned id really is the row that insert made.
          for (const row of rows) {
            await expect(
              client.widget.findUnique({ where: { id: row.id } })
            ).resolves.toMatchObject({ sku: row.sku, name: row.name });
          }
          // The state: the decoy untouched, the two survivors written.
          await expect(
            client.widget.findMany({ orderBy: { sku: "asc" } })
          ).resolves.toMatchObject([
            { sku: "a", name: "first" },
            { sku: "b", name: "SEEDED-BEFORE" },
            { sku: "c", name: "third" },
          ]);
        }
      );

      test(
        "app-materialized PK: the data names the row, and a skipped one is still absent",
        { timeout: 120_000 },
        async () => {
          const client = await setup();
          // The decoy conflicts on `code`, NOT on the primary key: the skipped input row
          // spells id `t2`, which no row has. An unconditional refetch by that id would
          // find nothing; a refetch by the conflicting row would find the decoy. Neither
          // may happen.
          await client.token.create({
            data: { id: "t1", code: "a", name: "SEEDED-BEFORE" },
          });
          const rows = await client.token.createMany({
            data: [
              { id: "t2", code: "a", name: "duplicate" },
              { id: "t3", code: "b", name: "kept" },
            ],
            skipDuplicates: true,
            select: { id: true, code: true, name: true },
          });
          expect(rows).toMatchObject([{ id: "t3", code: "b", name: "kept" }]);
          await expect(
            client.token.findMany({ orderBy: { id: "asc" } })
          ).resolves.toMatchObject([
            { id: "t1", name: "SEEDED-BEFORE" },
            { id: "t3", name: "kept" },
          ]);
        }
      );

      test(
        "nothing duplicated: every input row comes back, in input order",
        { timeout: 120_000 },
        async () => {
          const client = await setup();
          const rows = await client.widget.createMany({
            data: [
              { sku: "z", name: "one" },
              { sku: "y", name: "two" },
            ],
            skipDuplicates: true,
            select: { id: true, sku: true, name: true },
          });
          // Input order, not key order — `y` sorts before `z` and still comes second.
          expect(pairs(rows)).toEqual([
            ["z", "one"],
            ["y", "two"],
          ]);
        }
      );

      test(
        "every row duplicated: an empty result, and nothing new written",
        { timeout: 120_000 },
        async () => {
          const client = await setup();
          await client.widget.create({ data: { sku: "a", name: "kept" } });
          const rows = await client.widget.createMany({
            data: [{ sku: "a", name: "ignored" }],
            skipDuplicates: true,
            select: { id: true, sku: true, name: true },
          });
          expect(rows).toEqual([]);
          await expect(client.widget.findMany()).resolves.toMatchObject([
            { sku: "a", name: "kept" },
          ]);
        }
      );

      test(
        "WITHOUT the flag the same payload still fails closed",
        { timeout: 120_000 },
        async () => {
          const client = await setup();
          await client.widget.create({ data: { sku: "a", name: "kept" } });
          await expect(
            client.widget.createMany({
              data: [
                { sku: "a", name: "dup" },
                { sku: "d", name: "survivor" },
              ],
              select: { id: true, sku: true, name: true },
            })
          ).rejects.toThrow(UNIQUE_VIOLATION);
          // Atomic: the survivor did not land either.
          await expect(
            client.widget.findMany({ orderBy: { sku: "asc" } })
          ).resolves.toMatchObject([{ sku: "a", name: "kept" }]);
        }
      );

      test("the { count } arm is unchanged", { timeout: 120_000 }, async () => {
        const client = await setup();
        await client.widget.create({ data: { sku: "a", name: "kept" } });
        await expect(
          client.widget.createMany({
            data: [
              { sku: "a", name: "dup" },
              { sku: "e", name: "new" },
            ],
            skipDuplicates: true,
          })
        ).resolves.toEqual({ count: 1 });
      });
    }
  );
}
