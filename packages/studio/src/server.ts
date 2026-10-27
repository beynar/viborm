/**
 * The studio's local HTTP server: the prebuilt app at `/`, the JSON API under
 * `/api`. It listens on 127.0.0.1 only, answers only requests addressed to
 * that host (a DNS-rebound name is refused), and takes API calls only as JSON
 * from its own origin, so a page on another site cannot drive it.
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { StudioRequest, StudioResponse } from "./api";

export interface StudioServerOptions {
  readonly handle: (request: StudioRequest) => Promise<StudioResponse>;
  /** The whole app, one HTML document with its scripts and styles inlined. */
  readonly html: string;
  /** The port to listen on; 0 picks a free one. */
  readonly port: number;
}

export interface StudioServer {
  readonly url: string;
  /** Tell every open page something changed (`GET /api/events`, Server-Sent Events). */
  broadcast(event: string, data: unknown): void;
  close(): Promise<void>;
}

export const STUDIO_HOST = "127.0.0.1";
/** The largest request body the API reads. */
const MAX_BODY_BYTES = 1024 * 1024;

const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

/** JSON for values JSON cannot carry: bigints as text, bytes as base64. */
export function encodeJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (typeof entry === "bigint") return entry.toString();
    if (entry instanceof Uint8Array) {
      return Buffer.from(entry).toString("base64");
    }
    return entry;
  });
}

export function startStudioServer(
  options: StudioServerOptions
): Promise<StudioServer> {
  let origins: ReadonlySet<string> = new Set();
  const streams = new Set<ServerResponse>();
  let hosts: ReadonlySet<string> = new Set();

  const send = (
    response: ServerResponse,
    status: number,
    body: unknown
  ): void => {
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(encodeJson(body));
  };
  const refuse = (
    response: ServerResponse,
    status: number,
    code: string,
    message: string
  ) => send(response, status, { error: { code, message } });

  async function serve(request: IncomingMessage, response: ServerResponse) {
    if (!hosts.has(request.headers.host ?? "")) {
      refuse(response, 403, "forbidden_host", "Unknown host");
      return;
    }
    // An HTTP server request always carries its method and target.
    const url = new URL(request.url!, "http://studio.invalid");
    if (!url.pathname.startsWith("/api/")) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        refuse(response, 405, "method_not_allowed", "Method not allowed");
        return;
      }
      response.writeHead(200, HTML_HEADERS);
      response.end(request.method === "HEAD" ? undefined : options.html);
      return;
    }
    const origin = request.headers.origin;
    if (origin !== undefined && !origins.has(origin)) {
      refuse(response, 403, "forbidden_origin", "Cross-origin call refused");
      return;
    }
    if (url.pathname === "/api/events" && request.method === "GET") {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      response.write("retry: 1000\n\n");
      streams.add(response);
      response.on("close", () => streams.delete(response));
      return;
    }
    let body: unknown;
    if (request.method === "POST") {
      const type = request.headers["content-type"] ?? "";
      if (!type.toLowerCase().startsWith("application/json")) {
        refuse(response, 415, "unsupported_media_type", "Send JSON");
        return;
      }
      const text = await readBody(request);
      if (text === undefined) {
        refuse(response, 413, "body_too_large", "Body too large");
        return;
      }
      try {
        body = text === "" ? undefined : JSON.parse(text);
      } catch {
        refuse(response, 400, "invalid_json", "The body is not valid JSON");
        return;
      }
    }
    const answer = await options.handle({
      method: request.method!,
      path: url.pathname.slice("/api".length),
      body,
    });
    if (answer.file) {
      response.writeHead(answer.status, {
        "content-type": `${answer.file.type}; charset=utf-8`,
        "content-disposition": `attachment; filename="${answer.file.name.replaceAll('"', "")}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(String(answer.body));
      return;
    }
    send(response, answer.status, answer.body);
  }

  const server = createServer((request, response) => {
    // Every answer is written last, so a failure finds the response unsent.
    serve(request, response).catch((error: unknown) => {
      refuse(
        response,
        500,
        "internal",
        error instanceof Error ? error.message : "Studio failure"
      );
    });
  });

  return new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(options.port, STUDIO_HOST, () => {
      server.off("error", rejectPromise);
      // A TCP listener's address is always an AddressInfo.
      const { port } = server.address() as AddressInfo;
      hosts = new Set([`${STUDIO_HOST}:${port}`, `localhost:${port}`]);
      origins = new Set([...hosts].map((host) => `http://${host}`));
      resolvePromise({
        url: `http://${STUDIO_HOST}:${port}`,
        broadcast: (event, data) => {
          const message = `event: ${event}\ndata: ${encodeJson(data)}\n\n`;
          for (const stream of streams) stream.write(message);
        },
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
            server.closeAllConnections();
          }),
      });
    });
  });
}

function readBody(request: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) over = true;
      else chunks.push(chunk);
    });
    request.on("end", () =>
      resolvePromise(over ? undefined : Buffer.concat(chunks).toString("utf8"))
    );
    request.on("error", rejectPromise);
  });
}
