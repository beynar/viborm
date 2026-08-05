import { ValidationError } from "@errors";
import { s } from "@schema";
import { sql } from "@sql";
import { describe, expect, test } from "vitest";

/**
 * E6.6 — the Sql-operand family, RECLASSIFIED on a measurement, as behavior every driver
 * leg runs.
 *
 * The plan expected a dataflow wall and a way around it: an `Sql` operand assigned to a
 * referenced column is evaluated ONCE by the write, so `RETURNING` could capture that one
 * value and a nested create could reference it — absorbable on the transaction substrate
 * of returning drivers, refused on the atomic batch by the batch capture wall (rule 9),
 * on mysql2 (no `RETURNING`), and on `null` (a contradiction).
 *
 * THE PREMISE IS MOOT, and the reason is one layer EARLIER than the wall it names: no
 * public payload can put an `Sql` operand into write data at all. The typed parse
 * boundary's create and update inputs have no `Sql` member — `validation/model/core/
 * create.ts` and `update.ts` do not mention it, and a scalar write value is validated by
 * its own scalar schema — so the fragment is refused with a `ValidationError` before any
 * operation is constructed. There is nothing for `RETURNING` to capture because there is
 * nothing to evaluate. This is the same class as E5-U2's `CreateWithOmittedFk`: an engine
 * refusal whose shape the parse boundary already owns.
 *
 * Measured at 2d0074a, over the whole family, on both roots and both spellings:
 *
 *  · `create { token: <Sql> }` and `update { token: <Sql> }` / `{ token: { set: <Sql> } }`
 *    → `ValidationError`, 0 statements. The `Sql` arm of `freshReferenced`
 *    (`CreateOperation`) and of the `isConstructionLiteral` refusal (`UpdateOperation`)
 *    is DEAD from the public surface.
 *  · `update { seq: { increment: 1 } }` beside a nested write on a relation keyed by
 *    `seq` → the CLASS IV relation-key legality guard's OWN typed `NestedWriteError`
 *    ("Use a literal value or '{ set: ... }'"), which fires first and keeps its message.
 *    The engine refusal never sees arithmetic — the code comment claimed this; this is
 *    the measurement.
 *  · `update { token: null }` on a NULLABLE referenced column → the engine refusal,
 *    reached. THIS IS THE ONE LIVE ARM, and it is exactly the arm the plan says stays
 *    refused: a foreign key equal to NULL references no row, so there is no absorption
 *    to make. Both spellings reach it, which is `{ set: … }` unwrapping working.
 *
 * So the family ships no absorption and no new guard — a refusal whose only reachable
 * payload is the contradiction it was always right about. What ships is this file: the
 * wall, pinned, so that widening the parse boundary to admit `Sql` in write data cannot
 * happen quietly. If that widening ever lands, THIS suite goes red first, and the
 * transaction-only capture the plan designed becomes real work with a real payload.
 */
export const sqlOperandWallSchema = (() => {
  const counter = s
    .model({
      id: s.string().id(),
      token: s.string().nullable().unique(),
      seq: s.int().unique(),
      tags: s.oneToMany(() => tag),
      slots: s.oneToMany(() => slot),
    })
    .map("e66_counters");

  /** Keyed by the STRING column, so the `Sql` and `null` arms are about this edge. */
  const tag = s
    .model({
      id: s.string().id(),
      counterToken: s.string().nullable(),
      counter: s
        .manyToOne(() => counter)
        .fields("counterToken")
        .references("token")
        .optional(),
    })
    .map("e66_tags");

  /** Keyed by the INT column, so `{ increment }` is spellable against its referent. */
  const slot = s
    .model({
      id: s.string().id(),
      counterSeq: s.int().nullable(),
      counter: s
        .manyToOne(() => counter)
        .fields("counterSeq")
        .references("seq")
        .optional(),
    })
    .map("e66_slots");

  return { counter, tag, slot };
})();

