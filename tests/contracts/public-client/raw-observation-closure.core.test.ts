/**
 * A raw WRITE that never reaches a result is the one raw path that publishes a
 * commit certainty of its own: the statement may or may not have landed, and
 * that is exactly what its observer must be told.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { createClient } from "@client/client";
import type { QueryResult } from "@drivers";
import { Driver } from "@drivers";
import { s } from "@schema";
import { sql } from "@sql";
import { afterEach, describe, expect, test } from "vitest";

const record = s.model({
  id: s.string().id(),
  label: s.string(),
});
const schema = { record };

class RawDispatchFailureDriver extends Driver<object, object> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();

  constructor() {
    super("sqlite", "raw-observation-closure");
    this.client = {};
  }

  protected async initClient(): Promise<object> {
    return {};
  }

  protected async closeClient(): Promise<void> {
    // This fixture owns no provider resource.
  }

  protected async execute<T>(): Promise<QueryResult<T>> {
    throw new Error("raw dispatch failed");
  }

  protected async executeRaw<T>(): Promise<QueryResult<T>> {
    throw new Error("raw dispatch failed");
  }

  protected async transaction<T>(): Promise<T> {
    throw new Error("This contract opens no transaction.");
  }
}

const clients: Array<{ $disconnect(): Promise<void> }> = [];

function trackedClient() {
  const client = createClient({
    schema,
    driver: new RawDispatchFailureDriver(),
  });
  clients.push(client);
  return client;
}

function flushObservations(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.$disconnect();
});

describe("observed raw write certainty", () => {
  test("reports may-have-committed when a raw write never reaches a result", async () => {
    const base = trackedClient();
    const observed: Array<{
      unit: string;
      status: string;
      certainty: string | undefined;
    }> = [];
    const client = base.$extends({
      name: "closure-raw-observation",
      observe(unit, proceed) {
        proceed().then((completion) => {
          observed.push({
            unit: `${unit.kind}:${unit.operation}`,
            status: completion.status,
            certainty: completion.commitCertainty,
          });
        });
      },
    });

    let caught: unknown;
    try {
      await client.$executeRaw(sql`UPDATE record SET label = ${"renamed"}`);
    } catch (error) {
      caught = error;
    }
    await flushObservations();

    expect(caught).toBeInstanceOf(Error);
    expect(observed).toContainEqual({
      unit: "operation:$executeRaw",
      status: "failure",
      certainty: "may-have-committed",
    });
  });
});
