/**
 * A Snowflake SQL API v2 server on localhost, answering as the documentation
 * says the real one does (docs.snowflake.com/en/developer-guide/sql-api):
 *
 * - `POST /api/v2/statements?requestId=…[&retry=true]` → 200 with the first
 *   partition and `resultSetMetaData`, 202 `{ code: "333334", statementHandle,
 *   statementStatusUrl }` while it runs, or 422 with the failure;
 * - `GET /api/v2/statements/<handle>` → 202 until done, then the 200;
 * - `GET /api/v2/statements/<handle>?partition=<n>` → gzip `{ data }`, with
 *   `Content-Encoding: gzip` and no metadata;
 * - `POST /api/v2/statements/<handle>/cancel`.
 *
 * Every request is recorded, so a test can say what was sent — and that
 * nothing was.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import { gzipSync } from "node:zlib";

const CANCEL = /^\/api\/v2\/statements\/([^/]+)\/cancel$/;
const STATUS = /^\/api\/v2\/statements\/([^/]+)$/;

export interface FakeColumn {
  readonly name: string;
  readonly type: string;
  readonly scale?: number;
  readonly precision?: number;
  readonly nullable?: boolean;
}

export interface FakeStatement {
  readonly statement: string;
  readonly bindings?: Record<string, { type: string; value: string | null }>;
  readonly warehouse?: string;
  readonly database?: string;
  readonly schema?: string;
  readonly role?: string;
  readonly timeout?: number;
  readonly parameters?: Record<string, string>;
}

export type FakeAnswer =
  | {
      readonly rowType: readonly FakeColumn[];
      /** One array of rows per partition; partition 0 rides the first answer. */
      readonly partitions: readonly (readonly (string | null)[])[][];
      /** How many polls answer 202 before the result. */
      readonly pending?: number;
    }
  | {
      readonly status?: number;
      readonly error: { code: string; sqlState: string; message: string };
    }
  /** Never answers until cancelled or the client gives up. */
  | { readonly hang: true };

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingMessage["headers"];
  readonly body?: FakeStatement;
}

export interface FakeSnowflake {
  readonly url: string;
  readonly requests: RecordedRequest[];
  /** The statements POSTed, in order (a retried one appears again). */
  statements(): FakeStatement[];
  /** Answer the next `count` POSTs with this HTTP status before handling them. */
  failNext(status: number, count?: number): void;
  close(): Promise<void>;
}

interface Running {
  readonly answer: FakeAnswer;
  pending: number;
}

function resultSet(
  handle: string,
  answer: Extract<FakeAnswer, { rowType: unknown }>
) {
  const rows = answer.partitions.reduce((sum, part) => sum + part.length, 0);
  return {
    resultSetMetaData: {
      numRows: rows,
      format: "jsonv2",
      partitionInfo: answer.partitions.map((part) => ({
        rowCount: part.length,
        uncompressedSize: JSON.stringify(part).length,
      })),
      rowType: answer.rowType.map((column) => ({
        name: column.name,
        database: "",
        schema: "",
        table: "",
        type: column.type,
        scale: column.scale ?? null,
        precision: column.precision ?? null,
        length: null,
        byteLength: null,
        nullable: column.nullable ?? true,
        collation: null,
      })),
    },
    data: answer.partitions[0] ?? [],
    code: "090001",
    statementStatusUrl: `/api/v2/statements/${handle}`,
    requestId: handle,
    sqlState: "00000",
    statementHandle: handle,
    message: "Statement executed successfully.",
    createdOn: 1_700_000_000_000,
  };
}

export async function startFakeSnowflake(
  respond: (statement: FakeStatement) => FakeAnswer
): Promise<FakeSnowflake> {
  const requests: RecordedRequest[] = [];
  const running = new Map<string, Running>();
  const failures: number[] = [];
  let handles = 0;

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const text = Buffer.concat(chunks).toString("utf8");
      const body =
        text.length > 0 ? (JSON.parse(text) as FakeStatement) : undefined;
      requests.push({
        method: request.method ?? "GET",
        path: `${url.pathname}${url.search}`,
        headers: request.headers,
        ...(body ? { body } : {}),
      });
      const json = (status: number, payload: unknown) => {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(payload));
      };
      const finish = (handle: string, run: Running) => {
        const { answer } = run;
        if ("hang" in answer) return; // left open: the client aborts it
        if ("error" in answer) {
          json(answer.status ?? 422, {
            ...answer.error,
            statementHandle: handle,
          });
          return;
        }
        json(200, resultSet(handle, answer));
      };
      const pending = (handle: string) =>
        json(202, {
          code: "333334",
          message:
            "Asynchronous execution in progress. Use provided query id to perform query monitoring and management.",
          statementHandle: handle,
          statementStatusUrl: `/api/v2/statements/${handle}`,
        });

      if (request.method === "POST" && url.pathname === "/api/v2/statements") {
        const status = failures.shift();
        if (status !== undefined) {
          json(status, { code: "000000", message: `HTTP ${status}` });
          return;
        }
        const handle = `01b0-${++handles}`;
        const answer = respond(body!);
        const run: Running = {
          answer,
          pending: "rowType" in answer ? (answer.pending ?? 0) : 0,
        };
        running.set(handle, run);
        if (run.pending > 0) pending(handle);
        else finish(handle, run);
        return;
      }
      const cancel = CANCEL.exec(url.pathname);
      if (request.method === "POST" && cancel) {
        json(200, { code: "000604", message: "Statement canceled." });
        return;
      }
      const poll = STATUS.exec(url.pathname);
      const run = poll ? running.get(poll[1]!) : undefined;
      if (request.method === "GET" && poll && run) {
        const partition = url.searchParams.get("partition");
        if (partition !== null && "rowType" in run.answer) {
          const data = run.answer.partitions[Number(partition)] ?? [];
          response.writeHead(200, {
            "Content-Type": "application/json",
            "Content-Encoding": "gzip",
          });
          response.end(gzipSync(JSON.stringify({ data })));
          return;
        }
        if (run.pending > 0) {
          run.pending--;
          pending(poll[1]!);
          return;
        }
        finish(poll[1]!, run);
        return;
      }
      json(404, { code: "000000", message: `no route ${url.pathname}` });
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    statements: () =>
      requests
        .filter(
          (request) =>
            request.method === "POST" &&
            request.path.startsWith("/api/v2/statements?")
        )
        .map((request) => request.body!),
    failNext: (status, count = 1) => {
      for (let index = 0; index < count; index++) failures.push(status);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A result of one partition, every column `TEXT` unless typed. */
export function rows(
  rowType: readonly FakeColumn[],
  data: readonly (readonly (string | null)[])[]
): FakeAnswer {
  return { rowType, partitions: [data.map((row) => [...row])] };
}
