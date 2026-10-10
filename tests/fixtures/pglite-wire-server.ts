import { once } from "node:events";
import { createServer, type Server, type Socket } from "node:net";
import type { PGlite } from "@electric-sql/pglite";

const STARTUP_PROTOCOL = 196_608;

/** One frontend message after startup: its type byte, and for a Parse the
 * statement name it prepares (`""` is the unnamed statement). */
export interface FrontendMessage {
  readonly type: string;
  readonly statement?: string;
}

/**
 * PGlite behind a minimal PostgreSQL wire bridge on a loopback port, for
 * driving postgres.js against a real server.
 *
 * `stop()` refuses every connection the way a restarting server does,
 * `start(port)` serves the same database again, `killSessionOn(text)` kills
 * the session that sends `text` before answering it, and `frontend` records
 * every message clients send. Use one connection at a time (`max: 1`), because
 * PGlite is a single session.
 */
export function pgliteWireServer(database: PGlite) {
  const sockets = new Set<Socket>();
  const frontend: FrontendMessage[] = [];
  // PGlite is one session, so every connection's messages share one queue.
  let replies = Promise.resolve();
  let server: Server | undefined;
  let fatal: string | undefined;
  const serve = (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const startup =
          pending.length >= 8 && pending.readInt32BE(4) === STARTUP_PROTOCOL;
        const length = startup
          ? pending.readInt32BE(0)
          : pending.length >= 5
            ? pending.readInt32BE(1) + 1
            : Number.POSITIVE_INFINITY;
        if (pending.length < length) return;
        const message = pending.subarray(0, length);
        pending = pending.subarray(length);
        if (!startup) frontend.push(describeMessage(message));
        if (fatal && message.includes(fatal)) {
          // PostgreSQL ends a dead session's transaction.
          replies = replies.then(async () => {
            await database.exec("ROLLBACK");
          });
          socket.destroy();
          return;
        }
        replies = replies.then(async () => {
          const reply = await database.execProtocolRaw(message);
          if (!socket.destroyed) socket.write(reply);
        });
      }
    });
  };
  return {
    frontend,
    start: (port = 0) =>
      new Promise<number>((resolve) => {
        const listening = createServer(serve);
        server = listening;
        listening.listen(port, "127.0.0.1", () => {
          const address = listening.address();
          resolve(typeof address === "object" && address ? address.port : port);
        });
      }),
    stop: async () => {
      await Promise.all([
        ...[...sockets].map((socket) => once(socket.destroy(), "close")),
        new Promise((resolve) => server?.close(resolve)),
      ]);
      await replies;
    },
    killSessionOn: (text: string) => {
      fatal = text;
    },
  };
}

function describeMessage(message: Buffer): FrontendMessage {
  const type = String.fromCharCode(message[0] ?? 0);
  if (type !== "P") return { type };
  return {
    type,
    statement: message.subarray(5, message.indexOf(0, 5)).toString(),
  };
}
