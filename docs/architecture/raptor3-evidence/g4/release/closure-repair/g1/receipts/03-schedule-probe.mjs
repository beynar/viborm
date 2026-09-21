// Records the causal schedule of the competing-upserts cell: while the cell
// runs, poll InnoDB for LOCK WAITs and print the waiting statement, the lock
// it waits for and the statement of the transaction that holds it. The
// connection string is read from its file and never printed.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import mysql from "mysql2/promise";

const url = readFileSync(process.argv[2], "utf8").trim();
const out = process.argv[3];
const lines = [];
const log = (text) => {
  lines.push(text);
  writeFileSync(out, `${lines.join("\n")}\n`);
};

const child = spawn(
  process.execPath,
  [
    "scripts/run-vitest-safe.mjs",
    "run",
    "--workspace",
    "vitest.workspace.ts",
    "--project=provider-mysql2",
    "tests/providers/docker/mysql2-writes-raw.test.ts",
    "-t",
    process.argv[4] ?? "competing upserts identify their branches",
  ],
  {
    cwd: process.cwd(),
    env: { ...process.env, MYSQL_TEST_CONNECTION_STRING: url },
    stdio: ["ignore", "pipe", "pipe"],
  }
);
let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk;
});
child.stderr.on("data", (chunk) => {
  output += chunk;
});

const watcher = await mysql.createConnection(url);
const seen = new Set();
const poll = async () => {
  const [rows] = await watcher.query(`
    SELECT w.REQUESTING_ENGINE_TRANSACTION_ID AS waiting_trx,
           w.BLOCKING_ENGINE_TRANSACTION_ID  AS blocking_trx,
           rl.LOCK_TYPE AS lock_type, rl.LOCK_MODE AS lock_mode,
           rl.OBJECT_NAME AS object_name, rl.INDEX_NAME AS index_name,
           rl.LOCK_DATA AS lock_data,
           rt.trx_query AS waiting_query, bt.trx_query AS blocking_query,
           bt.trx_state AS blocking_state
    FROM performance_schema.data_lock_waits w
    JOIN performance_schema.data_locks rl
      ON rl.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID
    JOIN information_schema.innodb_trx rt
      ON rt.trx_id = w.REQUESTING_ENGINE_TRANSACTION_ID
    LEFT JOIN information_schema.innodb_trx bt
      ON bt.trx_id = w.BLOCKING_ENGINE_TRANSACTION_ID
  `);
  for (const row of rows) {
    const key = JSON.stringify(row);
    if (seen.has(key)) continue;
    seen.add(key);
    log(`LOCK WAIT  ${JSON.stringify(row, null, 2)}`);
  }
};

const timer = setInterval(() => {
  poll().catch((error) => log(`poll error: ${error.message}`));
}, 500);

const code = await new Promise((resolve) => child.on("close", resolve));
clearInterval(timer);
await watcher.end();
log(`vitest exit code ${code}`);
log("--- vitest output (tail) ---");
log(output.split("\n").slice(-40).join("\n"));