export async function resetSqlOperandWall(client: any): Promise<void> {
  await client.tag.deleteMany({});
  await client.slot.deleteMany({});
  await client.counter.deleteMany({});
  await client.counter.create({ data: { id: "c1", token: "t0", seq: 10 } });
}

/** The whole world, so "0 statements ran" is an assertion and not a hope. */
async function state(client: any): Promise<unknown> {
  return {
    counters: (await client.counter.findMany({})).map((row: any) => [
      row.id,
      row.token,
      row.seq,
    ]),
    tags: (await client.tag.findMany({})).map((row: any) => row.id),
    slots: (await client.slot.findMany({})).map((row: any) => row.id),
  };
}

const UNTOUCHED = { counters: [["c1", "t0", 10]], tags: [], slots: [] };

export function registerSqlOperandWallBehavior(
  name: string,
  connect: () => Promise<any>,
  register: (label: string, body: () => void) => void = describe
): void {
  register(`E6.6 the Sql-operand wall (${name})`, () => {
    test("an Sql operand on a referenced column is refused by the PARSE boundary, under both roots", async () => {
      const client = await connect();
      await resetSqlOperandWall(client);

      // Under an UPDATE root, bare and `{ set: … }` alike.
      await expect(
        client.counter.update({
          where: { id: "c1" },
          data: { token: sql`'x'`, tags: { create: { id: "g1" } } },
        })
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        client.counter.update({
          where: { id: "c1" },
          data: { token: { set: sql`'x'` }, tags: { create: { id: "g1" } } },
        })
      ).rejects.toBeInstanceOf(ValidationError);

      // Under a CREATE root, where the referenced value would be the fresh row's own.
      await expect(
        client.counter.create({
          data: {
            id: "c9",
            token: sql`'y'`,
            seq: 99,
            tags: { create: { id: "g9" } },
          },
        })
      ).rejects.toBeInstanceOf(ValidationError);

      // And with NO nested write at all: the refusal is about the operand, not the tree,
      // so there is no payload shape that gets an `Sql` into a written column.
      await expect(
        client.counter.update({
          where: { id: "c1" },
          data: { token: sql`'x'` },
        })
      ).rejects.toBeInstanceOf(ValidationError);

      expect(await state(client)).toEqual(UNTOUCHED);
    });

    test("arithmetic on a referenced column keeps CLASS IV's own typed refusal", async () => {
      const client = await connect();
      await resetSqlOperandWall(client);

      for (const operand of [{ increment: 1 }, { multiply: 2 }]) {
        await expect(
          client.counter.update({
            where: { id: "c1" },
            data: { seq: operand, slots: { create: { id: "s1" } } },
          })
        ).rejects.toThrow(
          "Cannot update relation key field 'seq' with a non-literal operation while mutating relation 'slots'. Use a literal value or '{ set: ... }'."
        );
      }
      expect(await state(client)).toEqual(UNTOUCHED);

      // The same arithmetic WITHOUT a nested write executes: CLASS IV is about the
      // combination, and this unit changes neither half.
      await client.counter.update({
        where: { id: "c1" },
        data: { seq: { increment: 1 } },
      });
      expect(await state(client)).toEqual({
        counters: [["c1", "t0", 11]],
        tags: [],
        slots: [],
      });
    });

    test("null on a nullable referenced column is the ONE arm that reaches the engine", async () => {
      const client = await connect();
      await resetSqlOperandWall(client);

      // Both spellings, one message: `{ set: … }` unwrapping happens before the check.
      for (const operand of [null, { set: null }]) {
        await expect(
          client.counter.update({
            where: { id: "c1" },
            data: { token: operand, tags: { create: { id: "g1" } } },
          })
        ).rejects.toThrow(
          "query-engine-v2 update nested create on relation 'tags' references a non-literal rewritten column 'token'."
        );
      }
      // Construction-time: the root UPDATE did not run either.
      expect(await state(client)).toEqual(UNTOUCHED);
    });
  });
}
