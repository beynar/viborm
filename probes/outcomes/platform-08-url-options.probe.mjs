// biome-ignore-all lint/suspicious/noBitwiseOperators: the MySQL handshake packs capability flags as bits, and native-password auth is SHA-1 XOR.
// platform-08 (tenant blocker): for viborm/pg, viborm/postgres and
// viborm/mysql2, `databaseUrl` fills only the keys it carries and explicit
// `options` win. The per-tenant shape is a URL per tenant plus a password
// from a secret. Each driver connects to an in-process fake server that
// speaks just enough of the wire protocol to capture the user and the
// password (Postgres cleartext auth; MySQL native-password scramble checked
// against the expected secret), then refuses the login.
//   fill:       URL without password + options.password  -> secret sent
//   precedence: URL with port 1 and a password + options.port/password
//               -> explicit port reached, explicit password sent
// No probe connection ever targets a real database port: the wrong port in
// the precedence case is 1, which refuses at once.
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { s } from "viborm";
import { createClient as createMysql2Client } from "viborm/mysql2";
import { createClient as createPgClient } from "viborm/pg";
import { createClient as createPostgresClient } from "viborm/postgres";

export const meta = {
  id: "platform-08-url-options",
  title:
    "pg, postgres and mysql2: the URL fills only its keys and explicit options win",
  plan: "phase-1/lane-O/tenant-blockers (platform-08)",
  needs: [],
  source:
    "adversarial-review-2026-10-09 platform-08; completion-plan-2026-10/code-check/track-a.md (platform-08); src/drivers/postgres/index.ts:180-194; src/drivers/pg/index.ts:597-600; src/drivers/shared/mysql-utils.ts:62-73",
};

const SECRET = "from-secret";
const TRAILING_NUL = /\0$/;
const USER = "probe_user";
const schema = {
  member: s.model({ id: s.string().id(), email: s.string(), seats: s.int() }),
};

