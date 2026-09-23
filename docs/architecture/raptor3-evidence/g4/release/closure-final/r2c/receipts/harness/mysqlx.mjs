import { readFileSync } from "node:fs";
import mysql from "/private/tmp/viborm-r2c/node_modules/mysql2/promise.js";
export async function connect(extra = {}) {
  const u = new URL(readFileSync(process.env.CONN, "utf8").trim());
  return mysql.createConnection({
    host: u.hostname, port: +u.port,
    user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
    database: u.pathname.slice(1), multipleStatements: false, ...extra,
  });
}
