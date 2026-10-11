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
 * When an armed cut kills the session. `"before"`: the statement never runs.
 * `"after"`: the whole request runs, through its Sync, as it does on a server
 * that already read it, and the session dies before the reply leaves: a COMMIT
 * commits and the client never learns it.
 */
export type CutPoint = "before" | "after";

/**
 * PGlite behind a minimal PostgreSQL wire bridge on a loopback port, for
 * driving postgres.js and node-postgres against a real server.
 *
 * `stop()` refuses every connection the way a restarting server does,
 * `start(port)` serves the same database again, `killSessionOn(text, at)` kills
 * the next session that sends `text`, once, and resolves when it did, and
 * `frontend` records every message clients send. A killed or stopped session
 * ends as a PostgreSQL backend does: its transaction rolls back and its session
 * advisory locks are released. Use one connection at a time (`max: 1`),
 * because PGlite is a single session.
 */
export function pgliteWireServer(database: PGlite) {
  const sockets = new Set<Socket>();
  const frontend: FrontendMessage[] = [];
  // PGlite is one session, so every connection's messages share one queue.
  let replies = Promise.resolve();
  let server: Server | undefined;
  let armed: { text: string; at: CutPoint; fired: () => void } | undefined;
  const endSession = () => {
    replies = replies.then(async () => {
      await database.exec("ROLLBACK; SELECT pg_advisory_unlock_all()");
    });
  };
  const serve = (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    const kill = (fired: () => void) => {
      socket.destroy();
      endSession();
      replies = replies.then(fired);
    };
    let pending = Buffer.alloc(0);
    // An "after" cut that matched on this socket: from its Execute (or simple
    // Query) on, every reply goes to nobody, and its Sync ends the session.
    let after: (() => void) | undefined;
    let silent = false;
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
        const described = startup ? undefined : describeMessage(message);
        if (described) frontend.push(described);
        if (armed && message.includes(armed.text)) {
          const { at, fired } = armed;
          armed = undefined;
          if (at === "before") return kill(fired);
          after = fired;
        }
        const type = described?.type;
        silent ||= after !== undefined && (type === "E" || type === "Q");
        const quiet = silent;
        replies = replies.then(async () => {
          const reply = await database.execProtocolRaw(message);
          if (!(quiet || socket.destroyed)) socket.write(reply);
        });
        if (after && quiet && (type === "S" || type === "Q")) {
          return kill(after);
        }
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
      endSession();
      await replies;
    },
    killSessionOn: (text: string, at: CutPoint = "before") =>
      new Promise<void>((fired) => {
        armed = { text, at, fired };
      }),
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
