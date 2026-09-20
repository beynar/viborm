/** REVIEW PROBE (lens A) — N4 #25: a DateTime primary key through the captured arm. */
import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { QueryResult } from "@drivers";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import type Database from "better-sqlite3";
import { describe, it } from "vitest";
import { RecordingSQLiteDriver } from "../../unit02/world";
import { BatchOnlyDriver } from "../../parity/batch-only-drivers";

class Raw extends RecordingSQLiteDriver {
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
      this.raw.push(`${(error as Error).message} || ${statement} || ${JSON.stringify(parameters)}`);
      throw error;
    }
  }
}
class RawNonReturningLive extends Raw {
  constructor() {
    super();
    this.adapter.capabilities.supportsReturning = false;
  }
}
class RawBatch extends BatchOnlyDriver {
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
      this.raw.push(`${(error as Error).message} || ${statement} || ${JSON.stringify(parameters)}`);
      throw error;
    }
  }
}
class RawBatchNonReturning extends RawBatch {
  constructor() {
    super();
    this.adapter.capabilities.supportsReturning = false;
  }
}

const dateKey = s
  .model({ id: s.dateTime().id(), tag: s.string(), n: s.int() })
  .map("pdk_date");
const schema = { dateKey };

async function world(driver: any) {
  const client = createClient({ schema, driver }) as any;
  await syncLiveSchema(client);
  await client.dateKey.create({
    data: { id: new Date("2020-01-01T00:00:00.000Z"), tag: "t", n: 0 },
  });
  await client.dateKey.create({
    data: { id: new Date("2021-01-01T00:00:00.000Z"), tag: "t", n: 0 },
  });
  driver.reset();
  driver.raw.length = 0;
  return client;
}

describe("PROBE datetime key", () => {
  for (const [name, make] of [
    ["live + RETURNING (no capture)", () => new Raw()],
    ["live, no RETURNING (capture, FOR UPDATE, no premises)", () => new RawNonReturningLive()],
    ["batch-only + RETURNING (no capture for updateMany)", () => new RawBatch()],
    ["batch-only, no RETURNING (capture + N4 premises)", () => new RawBatchNonReturning()],
  ] as const) {
    it(`${name}`, async () => {
      const driver = make() as any;
      const client = await world(driver);
      let answer: unknown;
      let raised: unknown;
      try {
        answer = await client.dateKey.updateMany({
          where: { tag: "t" },
          data: { n: 1 },
          select: { id: true },
        });
      } catch (error) {
        raised = error;
      }
      console.log(
        `[${name}] answer=${JSON.stringify(answer)} raised=${
          raised === undefined
            ? "none"
            : `${(raised as Error).constructor.name}: ${(raised as Error).message}`
        }`
      );
      for (const r of driver.raw) console.log(`   RAW: ${r}`);
      await driver.disconnect();
      assert.ok(true);
    });
  }
});
