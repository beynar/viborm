import { connect } from "./mysqlx.mjs";
const MODE = process.argv[2]; // nolock | found
const T = "r2c_sched_tags";
const mk = (lock) => `SELECT \`q0\`.\`id\`, \`q0\`.\`name\`, \`q0\`.\`count\` FROM \`${T}\` AS \`q0\` WHERE \`q0\`.\`name\` = ? ORDER BY \`q0\`.\`id\` ASC LIMIT 1${lock ? " FOR UPDATE" : ""}`;
const ins = `INSERT INTO \`${T}\` (\`id\`, \`name\`, \`count\`) VALUES (?, ?, ?)`;
const upd = `UPDATE \`${T}\` SET \`count\` = ? WHERE \`id\` = ?`;
const say = (s) => console.log(s);
const err = (e) => `${e.code}/${e.errno}`;
const s = await connect();
await s.query(`DROP TABLE IF EXISTS \`${T}\``);
await s.query(`CREATE TABLE \`${T}\` (\`id\` VARCHAR(191) NOT NULL, \`name\` VARCHAR(191) NOT NULL, \`count\` INT NOT NULL DEFAULT 0, PRIMARY KEY (\`id\`), UNIQUE KEY \`${T}_name_key\` (\`name\`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin`);
const a = await connect(), b = await connect();
const idOf = async (c) => (await c.query("SELECT CONNECTION_ID() id"))[0][0].id;
const [aid, bid] = [await idOf(a), await idOf(b)];
async function locks(label) {
  const [rows] = await s.query(
    `SELECT t.PROCESSLIST_ID pid, l.INDEX_NAME idx, l.LOCK_TYPE typ, l.LOCK_MODE mode, l.LOCK_STATUS st, l.LOCK_DATA dat
     FROM performance_schema.data_locks l JOIN performance_schema.threads t ON t.THREAD_ID = l.THREAD_ID
     WHERE l.OBJECT_NAME = ? ORDER BY pid, idx, mode`, [T]);
  say(`## locks @ ${label}`);
  for (const r of rows) say(`   ${r.pid === aid ? "A" : r.pid === bid ? "B" : "?"}  ${r.typ} ${r.mode} ${r.st} idx=${r.idx ?? "-"} data=${r.dat ?? "-"}`);
}
if (MODE === "nolock") {
  say(`# counterfactual: probe WITHOUT 'FOR UPDATE'; each transaction commits when its own work is done (A=conn${aid} B=conn${bid})`);
  const probe = mk(false);
  await a.query("START TRANSACTION"); await b.query("START TRANSACTION");
  say(`A: probe -> ${(await a.execute(probe, ["plain-race"]))[0].length} rows`);
  say(`B: probe -> ${(await b.execute(probe, ["plain-race"]))[0].length} rows`);
  await locks("after both probes");
  let aRes = "pending", bRes = "pending";
  await a.execute(ins, ["plain-race-1", "plain-race", 1]).then(() => { aRes = "ok"; }, (e) => { aRes = err(e); });
  say(`A: INSERT 'plain-race-1' -> ${aRes}`);
  const pb = b.execute(ins, ["plain-race-2", "plain-race", 2]).then(() => { bRes = "ok"; }, (e) => { bRes = err(e); });
  await new Promise((r) => setTimeout(r, 400));
  say(`B: INSERT 'plain-race-2' -> ${bRes} (blocked on A's uncommitted key)`);
  await locks("B waiting on the duplicate key");
  await a.query("COMMIT"); say("A: COMMIT (its own operation is done)");
  await pb;
  say(`B: INSERT result -> ${bRes}`);
  await b.query("ROLLBACK"); say("B: ROLLBACK (the engine's recovery re-runs the operation)");
  // the recovery: B re-probes and takes the found arm
  await b.query("START TRANSACTION");
  const [seen] = await b.execute(mk(true), ["plain-race"]);
  say(`B: re-probe (retry) -> ${seen.length} row(s) ${JSON.stringify(seen[0] ?? null)}`);
  await b.execute(upd, [20, seen[0].id]);
  await b.query("COMMIT"); say("B: UPDATE + COMMIT (update arm)");
  say(`# final rows: ${JSON.stringify((await s.query(`SELECT id, name, count FROM \`${T}\``))[0])}`);
} else if (MODE === "found") {
  say(`# the FOUND arm: the same probe when the row EXISTS (A=conn${aid} B=conn${bid})`);
  await s.query(ins.replace("?, ?, ?", "'seed', 'plain-race', 0"));
  await a.query("START TRANSACTION");
  say(`A: probe FOR UPDATE -> ${(await a.execute(mk(true), ["plain-race"]))[0].length} row(s)`);
  await locks("after A probe (row present)");
  await a.query("ROLLBACK");
}
await s.query(`DROP TABLE IF EXISTS \`${T}\``);
await a.end(); await b.end(); await s.end();
