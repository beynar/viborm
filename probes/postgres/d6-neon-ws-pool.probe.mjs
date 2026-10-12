// biome-ignore-all lint/suspicious/noBitwiseOperators: RFC 6455 frames pack the opcode and the mask bit as bits, and unmasking is a byte XOR.
// D6 (runtime part): a Neon WebSocket `Pool` on a direct (non-pooler) endpoint
// carries migrations through viborm/pg: v1 then v2 apply, and no advisory lock
// is left behind. 1.1.0 already runs it (review E04); the type-level half of D6
// (accepted by the types on the newest @types/pg) is a type test, not a probe.
//
// Neon's WebSocket proxy is emulated in-process: a minimal RFC 6455 relay on
// loopback (neonConfig.wsProxy) carries the PostgreSQL protocol to the real
// server behind ctx.pgUrl, as Neon's proxy does in front of a direct endpoint.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import net from "node:net";
import { Pool as NeonPool, neonConfig } from "@neondatabase/serverless";
import pg from "pg";
import { s } from "viborm";
import { createMigrationClient, MemoryEstateStorage } from "viborm/migrations";
import { createClient } from "viborm/pg";

export const meta = {
  id: "d6-neon-ws-pool",
  title:
    "A Neon WebSocket Pool on a direct endpoint applies migrations through viborm/pg without leaking the lock",
  plan: "phase-2/D6",
  needs: ["pg"],
  source:
    "pg-migrations-from-durable-objects-2026-10-10/evidence/pooling/proj/e04-neon-ws.mjs + wsrelay.mjs (E04); code-check/postgres-transports.md#D6; src/drivers/pg/index.ts:177-185, 550-580",
};

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const fields = () => ({
  id: s.string().id(),
  email: s.string().unique(),
  name: s.string(),
  status: s.enum(["trial", "active", "churned"]).default("trial"),
  balance: s.int().default(0),
  score: s.number().nullable(),
  settings: s.json().nullable(),
  country: s.string().default("FR"),
  age: s.int().nullable(),
  verified: s.boolean().default(false),
  notes: s.string().nullable(),
  lastSeenAt: s.dateTime().nullable(),
  deletedAt: s.dateTime().nullable(),
  createdAt: s.dateTime().now(),
  updatedAt: s.dateTime().updatedAt(),
});
const v1 = { account: s.model(fields()).map("accounts") };
const v2 = {
  account: s
    .model({ ...fields(), nickname: s.string().nullable() })
    .index(["country"])
    .map("accounts"),
};

