import { connect } from "./mysqlx.mjs";
const LOCKING = process.argv[2] !== "nolock";
const T = "r2c_sched_tags";
const probe = `SELECT \`q0\`.\`id\`, \`q0\`.\`name\`, \`q0\`.\`count\` FROM \`${T}\` AS \`q0\` WHERE \`q0\`.\`name\` = ? ORDER BY \`q0\`.\`id\` ASC LIMIT 1${LOCKING ? " FOR UPDATE" : ""}`;
const ins = `INSERT INTO \`${T}\` (\`id\`, \`name\`, \`count\`) VALUES (?, ?, ?)`;
const out = [];
const say = (s) => { out.push(s); console.log(s); };

const s = await connect();
await s.query(`DROP TABLE IF EXISTS \`${T}\``);
await s.query(`CREATE TABLE \`${T}\` (\`id\` VARCHAR(191) NOT NULL, \`name\` VARCHAR(191) NOT NULL, \`count\` INT NOT NULL DEFAULT 0, PRIMARY KEY (\`id\`), UNIQUE KEY \`${T}_name_key\` (\`name\`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin`);

const a = await connect(), b = await connect();
const idOf = async (c) => (await c.query("SELECT CONNECTION_ID() id"))[0][0].id;
const [aid, bid] = [await idOf(a), await idOf(b)];
say(`# schedule mode=${LOCKING ? "FOR UPDATE (engine today)" : "plain read (counterfactual)"} A=conn${aid} B=conn${bid}`);

async function locks(label) {
  const [rows] = await s.query(
    `SELECT t.PROCESSLIST_ID pid, l.OBJECT_NAME tbl, l.INDEX_NAME idx, l.LOCK_TYPE typ, l.LOCK_MODE mode, l.LOCK_STATUS st, l.LOCK_DATA dat
     FROM performance_schema.data_locks l JOIN performance_schema.threads t ON t.THREAD_ID = l.THREAD_ID
     WHERE l.OBJECT_NAME = ? ORDER BY pid, idx, mode`, [T]);
  say(`## locks @ ${label}`);
  for (const r of rows) say(`   ${r.pid === aid ? "A" : r.pid === bid ? "B" : "?" }  ${r.typ} ${r.mode} ${r.st} idx=${r.idx ?? "-"} data=${r.dat ?? "-"}`);
  const [w] = await s.query(
    `SELECT rt.PROCESSLIST_ID req, bt.PROCESSLIST_ID blk, w.REQUESTING_ENGINE_LOCK_ID r, w.BLOCKING_ENGINE_LOCK_ID bl
     FROM performance_schema.data_lock_waits w
     JOIN performance_schema.threads rt ON rt.THREAD_ID = w.REQUESTING_THREAD_ID
     JOIN performance_schema.threads bt ON bt.THREAD_ID = w.BLOCKING_THREAD_ID`);
  for (const r of w) say(`   WAIT: ${r.req === aid ? "A" : "B"} blocked by ${r.blk === aid ? "A" : "B"}`);
}

const err = (e) => `${e.code}/${e.errno}`;
await a.query("START TRANSACTION"); say("A: START TRANSACTION");
await b.query("START TRANSACTION"); say("B: START TRANSACTION");
const [ra] = await a.execute(probe, ["plain-race"]); say(`A: probe -> ${ra.length} rows`);
await locks("after A probe");
const [rb] = await b.execute(probe, ["plain-race"]); say(`B: probe -> ${rb.length} rows`);
await locks("after B probe");

let aRes = "pending", bRes = "pending";
const pa = a.execute(ins, ["plain-race-1", "plain-race", 1]).then(() => { aRes = "ok"; }, (e) => { aRes = err(e); });
await new Promise((r) => setTimeout(r, 400));
say(`A: INSERT 'plain-race-1' -> ${aRes}`);
await locks("after A insert");
const pb = b.execute(ins, ["plain-race-2", "plain-race", 2]).then(() => { bRes = "ok"; }, (e) => { bRes = err(e); });
await Promise.allSettled([pa, pb]);
say(`A: INSERT result -> ${aRes}`);
say(`B: INSERT 'plain-race-2' -> ${bRes}`);
if (aRes === "ok" && bRes === "pending") { /* unreachable */ }
// let the survivor commit, then let the other retry its probe (the engine's recovery shape)
for (const [n, c, res] of [["A", a, aRes], ["B", b, bRes]]) {
  if (res === "ok") { await c.query("COMMIT"); say(`${n}: COMMIT`); }
  else { await c.query("ROLLBACK"); say(`${n}: ROLLBACK`); }
}
const [final] = await s.query(`SELECT id, name, count FROM \`${T}\``);
say(`# final rows: ${JSON.stringify(final)}`);
if (LOCKING) {
  const [st] = await s.query("SHOW ENGINE INNODB STATUS");
  const text = st[0].Status;
  const i = text.indexOf("LATEST DETECTED DEADLOCK");
  const j = text.indexOf("TRANSACTIONS", i);
  say("## SHOW ENGINE INNODB STATUS — LATEST DETECTED DEADLOCK");
  say(i >= 0 ? text.slice(i, j > i ? j : i + 3000) : "(none recorded)");
}
await s.query(`DROP TABLE IF EXISTS \`${T}\``);
await a.end(); await b.end(); await s.end();
