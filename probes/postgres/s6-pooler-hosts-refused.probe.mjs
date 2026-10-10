// S6 (decision 10): effectful migration commands are refused BEFORE ANY I/O when
// the transport cannot hold the lock: a Cloudflare Hyperdrive host
// (*.hyperdrive.local) or a Neon `-pooler` endpoint, whatever driver carries it
// (pg URL, pg host option, a supplied pg Pool, postgres.js, a Neon WebSocket
// Pool). Read-only status() and application queries stay admitted. 1.1.0
// admits all of them (admission checks only that the driver can pin a session).
//
// Pure admission check: every outbound TCP connect is intercepted and failed
// (and counted), so no DNS lookup or network traffic leaves the process.
import net from "node:net";
import { Pool as NeonPool } from "@neondatabase/serverless";
import pg from "pg";
import { s } from "viborm";
import { createMigrationClient, MemoryEstateStorage } from "viborm/migrations";
import { createClient as pgClient } from "viborm/pg";
import { createClient as postgresClient } from "viborm/postgres";

export const meta = {
  id: "s6-pooler-hosts-refused",
  title:
    "Hyperdrive and Neon -pooler hosts are refused for effectful migration commands before any I/O",
  plan: "phase-1/P/S6",
  needs: [],
  source:
    "code-check/postgres-transports.md#S6; pg-migrations-from-durable-objects-2026-10-10/lanes/pooling.md PL-04 (E04, E08); src/migrations/admission.ts:154-177",
};

const HYPERDRIVE = "4f1c0e4b2a9d4c3e8b7a6f5e4d3c2b1a.hyperdrive.local";
const NEON_POOLER = "ep-quiet-sky-a1b2c3d4-pooler.eu-central-1.aws.neon.tech";
const url = (host) => `postgres://app:secret@${host}:5432/app`;
const TYPED = /^V\d+$/;

const schema = {
  account: s
    .model({
      id: s.string().id(),
      email: s.string().unique(),
      name: s.string(),
      status: s.enum(["trial", "active", "churned"]).default("trial"),
      balance: s.int().default(0),
      settings: s.json().nullable(),
      country: s.string().default("FR"),
      verified: s.boolean().default(false),
      notes: s.string().nullable(),
      deletedAt: s.dateTime().nullable(),
      createdAt: s.dateTime().now(),
      updatedAt: s.dateTime().updatedAt(),
    })
    .map("accounts"),
};

const transports = [
  [
    "pg databaseUrl (Hyperdrive)",
    () => pgClient({ databaseUrl: url(HYPERDRIVE), schema }),
  ],
  [
    "pg options.host (Hyperdrive)",
    () =>
      pgClient({
        options: { host: HYPERDRIVE, user: "app", database: "app" },
        schema,
      }),
  ],
  [
    "pg supplied Pool (Neon -pooler)",
    () =>
      pgClient({
        pool: new pg.Pool({ connectionString: url(NEON_POOLER) }),
        schema,
      }),
  ],
  [
    "postgres.js databaseUrl (Neon -pooler)",
    () => postgresClient({ databaseUrl: url(NEON_POOLER), schema }),
  ],
  [
    "Neon WebSocket Pool (-pooler)",
    () =>
      pgClient({
        pool: new NeonPool({ connectionString: url(NEON_POOLER) }),
        schema,
      }),
  ],
];

let connects = 0;
async function attempt(run) {
  const before = connects;
  try {
    await run();
    return { io: connects - before, code: "ok" };
  } catch (error) {
    return { io: connects - before, code: error?.code ?? error?.name };
  }
}

export default async function probe() {
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function blocked() {
    connects += 1;
    setImmediate(() =>
      this.destroy(
        Object.assign(new Error("probe: outbound TCP blocked"), {
          code: "ECONNREFUSED",
        })
      )
    );
    return this;
  };
  try {
    const storage = new MemoryEstateStorage();
    await createMigrationClient(transports[0][1](), { storage }).generate({
      name: "v1",
    });
    const problems = [];
    const lines = [];
    for (const [label, make] of transports) {
      const client = make();
      const migrations = createMigrationClient(client, { storage });
      const apply = await attempt(() => migrations.apply());
      const verify = await attempt(() => migrations.verify());
      const push = await attempt(() => createMigrationClient(make()).push());
      const status = await attempt(() => migrations.status());
      const query = await attempt(() => client.account.findMany({ take: 1 }));
      const admitted = [
        ["apply", apply],
        ["verify", verify],
        ["push", push],
      ]
        .filter(([, r]) => r.io > 0 || !TYPED.test(r.code))
        .map(([name]) => name);
      if (admitted.length > 0)
        problems.push(`${label}: ${admitted.join("/")} admitted`);
      if (status.io === 0) problems.push(`${label}: status() refused`);
      if (query.io === 0) problems.push(`${label}: application query refused`);
      lines.push(
        `${label}: apply ${apply.code}+${apply.io}io verify ${verify.code}+${verify.io}io push ${push.code}+${push.io}io status ${status.io}io query ${query.io}io`
      );
    }
    return {
      status: problems.length === 0 ? "pass" : "fail",
      evidence:
        problems.length === 0
          ? lines.join(" | ")
          : `${problems.join("; ")} | ${lines.join(" | ")}`,
    };
  } finally {
    net.Socket.prototype.connect = connect;
  }
}