const bounded = (promise, ms, label) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} exceeded ${ms} ms`)),
        ms
      );
    }),
  ]).finally(() => clearTimeout(timer));
};

/** Postgres: StartupMessage -> AuthenticationCleartextPassword -> capture 'p' -> FATAL 28P01. */
function pgHandler(socket, seen) {
  const session = {};
  seen.push(session);
  let buffer = Buffer.alloc(0);
  let started = false;
  const refuse = () => {
    const fields = Buffer.from(
      "SFATAL\0VFATAL\0C28P01\0Mprobe captured the login\0\0"
    );
    const head = Buffer.alloc(5);
    head.write("E", 0);
    head.writeInt32BE(fields.length + 4, 1);
    socket.end(Buffer.concat([head, fields]));
  };
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (!started) {
        if (buffer.length < 8 || buffer.length < buffer.readInt32BE(0)) return;
        const length = buffer.readInt32BE(0);
        const code = buffer.readInt32BE(4);
        const body = buffer.subarray(8, length);
        buffer = buffer.subarray(length);
        if (code === 80_877_103 || code === 80_877_104) {
          socket.write("N");
          continue;
        }
        const parts = body.toString("utf8").split("\0");
        for (let i = 0; i + 1 < parts.length; i += 2) {
          if (parts[i]) session[parts[i]] = parts[i + 1];
        }
        started = true;
        socket.write(Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 3]));
        continue;
      }
      if (buffer.length < 5 || buffer.length < 1 + buffer.readInt32BE(1))
        return;
      const type = String.fromCharCode(buffer[0]);
      const body = buffer.subarray(5, 1 + buffer.readInt32BE(1));
      buffer = buffer.subarray(1 + buffer.readInt32BE(1));
      if (type === "p") {
        session.password = body.toString("utf8").replace(TRAILING_NUL, "");
        refuse();
        return;
      }
    }
  });
}

const SCRAMBLE = Buffer.from("probe-scramble-20byt"); // 20 bytes
const sha1 = (data) => createHash("sha1").update(data).digest();
const nativePassword = (password) => {
  const stage1 = sha1(Buffer.from(password));
  const stage2 = sha1(Buffer.concat([SCRAMBLE, sha1(stage1)]));
  return Buffer.from(stage1.map((byte, i) => byte ^ stage2[i]));
};

/** MySQL: HandshakeV10 -> parse HandshakeResponse41 -> ERR 1045. */
function mysqlHandler(socket, seen) {
  const session = {};
  seen.push(session);
  const packet = (sequence, payload) => {
    const head = Buffer.alloc(4);
    head.writeUIntLE(payload.length, 0, 3);
    head[3] = sequence;
    return Buffer.concat([head, payload]);
  };
  const capabilities =
    0x1 |
    0x4 |
    0x8 |
    0x2_00 |
    0x20_00 |
    0x80_00 |
    (1 << 17) |
    (1 << 19) |
    (1 << 21);
  const fixed = Buffer.alloc(4 + 8 + 1 + 2 + 1 + 2 + 2 + 1 + 10);
  let at = 0;
  fixed.writeUInt32LE(1, at);
  at += 4;
  SCRAMBLE.copy(fixed, at, 0, 8);
  at += 9;
  fixed.writeUInt16LE(capabilities & 0xff_ff, at);
  at += 2;
  fixed[at] = 0x21;
  at += 1;
  fixed.writeUInt16LE(2, at);
  at += 2;
  fixed.writeUInt16LE(capabilities >>> 16, at);
  at += 2;
  fixed[at] = 21;
  socket.write(
    packet(
      0,
      Buffer.concat([
        Buffer.from([10]),
        Buffer.from("8.0.36-probe\0"),
        fixed,
        SCRAMBLE.subarray(8),
        Buffer.from("\0mysql_native_password\0"),
      ])
    )
  );
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length < 4 || buffer.length < 4 + buffer.readUIntLE(0, 3))
      return;
    const payload = buffer.subarray(4, 4 + buffer.readUIntLE(0, 3));
    const flags = payload.readUInt32LE(0);
    const userEnd = payload.indexOf(0, 32);
    session.user = payload.subarray(32, userEnd).toString("utf8");
    const authLength = payload[userEnd + 1];
    const auth = payload.subarray(userEnd + 2, userEnd + 2 + authLength);
    session.passwordSent =
      flags & 0x80_00 && authLength === 20
        ? auth.equals(nativePassword(SECRET))
          ? SECRET
          : "another password"
        : authLength === 0
          ? null
          : `${authLength}-byte auth`;
    const error = Buffer.concat([
      Buffer.from([0xff, 0x15, 0x04]),
      Buffer.from("#28000probe captured the login"),
    ]);
    socket.end(packet(2, error));
  });
}

async function fakeServer(handler) {
  const seen = [];
  const server = createServer((socket) => {
    socket.on("error", () => undefined);
    handler(socket, seen);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    seen,
    close: () => new Promise((r) => server.close(r)),
  };
}

async function attempt(open) {
  const client = open();
  try {
    await bounded(client.member.findMany(), 10_000, "query");
    return "connected";
  } catch (error) {
    return `${error?.code ?? error?.name}`;
  } finally {
    await bounded(client.$disconnect(), 5000, "disconnect").catch(
      () => undefined
    );
  }
}

const DRIVERS = {
  pg: { scheme: "postgres", handler: pgHandler, create: createPgClient },
  postgres: {
    scheme: "postgres",
    handler: pgHandler,
    create: createPostgresClient,
  },
  mysql2: {
    scheme: "mysql",
    handler: mysqlHandler,
    create: createMysql2Client,
  },
};

async function check(name) {
  const driver = DRIVERS[name];
  const server = await fakeServer(driver.handler);
  try {
    const password = (session) =>
      session?.password ?? session?.passwordSent ?? null;
    const fillError = await attempt(() =>
      driver.create({
        schema,
        databaseUrl: `${driver.scheme}://${USER}@127.0.0.1:${server.port}/probe_db`,
        options: { password: SECRET },
      })
    );
    const filled = server.seen.at(-1);
    const fill = filled
      ? `user ${filled.user}, password ${JSON.stringify(password(filled))}`
      : `fake server saw no connection (client error ${fillError})`;
    const before = server.seen.length;
    const precedenceError = await attempt(() =>
      driver.create({
        schema,
        databaseUrl: `${driver.scheme}://${USER}:url-pass@127.0.0.1:1/probe_db`,
        options: { port: server.port, password: SECRET },
      })
    );
    const reached =
      server.seen.length > before ? server.seen.at(-1) : undefined;
    const precedence = reached
      ? `explicit port reached, password ${JSON.stringify(password(reached))}`
      : `explicit port ignored, fake server saw no connection (client error ${precedenceError})`;
    const ok =
      filled?.user === USER &&
      password(filled) === SECRET &&
      reached !== undefined &&
      password(reached) === SECRET;
    return {
      ok,
      line: `${name}: fill -> ${fill}; precedence -> ${precedence}`,
    };
  } finally {
    await server.close();
  }
}

export default async function probe() {
  const results = [];
  for (const name of Object.keys(DRIVERS)) results.push(await check(name));
  return {
    status: results.every((result) => result.ok) ? "pass" : "fail",
    evidence: results.map((result) => result.line).join("; "),
  };
}
