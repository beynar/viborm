/**
 * The SQL API v2 exchange, against a local server answering as the
 * documentation says Snowflake does: a statement still running answers 202 and
 * is polled; a large result comes in gzip partitions, read in order; a
 * request that failed before Snowflake answered is sent again with the same
 * `requestId` and `retry=true`; a statement past its timeout is cancelled.
 */

import { SnowflakeAuthenticator } from "@drivers/snowflake/auth";
import { SnowflakeTransport } from "@drivers/snowflake/transport";
import { ConnectionError, QueryError, VibORMErrorCode } from "@errors";
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
  options: {
    timeout?: number;
    fetch?: (input: string, init: RequestInit) => Promise<Response>;
  } = {}
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
    await expect(client.run("SELECT 1", undefined)).rejects.toThrow("HTTP 503");
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
    expect(failure).toMatchObject({ code: VibORMErrorCode.QUERY_TIMEOUT });
    expect(
      server!.requests.some(
        (request) =>
          request.method === "POST" && request.path.endsWith("/cancel")
      )
    ).toBe(true);
    // The server-side timeout is stated too.
    expect(server!.statements()[0]!.timeout).toBe(1);
  });

  it("answers the timeout within a bounded wait when the cancel never answers", async () => {
    const client = await transport(
      () => ({ rowType: [column], partitions: [[["1"]]], pending: 10_000 }),
      { timeout: 1 }
    );
    server!.holdCancels();
    const started = Date.now();
    const failure = await client
      .run("SELECT SYSTEM$WAIT(10)", undefined)
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: VibORMErrorCode.QUERY_TIMEOUT });
    // 1 s of timeout, then at most 2 s for the cancel.
    expect(Date.now() - started).toBeLessThan(4500);
    expect(
      server!.requests.some((request) => request.path.endsWith("/cancel"))
    ).toBe(true);
  }, 10_000);

  it("sends a submission again after a 500, and reads a 5xx still answered as a connection failure", async () => {
    const client = await transport(() => ({
      rowType: [column],
      partitions: [[["1"]]],
    }));
    server!.failNext(500, 1);
    expect((await client.run("SELECT 1", undefined)).rows).toEqual([["1"]]);
    const posts = server!.requests.filter(
      (request) => request.method === "POST"
    );
    expect(posts).toHaveLength(2);
    expect(posts[1]!.path).toContain("&retry=true");
    server!.failNext(504, 3);
    const failure = await client
      .run("SELECT 1", undefined)
      .catch((error: unknown) => error);
    // Not Snowflake refusing the statement: it never answered it.
    expect(failure).toBeInstanceOf(ConnectionError);
    expect(failure).not.toBeInstanceOf(QueryError);
    // A 504 may come after Snowflake started the statement: its outcome is
    // not known, and without a handle nothing can cancel it.
    expect(failure).toMatchObject({
      message: expect.stringContaining("may have started"),
    });
    expect(String((failure as Error).message)).not.toContain("did not run");
  });

  it("cancels a statement whose status reads fail, after more tries than a submission gets", async () => {
    let gets = 0;
    const client = await transport(
      () => ({ rowType: [column], partitions: [[["1"]]], pending: 10_000 }),
      {
        fetch: (input, init) => {
          if ((init.method ?? "GET") === "GET") {
            gets++;
            return Promise.reject(new TypeError("fetch failed"));
          }
          return fetch(input, init);
        },
      }
    );
    const failure = await client
      .run("SELECT 1", undefined)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConnectionError);
    // Three sends for a submission, three more for a status read.
    expect(gets).toBe(6);
    // The statement was left running: it is cancelled.
    expect(
      server!.requests.some((request) => request.path.endsWith("/cancel"))
    ).toBe(true);
  }, 15_000);

  it("sends a request again when its answer is cut off after the headers", async () => {
    let cut = 0;
    const answer = () => ({ rowType: [column], partitions: [[["1"]]] });
    const cutOff =
      (times: number) => async (input: string, init: RequestInit) => {
        const response = await fetch(input, init);
        if (cut >= times) return response;
        cut++;
        await response.body?.cancel();
        // The headers arrive; the socket resets inside the body.
        return new Response(
          new ReadableStream({
            start: (controller) =>
              controller.error(new TypeError("terminated")),
          }),
          { status: response.status, headers: response.headers }
        );
      };
    const client = await transport(answer, { fetch: cutOff(1) });
    expect((await client.run("SELECT 1", undefined)).rows).toEqual([["1"]]);
    const posts = server!.requests.filter(
      (request) => request.method === "POST"
    );
    expect(posts.map((request) => request.path.includes("retry=true"))).toEqual(
      [false, true]
    );
    await server!.close();
    cut = 0;
    const failing = await transport(answer, { fetch: cutOff(10) });
    await expect(failing.run("SELECT 1", undefined)).rejects.toBeInstanceOf(
      ConnectionError
    );
  });

  it("bounds a slow token refresh by the statement's deadline and the cancel's", async () => {
    const slow = () =>
      new Promise<string>((resolve) => setTimeout(() => resolve("t"), 8000));
    server = await startFakeSnowflake(() => ({
      rowType: [column],
      partitions: [[["1"]]],
      pending: 10_000,
    }));
    const started = Date.now();
    const client = (token: () => Promise<string> | string) =>
      new SnowflakeTransport({
        baseUrl: server!.url,
        authenticator: new SnowflakeAuthenticator({ account: "a", token }),
        context: { warehouse: "WH" },
        parameters: { TIMEZONE: "UTC" },
        fetch: (input, init) => fetch(input, init),
        pollIntervalMs: 5,
        timeout: 1,
      });
    // The submission's token never comes in time.
    await expect(client(slow).run("SELECT 1", undefined)).rejects.toMatchObject(
      { code: VibORMErrorCode.QUERY_TIMEOUT }
    );
    expect(Date.now() - started).toBeLessThan(2500);
    // The submission goes; the cancel's token is slow: 1 s, then 2 s at most.
    const second = Date.now();
    await expect(
      client(() => (Date.now() - second > 900 ? slow() : "t")).run(
        "SELECT 1",
        undefined
      )
    ).rejects.toMatchObject({ code: VibORMErrorCode.QUERY_TIMEOUT });
    expect(Date.now() - second).toBeLessThan(4500);
  }, 20_000);

  it("refuses a 200 that does not state its rows, rather than answering none", async () => {
    const meta = {
      numRows: 1,
      rowType: [column],
      partitionInfo: [{ rowCount: 1 }],
    };
    const answers: Readonly<Record<string, unknown>>[] = [
      { resultSetMetaData: meta },
      { data: [["1"]] },
      { resultSetMetaData: meta, data: [] },
    ];
    for (const body of answers) {
      const client = await transport(() => ({ body }));
      const failure = await client
        .run("SELECT 1", undefined)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(QueryError);
      expect(failure).toMatchObject({
        code: VibORMErrorCode.QUERY_RESULT_INVALID,
      });
      await server!.close();
      server = undefined;
    }
    const empty = await transport(() => ({
      body: { resultSetMetaData: { ...meta, numRows: 0 }, data: [] },
    }));
    expect((await empty.run("SELECT 1", undefined)).rows).toEqual([]);
  });

  it("refuses a partition that holds no data", async () => {
    const client = await transport(() => ({
      body: {
        resultSetMetaData: {
          rowType: [column],
          partitionInfo: [{ rowCount: 1 }, { rowCount: 1 }],
        },
        data: [["1"]],
      },
      partitions: [undefined, {}],
    }));
    await expect(client.run("SELECT 1", undefined)).rejects.toThrow(
      "partition 1 holds no data"
    );
  });
});
