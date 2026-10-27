import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import type { StudioRequest, StudioResponse } from "@src/studio/api";
import {
  encodeJson,
  STUDIO_HOST,
  type StudioServer,
  startStudioServer,
} from "@src/studio/server";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const HTML = "<!doctype html><title>studio</title>";
const seen: StudioRequest[] = [];
let server: StudioServer;
let port: number;

const handle = async (request: StudioRequest): Promise<StudioResponse> => {
  seen.push(request);
  if (request.path === "/throws") throw new Error("handler broke");
  if (request.path === "/throws-text") {
    // biome-ignore lint/style/useThrowOnlyError: a handler may throw anything; the server must still answer.
    throw "not an error";
  }
  return { status: 200, body: { echo: request.body ?? null, big: 2n ** 64n } };
};

interface Sent {
  method?: string;
  path?: string;
  host?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** A raw request, so the Host header can be anything a browser could send. */
function send(options: Sent = {}) {
  return new Promise<{
    status: number;
    headers: Record<string, unknown>;
    text: string;
  }>((resolvePromise, rejectPromise) => {
    const request = httpRequest(
      {
        host: STUDIO_HOST,
        port,
        method: options.method ?? "GET",
        path: options.path ?? "/",
        headers: {
          host: options.host ?? `${STUDIO_HOST}:${port}`,
          ...options.headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolvePromise({
            status: response.statusCode ?? 0,
            headers: response.headers,
            text: Buffer.concat(chunks).toString("utf8"),
          })
        );
      }
    );
    request.on("error", rejectPromise);
    request.end(options.body);
  });
}

const postJson = (path: string, body: string, headers = {}) =>
  send({
    method: "POST",
    path,
    body,
    headers: { "content-type": "application/json", ...headers },
  });
const codeOf = (text: string) =>
  (JSON.parse(text) as { error: { code: string } }).error.code;

beforeAll(async () => {
  server = await startStudioServer({ handle, html: HTML, port: 0 });
  port = Number(new URL(server.url).port);
});

afterAll(() => server.close());

describe("the studio server", () => {
  test("listens on 127.0.0.1 and serves the app with a locked-down policy", async () => {
    expect(server.url).toBe(`http://127.0.0.1:${port}`);
    const page = await send({ path: "/schema/anything" });
    expect(page.status).toBe(200);
    expect(page.text).toBe(HTML);
    expect(page.headers["content-security-policy"]).toContain(
      "default-src 'none'"
    );
    const head = await send({ method: "HEAD" });
    expect([head.status, head.text]).toEqual([200, ""]);
    const post = await send({ method: "POST" });
    expect(post.status).toBe(405);
  });

  test("passes API calls to the handler and encodes what JSON cannot", async () => {
    const answer = await postJson("/api/models/a/rows", '{"take":5}', {
      origin: `http://localhost:${port}`,
    });
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.text)).toEqual({
      echo: { take: 5 },
      big: "18446744073709551616",
    });
    expect(seen.at(-1)).toEqual({
      method: "POST",
      path: "/models/a/rows",
      body: { take: 5 },
    });
    await send({ path: "/api/schema" });
    expect(seen.at(-1)).toEqual({
      method: "GET",
      path: "/schema",
      body: undefined,
    });
    await postJson("/api/empty", "");
    expect(seen.at(-1)?.body).toBeUndefined();
  });

  test("refuses a rebound host and a foreign origin", async () => {
    const rebound = await send({ host: `attacker.example:${port}` });
    expect([rebound.status, codeOf(rebound.text)]).toEqual([
      403,
      "forbidden_host",
    ]);
    const foreign = await postJson("/api/schema", "{}", {
      origin: "https://attacker.example",
    });
    expect([foreign.status, codeOf(foreign.text)]).toEqual([
      403,
      "forbidden_origin",
    ]);
  });

  test("takes API writes as JSON only, of a bounded size", async () => {
    const form = await send({
      method: "POST",
      path: "/api/models/a/delete",
      body: "key=1",
      headers: { "content-type": "text/plain" },
    });
    expect([form.status, codeOf(form.text)]).toEqual([
      415,
      "unsupported_media_type",
    ]);
    const untyped = await send({ method: "POST", path: "/api/schema" });
    expect(untyped.status).toBe(415);
    const broken = await postJson("/api/models/a/rows", "{");
    expect([broken.status, codeOf(broken.text)]).toEqual([400, "invalid_json"]);
    const large = await postJson(
      "/api/models/a/rows",
      JSON.stringify({ text: "x".repeat(1024 * 1024) })
    );
    expect([large.status, codeOf(large.text)]).toEqual([413, "body_too_large"]);
  });

  test("a handler failure is a 500, not a crash", async () => {
    const failed = await send({ path: "/api/throws" });
    expect([failed.status, codeOf(failed.text)]).toEqual([500, "internal"]);
    expect(JSON.parse(failed.text).error.message).toBe("handler broke");
    const text = await send({ path: "/api/throws-text" });
    expect(JSON.parse(text.text).error.message).toBe("Studio failure");
  });

  test("a request without a Host header is refused", async () => {
    const answer = await new Promise<string>((resolvePromise) => {
      const socket = connect(port, STUDIO_HOST, () =>
        socket.end("GET / HTTP/1.0\r\n\r\n")
      );
      let text = "";
      socket.on("data", (chunk) => (text += chunk));
      socket.on("end", () => resolvePromise(text));
    });
    expect(answer.startsWith("HTTP/1.1 403")).toBe(true);
  });

  test("closing a closed server reports it", async () => {
    const other = await startStudioServer({ handle, html: HTML, port: 0 });
    await other.close();
    await expect(other.close()).rejects.toMatchObject({
      code: "ERR_SERVER_NOT_RUNNING",
    });
  });

  test("a port already taken is reported, not retried", async () => {
    await expect(
      startStudioServer({ handle, html: HTML, port })
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
  });
});

test("encodeJson spells bigints as text and bytes as base64", () => {
  expect(
    encodeJson({ big: 12n, bytes: new Uint8Array([0, 1, 2]), at: new Date(0) })
  ).toBe('{"big":"12","bytes":"AAEC","at":"1970-01-01T00:00:00.000Z"}');
});
