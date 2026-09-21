// T3 measurement 2: is the catalog body EXACTLY the bytes of the introducer's
// charset, one codepoint per byte? Creates and drops only its own `tm_` tables.
import mysql from "/private/tmp/viborm-tm/node_modules/mysql2/promise.js";
const url = process.env.MYSQL_TEST_CONNECTION_STRING;
if (!url) throw new Error("no connection string");
const conn = await mysql.createConnection({ uri: url });
const codes = (s) => [...s].map((c) => c.codePointAt(0).toString(16).padStart(2, "0")).join(" ");
const TABLE = "tm_introducer_probe";

const cases = [
  ["utf8mb4_bmp", "TEXT CHARACTER SET utf8mb4", "café ☕"],
  ["utf8mb4_astral", "TEXT CHARACTER SET utf8mb4", "e\u{1F600}nd"],
  ["utf8mb3_bmp", "TEXT CHARACTER SET utf8mb3", "café ☕"],
  ["latin1_e", "TEXT CHARACTER SET latin1", "café"],
  ["ascii_plain", "TEXT CHARACTER SET ascii", "plain"],
  ["utf8mb4_mixed", "TEXT CHARACTER SET utf8mb4", "a\\b é it's\nx"],
];
await conn.query(`DROP TABLE IF EXISTS \`${TABLE}\``);
const cols = cases
  .map(([name, type, value]) => {
    const escaped = value
      .replace(/\\/g, "\\\\")
      .replace(/\n/g, "\\n")
      .replace(/'/g, "''");
    return `\`${name}\` ${type} NOT NULL DEFAULT ('${escaped}')`;
  })
  .join(", ");
await conn.query(`CREATE TABLE \`${TABLE}\` (id INT PRIMARY KEY, ${cols}) CHARACTER SET utf8mb4`);
await conn.query(`INSERT INTO \`${TABLE}\` (id) VALUES (1)`);
const [rows] = await conn.query(
  `SELECT COLUMN_NAME, COLUMN_DEFAULT, CHARACTER_SET_NAME cs FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME <> 'id' ORDER BY ORDINAL_POSITION`,
  [TABLE]
);
const [stored] = await conn.query(`SELECT * FROM \`${TABLE}\` WHERE id = 1`);
for (const r of rows) {
  const declared = cases.find(([n]) => n === r.COLUMN_NAME)[2];
  const text = r.COLUMN_DEFAULT;
  const m = /^_([A-Za-z0-9_]+)\\'([\s\S]*)\\'$/.exec(text);
  const introducer = m?.[1];
  const body = m?.[2] ?? "";
  const allBytes = [...body].every((c) => c.codePointAt(0) <= 0xff);
  let decoded = "(not one-byte-per-codepoint)";
  if (allBytes && introducer) {
    const buf = Buffer.from([...body].map((c) => c.codePointAt(0)));
    const enc = introducer.startsWith("utf8") ? "utf8" : introducer === "latin1" ? "latin1" : introducer === "ascii" ? "ascii" : null;
    decoded = enc ? JSON.stringify(buf.toString(enc)) : `(no decoder for ${introducer})`;
  }
  console.log(
    `${r.COLUMN_NAME} (col cs=${r.cs}) introducer=${introducer}\n` +
      `   declared   = ${JSON.stringify(declared)} codes=${codes(declared)}\n` +
      `   catalog    = ${JSON.stringify(text)}\n` +
      `   body codes = ${codes(body)}\n` +
      `   all<=0xFF  = ${allBytes}\n` +
      `   bytes->str = ${decoded}\n` +
      `   stored row = ${JSON.stringify(stored[0][r.COLUMN_NAME])}`
  );
}
await conn.query(`DROP TABLE IF EXISTS \`${TABLE}\``);
await conn.end();
