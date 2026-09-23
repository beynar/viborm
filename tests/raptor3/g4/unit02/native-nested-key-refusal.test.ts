/**
 * G4-02 native probe — the nested key refusal's POSITION, on a live provider.
 *
 * `nested-key-refusal.test.ts` measures the whole family on an in-memory SQLite
 * world, which is the only world that file has. The freeze review's finding 1
 * was about WHICH ARM runs, not about a sentence, so the reviewer asked for the
 * repair to be measured on at least one native provider: the shipped engine's
 * `updateLegality` closure (`RelationUpsertPart.ts:1006`, invoked at `:468`)
 * runs inside the found arm, after the probe rows come back, and a real
 * non-RETURNING provider reaches that arm through a different transport than
 * SQLite does.
 *
 * Three rows, each on both engines over the same seeded data, answer AND rows:
 * a nested `upsert` whose target is PRESENT must refuse and write nothing; the
 * same payload with an ABSENT target must CREATE the row; and a nested `update`
 * must refuse from its compile-time position (`RelationWritePart.ts:856`).
 *
 * Skipped unless `VIBORM_RAPTOR3_PROVIDER=mysql` names a live provider; the
 * container and port used for a run are recorded in the receipt beside it.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@client/client";
import type { Operations } from "@client/types";
import { MySQL2Driver } from "@drivers/mysql2";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { describe, it } from "vitest";

const provider = process.env.VIBORM_RAPTOR3_PROVIDER;
const port = Number(process.env.VIBORM_RAPTOR3_PROVIDER_PORT ?? "0");

const ARITY_SET_INCREMENT =
  "QueryEngineError: Primary key field 'id' accepts exactly one update operation; received set, increment.";

interface Outcome {
  readonly answer: string;
  readonly items: unknown[];
}

describe.runIf(provider === "mysql" && port > 0)(
  "G4-02 native MySQL nested key refusal",
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
        const owners = `g4u2nnk_owners_${suffix}`;
        const items = `g4u2nnk_items_${suffix}`;
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
        const driver = new MySQL2Driver({
          options: {
            host: "127.0.0.1",
            port,
            database: "raptor3_g2",
            user: "root",
            password: "",
            connectionLimit: 1,
            connectTimeout: 10_000,
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
            `INSERT INTO ${items} (id, name, ownerId) VALUES (10, 'i', 1)`
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
          assert.equal(driver.adapter.capabilities.supportsReturning, false);
          await driver._executeRaw(
            `CREATE TABLE ${owners} (id INT PRIMARY KEY, label VARCHAR(32) NOT NULL)`
          );
          await driver._executeRaw(
            `CREATE TABLE ${items} (id INT PRIMARY KEY, name VARCHAR(32) NOT NULL, ownerId INT NULL)`
          );
          const shipped = await measure("shipped");
          const candidate = await measure("candidate");
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
