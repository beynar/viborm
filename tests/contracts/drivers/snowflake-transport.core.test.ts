/**
 * The SQL API v2 exchange, against a local server answering as the
 * documentation says Snowflake does: a statement still running answers 202 and
 * is polled; a large result comes in gzip partitions, read in order; a
 * request that failed before Snowflake answered is sent again with the same
 * `requestId` and `retry=true`; a statement past its timeout is cancelled.
 */

import { SnowflakeAuthenticator } from "@drivers/snowflake/auth";
import { SnowflakeTransport } from "@drivers/snowflake/transport";
import { QueryError, VibORMErrorCode } from "@errors";
import {
  type FakeAnswer,
  type FakeSnowflake,
  startFakeSnowflake,
} from "@tests/fixtures/snowflake-server";
import { afterEach, describe, expect, it } from "vitest";

let server: FakeSnowflake | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function transport(
  answer: () => FakeAnswer,
  options: { timeout?: number } = {}
): Promise<SnowflakeTransport> {
  server = await startFakeSnowflake(answer);
  return new SnowflakeTransport({
    baseUrl: server.url,
    authenticator: new SnowflakeAuthenticator({ account: "a", token: "t" }),
    context: { warehouse: "WH" },
    parameters: { TIMEZONE: "UTC" },
    fetch: (input, init) => fetch(input, init),
    pollIntervalMs: 5,
    ...options,
  });
}

const column = { name: "N", type: "fixed", scale: 0 };

describe("Snowflake SQL API transport", () => {
  it("polls a statement that answers 202 until its result", async () => {
    // The submission answers 202, then three polls do, then the fourth is 200.
    const client = await transport(() => ({
      rowType: [column],
      partitions: [[["1"]]],
      pending: 3,
    }));
    const result = await client.run("SELECT 1", undefined);
    expect(result.rows).toEqual([["1"]]);
    const methods = server!.requests.map(
      (request) => `${request.method} ${request.path.split("?")[0]}`
    );
    expect(methods).toEqual([
      "POST /api/v2/statements",
      `GET /api/v2/statements/${result.handle}`,
      `GET /api/v2/statements/${result.handle}`,
      `GET /api/v2/statements/${result.handle}`,
      `GET /api/v2/statements/${result.handle}`,
    ]);
  });

  it("reads every gzip partition after the first, in order", async () => {
    const partitions = Array.from({ length: 7 }, (_, part) =>
      Array.from({ length: 3 }, (_, row) => [String(part * 3 + row)])
    );
    const client = await transport(() => ({ rowType: [column], partitions }));
    const result = await client.run("SELECT N", undefined);
    expect(result.rows.map((row) => row[0])).toEqual(
      Array.from({ length: 21 }, (_, index) => String(index))
    );
    const partitionReads = server!.requests.filter((request) =>
      request.path.includes("partition=")
    );
    expect(partitionReads).toHaveLength(6);
  });

  it("sends a request again with the same requestId and retry=true after a 503", async () => {
    const client = await transport(() => ({
      rowType: [column],
      partitions: [[["1"]]],
    }));
    server!.failNext(503, 2);
    await client.run("SELECT 1", undefined);
    const posts = server!.requests.filter(
      (request) => request.method === "POST"
    );
    expect(posts).toHaveLength(3);
    const ids = posts.map((request) =>
      new URLSearchParams(request.path.split("?")[1]).get("requestId")
    );
    expect(new Set(ids).size).toBe(1);
    expect(posts.map((request) => request.path.includes("retry=true"))).toEqual(
      [false, true, true]
    );
  });

  it("gives up after its attempts and answers the last status", async () => {
    const client = await transport(() => ({
      rowType: [column],
      partitions: [[["1"]]],
    }));
    server!.failNext(503, 3);
    await expect(client.run("SELECT 1", undefined)).rejects.toThrow(
      "HTTP 503"
    );
  });

  it("cancels a statement past its timeout and answers a QUERY_TIMEOUT", async () => {
    const client = await transport(
      () => ({ rowType: [column], partitions: [[["1"]]], pending: 10_000 }),
      { timeout: 1 }
    );
    const failure = await client
      .run("SELECT SYSTEM$WAIT(10)", undefined)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(QueryError);
    expect((failure as QueryError).code).toBe(VibORMErrorCode.QUERY_TIMEOUT);
    expect(
      server!.requests.some(
        (request) =>
          request.method === "POST" && request.path.endsWith("/cancel")
      )
    ).toBe(true);
    // The server-side timeout is stated too.
    expect(server!.statements()[0]!.timeout).toBe(1);
  });
});
