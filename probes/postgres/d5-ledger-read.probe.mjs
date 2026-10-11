// D5 + new defect 6: commands read only the open attempts, not the whole
// ledger, and the ledger keeps causal order for events written in the same
// millisecond. Measured by what comes back, not by how the query is spelled:
// with no attempt open, a no-op apply and status() may each read at most one
// ledger row (a sequence or summary), never the closed attempts' events.
// 1.1.0 reads every row on every command and sorts by (startedAt, eventId), so
// same-millisecond events come back in hash order.
//
// The clock is pinned to one instant per attempt (Date#toISOString), which is
// what a fast machine produces for the events of one attempt.
import { PGlite } from "@electric-sql/pglite";
import { s } from "viborm";
import { createMigrationClient, MemoryEstateStorage } from "viborm/migrations";
import { createClient } from "viborm/pglite";

export const meta = {
  id: "d5-ledger-read",
  title:
    "Commands read only open attempts, and same-millisecond ledger events keep their order",
  plan: "phase-2/D5",
  needs: [],
  source:
    "completion-plan-2026-10.md §2.3 new defect 6; code-check/postgres-transports.md#D5 ('reads the whole ledger with no WHERE or LIMIT'); src/migrations/control.ts:636-647",
};

const LEDGER = /_viborm_migration_log/i;
const ROWS_PER_COMMAND_MAX = 1;
const decoder = new TextDecoder();

/**
 * Records every statement PGlite runs, whatever API sent it (query, exec or
 * transaction), with the rows it returned: all of them reach
 * execProtocolStream, where a Parse ('P') or simple Query ('Q') message
 * carries the SQL and the replies carry the DataRows.
 */
function tap(db) {
  const send = db.execProtocolStream;
  const statements = [];
  db.execProtocolStream = async (message, options) => {
    if (message[0] === 0x50 || message[0] === 0x51) {
      const start = message[0] === 0x50 ? message.indexOf(0, 5) + 1 : 5;
      const sql = decoder.decode(
        message.subarray(start, message.indexOf(0, start))
      );
      statements.push({ text: sql.replace(/\s+/g, " ").trim(), rows: 0 });
    }
    const replies = await send.call(db, message, options);
    const last = statements.at(-1);
    if (last) last.rows += replies.filter((m) => m.name === "dataRow").length;
    return replies;
  };
  return { statements, stop: () => (db.execProtocolStream = send) };
}

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
const versions = [
  { account: s.model(fields()).map("accounts") },
  {
    account: s
      .model({ ...fields(), nickname: s.string().nullable() })
      .index(["country"])
      .map("accounts"),
  },
  {
    account: s
      .model({
        ...fields(),
        nickname: s.string().nullable(),
        referrer: s.string().nullable(),
      })
      .index(["country"])
      .index(["createdAt"])
      .map("accounts"),
  },
];

/**
 * Each attempt's events are contiguous, attempts come in apply order, each
 * ends with `applied`, and a `started` row (optional: D5 may write one ledger
 * row per group) comes first.
 */
function isCausal(events, appliedStates) {
  const attempts = [];
  for (const event of events) {
    const last = attempts.at(-1);
    if (last?.id === event.attemptId) last.kinds.push(event.kind);
    else
      attempts.push({
        id: event.attemptId,
        to: event.toState,
        kinds: [event.kind],
      });
  }
  return (
    attempts.length === appliedStates.length &&
    attempts.every(
      (a, i) =>
        (!a.kinds.includes("started") || a.kinds[0] === "started") &&
        a.kinds.at(-1) === "applied" &&
        a.to === appliedStates[i]
    )
  );
}

export default async function probe() {
  const db = new PGlite();
  const toISOString = Date.prototype.toISOString;
  try {
    const storage = new MemoryEstateStorage();
    const clients = versions.map((schema) =>
      createMigrationClient(createClient({ client: db, schema }), { storage })
    );
    const states = [];
    for (const [i, client] of clients.entries()) {
      states.push((await client.generate({ name: `v${i + 1}` })).stateId);
    }
    for (const [i, client] of clients.entries()) {
      Date.prototype.toISOString = () => `2026-10-10T12:00:0${i}.000Z`;
      await client.apply({ to: { id: states[i] } });
    }
    Date.prototype.toISOString = toISOString;

    const latest = clients.at(-1);
    const ledgerRows = async (command) => {
      const recorder = tap(db);
      try {
        const result = await command();
        const reads = recorder.statements.filter((q) => LEDGER.test(q.text));
        const rows = reads.reduce((sum, q) => sum + q.rows, 0);
        return {
          result,
          rows,
          widest: reads.sort((a, b) => b.rows - a.rows)[0],
        };
      } finally {
        recorder.stop();
      }
    };
    const noop = await ledgerRows(() => latest.apply());
    const status = await ledgerRows(() => latest.status());
    const events = await latest.log();

    const problems = [];
    for (const [label, run] of [
      ["no-op apply", noop],
      ["status()", status],
    ])
      if (run.rows > ROWS_PER_COMMAND_MAX)
        problems.push(
          `${label} read ${run.rows} ledger rows of ${events.length}, none open ("${run.widest.text.slice(0, 70)}")`
        );
    if (!isCausal(events, states))
      problems.push("log() is not in causal order for same-millisecond events");
    const evidence = `no-op ${noop.result.outcome}, unfinished ${status.result.unfinished}; log(): ${events.map((e) => e.kind).join(",")}`;
    return {
      status: problems.length === 0 ? "pass" : "fail",
      evidence:
        problems.length === 0
          ? evidence
          : `${problems.join("; ")} | ${evidence}`,
    };
  } finally {
    Date.prototype.toISOString = toISOString;
    await db.close();
  }
}
