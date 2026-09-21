import { connect } from "./mysqlx.mjs";
const c = await connect();
const mode = process.argv[2];
if (mode === "on") {
  await c.query("SET GLOBAL log_output='TABLE'");
  await c.query("TRUNCATE TABLE mysql.general_log");
  await c.query("SET GLOBAL general_log=ON");
  console.log("general log ON (table)");
} else if (mode === "off") {
  await c.query("SET GLOBAL general_log=OFF");
  console.log("general log OFF");
} else if (mode === "dump") {
  const [rows] = await c.query(
    "SELECT thread_id, event_time, CONVERT(argument USING utf8mb4) AS q FROM mysql.general_log WHERE command_type='Query' ORDER BY event_time, thread_id"
  );
  for (const r of rows) console.log(`${r.thread_id}\t${new Date(r.event_time).toISOString()}\t${String(r.q).replace(/\s+/g, " ")}`);
} else if (mode === "truncate") {
  await c.query("TRUNCATE TABLE mysql.general_log");
  console.log("truncated");
}
await c.end();
