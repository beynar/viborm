/** REVIEW PROBE (lens A) — N4 #25 on a D1-SHAPED (RETURNING, batch-only) transport. */
import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { QueryResult } from "@drivers";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import type Database from "better-sqlite3";
import { describe, it } from "vitest";
import { BatchOnlyDriver } from "../../parity/batch-only-drivers";

class Raw extends BatchOnlyDriver {
  readonly raw: string[] = [];
  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[],
    context?: never
  ): Promise<QueryResult<T>> {
    try {
      return await super.execute<T>(client, statement, parameters, context);
    } catch (error) {
      this.raw.push(
        `${(error as Error).message} || ${statement} || types=${JSON.stringify(
          parameters.map((p) => (p instanceof Date ? "Date" : typeof p))
        )}`
      );
      throw error;
    }
  }
}

const slot = s
  .model({
    at: s.dateTime().id(),
    label: s.string(),
    notes: s.toMany(() => note).name("d1dtSlot"),
  })
  .map("d1dt_slots");
const note = s
  .model({
    id: s.string().id(),
    slotAt: s.dateTime().nullable(),
    slot: s.toOne(() => slot).fields("slotAt").references("at").name("d1dtSlot"),
  })
  .map("d1dt_notes");
const schema = { slot, note };

describe("PROBE D1-shaped datetime key", () => {
  it("root delete with include on a DateTime primary key", async () => {
    const driver = new Raw();
    const client = createClient({ schema, driver }) as any;
    await syncLiveSchema(client);
    const at = new Date("2020-01-01T00:00:00.000Z");
    await client.slot.create({ data: { at, label: "L" } });
    await client.note.create({ data: { id: "n1", slotAt: at } });
    driver.reset();
    driver.raw.length = 0;
    let answer: unknown;
    let raised: unknown;
    try {
      answer = await client.slot.delete({
        where: { at },
        include: { notes: true },
      });
    } catch (error) {
      raised = error;
    }
    console.log(`answer=${JSON.stringify(answer)}`);
    console.log(
      `raised=${
        raised === undefined
          ? "none"
          : `${(raised as Error).constructor.name}: ${(raised as Error).message}`
      }`
    );
    for (const r of driver.raw) console.log(`  RAW: ${r}`);
    console.log("statements:");
    for (const [i, st] of driver.statements.entries())
      console.log(`  [${i}] ${st.sql}`);
    await driver.disconnect();
    assert.ok(true);
  });
});