/** One unmasked binary frame from the relay to the client. */
function frame(payload) {
  const size = payload.length;
  const header =
    size < 126
      ? Buffer.from([0x82, size])
      : size < 65_536
        ? Buffer.alloc(4)
        : Buffer.alloc(10);
  if (size >= 126 && size < 65_536) {
    header[0] = 0x82;
    header[1] = 126;
    header.writeUInt16BE(size, 2);
  } else if (size >= 65_536) {
    header[0] = 0x82;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(size), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Decodes complete masked client frames; returns [{ opcode, payload }] and keeps the remainder. */
function unframer() {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const frames = [];
    for (;;) {
      if (buffer.length < 2) break;
      const opcode = buffer[0] & 0x0f;
      let size = buffer[1] & 0x7f;
      let offset = 2;
      if (size === 126) {
        if (buffer.length < 4) break;
        size = buffer.readUInt16BE(2);
        offset = 4;
      } else if (size === 127) {
        if (buffer.length < 10) break;
        size = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const masked = (buffer[1] & 0x80) !== 0;
      const end = offset + (masked ? 4 : 0) + size;
      if (buffer.length < end) break;
      const payload = Buffer.from(buffer.subarray(end - size, end));
      if (masked) {
        const mask = buffer.subarray(offset, offset + 4);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      }
      frames.push({ opcode, payload });
      buffer = buffer.subarray(end);
    }
    return frames;
  };
}

/** Neon-style WebSocket proxy: ws://host/v2?address=<db host:port> relays raw bytes to that address. */
async function startWsRelay(target) {
  const sockets = new Set();
  const server = createServer((_req, res) => res.writeHead(426).end());
  server.on("upgrade", (req, client) => {
    const accept = createHash("sha1")
      .update(`${req.headers["sec-websocket-key"]}${WS_GUID}`)
      .digest("base64");
    client.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    const upstream = net.connect(target);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("error", () => undefined);
    }
    const decode = unframer();
    client.on("data", (chunk) => {
      for (const { opcode, payload } of decode(chunk)) {
        if (opcode === 0x8) return client.end(Buffer.from([0x88, 0]));
        if (opcode === 0x9)
          client.write(
            Buffer.concat([Buffer.from([0x8a, payload.length]), payload])
          );
        else if (opcode === 0x0 || opcode === 0x1 || opcode === 0x2)
          upstream.write(payload);
      }
    });
    upstream.on("data", (chunk) => client.write(frame(chunk)));
    upstream.on("close", () => client.end(Buffer.from([0x88, 0])));
    client.on("close", () => upstream.destroy());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    close() {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

const settle = (promise, ms) =>
  Promise.race([
    promise.then(
      (value) => ({ ok: true, text: value?.outcome ?? "ok" }),
      (error) => ({
        ok: false,
        text: `${error?.code ?? error?.name} ${String(error?.message).slice(0, 80)}`,
      })
    ),
    new Promise((resolve) =>
      setTimeout(
        () => resolve({ ok: false, text: `pending after ${ms} ms` }),
        ms
      ).unref()
    ),
  ]);

export default async function probe(ctx) {
  const admin = new pg.Client({
    connectionString: ctx.pgUrl,
    connectionTimeoutMillis: 5000,
    statement_timeout: 20_000,
  });
  await admin.connect();
  const name = `probe_d6_neonws_${Date.now().toString(36)}`;
  const base = new URL(ctx.pgUrl);
  const relay = await startWsRelay({
    host: base.hostname,
    port: Number(base.port || 5432),
  });
  const saved = {
    wsProxy: neonConfig.wsProxy,
    useSecureWebSocket: neonConfig.useSecureWebSocket,
    pipelineConnect: neonConfig.pipelineConnect,
  };
  let neon;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    neonConfig.wsProxy = (host, port) =>
      `127.0.0.1:${relay.port}/v2?address=${host}:${port}`;
    neonConfig.useSecureWebSocket = false;
    neonConfig.pipelineConnect = false;
    const url = new URL(ctx.pgUrl);
    url.pathname = `/${name}`;
    url.search = "";
    neon = new NeonPool({ connectionString: url.toString(), ssl: false });
    neon.on("error", () => undefined);
    const storage = new MemoryEstateStorage();
    const first = createMigrationClient(
      createClient({ pool: neon, schema: v1 }),
      { storage }
    );
    const second = createMigrationClient(
      createClient({ pool: neon, schema: v2 }),
      { storage }
    );
    await first.generate({ name: "v1" });
    const applyV1 = await settle(first.apply(), 20_000);
    await second.generate({ name: "v2" });
    const applyV2 = await settle(second.apply(), 20_000);
    const status = await settle(second.status(), 10_000);
    const locks = (
      await admin.query(
        `SELECT count(*)::int AS n FROM pg_catalog.pg_locks l JOIN pg_catalog.pg_database d ON d.oid = l.database
         WHERE l.locktype = 'advisory' AND d.datname = $1`,
        [name]
      )
    ).rows[0].n;
    const ok =
      applyV1.text === "applied" &&
      applyV2.text === "applied" &&
      status.ok &&
      locks === 0;
    return {
      status: ok ? "pass" : "fail",
      evidence: `apply v1: ${applyV1.text}; apply v2: ${applyV2.text}; status: ${status.ok ? "ok" : status.text}; advisory locks left: ${locks}`,
    };
  } finally {
    Object.assign(neonConfig, saved);
    await settle(neon?.end() ?? Promise.resolve(), 3000);
    relay.close();
    await admin
      .query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
      .catch(() => undefined);
    await admin.end();
  }
}
