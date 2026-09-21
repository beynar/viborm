import { connect } from "./mysqlx.mjs";
const c = await connect();
const [rows] = await c.query(
  "SELECT thread_id, event_time, command_type, CONVERT(argument USING utf8mb4) AS q FROM mysql.general_log WHERE command_type IN ('Query','Execute','Prepare','Close stmt') ORDER BY event_time, thread_id"
);
for (const r of rows) console.log(`${r.thread_id}\t${new Date(r.event_time).toISOString()}\t${r.command_type}\t${String(r.q).replace(/\s+/g, " ")}`);
await c.end();
