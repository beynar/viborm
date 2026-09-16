/**
 * FREEZE-unit review probe, ROUND 2 — the nested `upsert` arm handoff on live
 * PostgreSQL.
 *
 * The unit measured the repair on SQLite (`nested-key-refusal.test.ts`) and on
 * live MySQL (`native-nested-key-refusal.test.ts`), and records PostgreSQL as
 * unverified ("the found-arm handoff is dialect-independent by construction,
 * but PostgreSQL is an argument, not a measurement", note §R2.9 item 1).
 *
 * PostgreSQL is the RETURNING provider, so the found arm is reached through a
 * different transport than either of the other two: this probe is the missing
 * measurement, not a third opinion. Three rows, both engines, real tables:
 *
 *  - a nested `upsert` whose target is PRESENT must refuse with the shipped
 *    arity sentence and write nothing;
 *  - the same payload with an ABSENT target must take the create arm and CREATE
 *    the row (the shipped `updateLegality` closure, `RelationUpsertPart.ts:1006`,
 *    is invoked only at `:468`, inside the found arm);
 *  - a nested `update` must refuse from its compile-time position
 *    (`RelationWritePart.ts:856`).
 *
 * Skipped unless `VIBORM_RAPTOR3_PROVIDER=pg` names a live provider; the
 * container and port used for a run are recorded in the receipt beside it.
 */

import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { Operations } from "@client/types";
import { PgDriver } from "@drivers/pg";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { describe, it } from "vitest";

const provider = process.env.VIBORM_RAPTOR3_PROVIDER;
const port = Number(process.env.VIBORM_RAPTOR3_PROVIDER_PORT ?? "0");

const ARITY_SET_INCREMENT =
  "QueryEngineError: Primary key field 'id' accepts exactly one update operation; received set, increment.";

interface Outcome {
  readonly answer: string;
  readonly items: number[];
}

describe.runIf(provider === "pg" && port > 0)(
  "freeze review round 2 — nested key refusal on live PostgreSQL",
  () => {
    for (const [name, args, expected, expectedKeys] of [
      [
        "refuses a nested upsert whose target is PRESENT, writing nothing",
        {
          where: { id: 1 },
          data: {
            items: {
              upsert: [
                {
                  where: { id: 10 },
                  create: { id: 10, name: "i" },
                  update: { id: { set: 11, increment: 1 } },
                },
              ],
            },
          },
        },
        ARITY_SET_INCREMENT,
        [10],
      ],
      [
        "creates the row for a nested upsert whose target is ABSENT",
        {
          where: { id: 1 },
          data: {
            items: {
              upsert: [
                {
                  where: { id: 999 },
                  create: { id: 999, name: "fresh" },
                  update: { id: { set: 11, increment: 1 } },
                },
              ],
            },
          },
        },
        undefined,
        [10, 999],
      ],
      [
        "refuses a nested update whose key names set beside an operator",
        {
          where: { id: 1 },
          data: {
            items: {
              update: [
                { where: { id: 10 }, data: { id: { set: 11, increment: 1 } } },
              ],
            },
          },
        },
        ARITY_SET_INCREMENT,
        [10],
      ],
    ] as const) {
      it(name, async () => {
        const suffix = randomUUID().replaceAll("-", "");
        const owners = `g4fzpg_owners_${suffix}`;
        const items = `g4fzpg_items_${suffix}`;
        const owner = s
          .model({
            id: s.int().id(),
            label: s.string(),
            items: s.toMany(() => item),
          })
          .map(owners);
        const item = s
          .model({
            id: s.int().id(),
            name: s.string(),
            ownerId: s.int().nullable(),
            owner: s
              .toOne(() => owner)
              .fields("ownerId")
              .references("id"),
          })
          .map(items);
        const schema = { owner, item };
        const driver = new PgDriver({
          options: {
            host: "127.0.0.1",
            port,
            database: "raptor3_g2",
            user: "postgres",
            password: "",
            ssl: false,
            max: 1,
            connectionTimeoutMillis: 10_000,
          },
        });
        const client = createClient({ schema, driver });
        const seed = async (): Promise<void> => {
          await driver._executeRaw(`DELETE FROM ${items}`);
          await driver._executeRaw(`DELETE FROM ${owners}`);
          await driver._executeRaw(
            `INSERT INTO ${owners} (id, label) VALUES (1, 'o')`
          );
          await driver._executeRaw(
            `INSERT INTO ${items} (id, name, "ownerId") VALUES (10, 'i', 1)`
          );
        };
        const measure = async (
          engine: "shipped" | "candidate"
        ): Promise<Outcome> => {
          await seed();
          let answer: string;
          try {
            const value =
              engine === "shipped"
                ? await (
                    client as unknown as Record<
                      string,
                      Record<string, (input: unknown) => Promise<unknown>>
                    >
                  ).owner!.update!(args)
                : await createCommandEngine({ schema, driver }).execute(
                    "owner",
                    "update" as Operations,
                    args
                  );
            answer = `ok:${JSON.stringify(value)}`;
          } catch (error) {
            answer = `${(error as Error).constructor.name}: ${(error as Error).message}`;
          }
          const rows = await driver._executeRaw<{ id: number }>(
            `SELECT id FROM ${items} ORDER BY id`
          );
          return { answer, items: rows.rows.map((row) => Number(row.id)) };
        };
        try {
          assert.equal(driver.adapter.capabilities.supportsReturning, true);
          await driver._executeRaw(
            `CREATE TABLE ${owners} (id INTEGER PRIMARY KEY, label VARCHAR(32) NOT NULL)`
          );
          await driver._executeRaw(
            `CREATE TABLE ${items} (id INTEGER PRIMARY KEY, name VARCHAR(32) NOT NULL, "ownerId" INTEGER NULL)`
          );
          const shipped = await measure("shipped");
          const candidate = await measure("candidate");
          // biome-ignore lint/suspicious/noConsole: the probe's measurement IS its output.
          console.log(
            `${JSON.stringify(shipped) === JSON.stringify(candidate) ? "AGREE" : "DIFFER"}  ${name}\n    shipped   ${JSON.stringify(shipped)}\n    candidate ${JSON.stringify(candidate)}`
          );
          assert.deepEqual(
            candidate,
            shipped,
            `candidate ${JSON.stringify(candidate)}\nshipped   ${JSON.stringify(shipped)}`
          );
          if (expected !== undefined) assert.equal(shipped.answer, expected);
          assert.deepEqual(shipped.items, [...expectedKeys]);
        } finally {
          await driver._executeRaw(`DROP TABLE IF EXISTS ${items}`);
          await driver._executeRaw(`DROP TABLE IF EXISTS ${owners}`);
          await client.$disconnect();
        }
      });
    }
  }
);
