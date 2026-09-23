// T3 measurement 4: exactly which escapes MySQL's COLUMN_TYPE printer writes
// for an enum member. Creates and drops only its own `tm_` table. Each member
// carries a distinct prefix because an enum's members must differ under the
// column collation, which ignores control characters.
import mysql from "/private/tmp/viborm-tm/node_modules/mysql2/promise.js";
const url = process.env.MYSQL_TEST_CONNECTION_STRING;
if (!url) throw new Error("no connection string");
const conn = await mysql.createConnection({ uri: url });
const TABLE = "tm_enum_printer";
const NUL = String.fromCharCode(0);
const CTRLZ = String.fromCharCode(26);
const BACKSPACE = String.fromCharCode(8);
const ESCAPES = new Map([
  ["\\", "\\\\"],
  ["\n", "\\n"],
  ["\r", "\\r"],
  [NUL, "\\0"],
  [CTRLZ, "\\Z"],
]);
const spell = (v) => {
  let out = "";
  for (const ch of v) out += ESCAPES.get(ch) ?? ch;
  return `'${out.replace(/'/g, "''")}'`;
};
const VALUES = [
  ["backslash", "p1a\\b"],
  ["newline", "p2a\nb"],
  ["carriage", "p3a\rb"],
  ["nul", `p4a${NUL}b`],
  ["ctrlz", `p5a${CTRLZ}b`],
  ["tab", "p6a\tb"],
  ["backspace", `p7a${BACKSPACE}b`],
  ["quote", 'say "hi"'],
  ["apostrophe", "it's"],
  ["percent", "100%"],
  ["unicode", "café ☕"],
  ["astral", "e\u{1F600}nd"],
];
await conn.query(`DROP TABLE IF EXISTS \`${TABLE}\``);
const members = VALUES.map(([, v]) => spell(v)).join(", ");
await conn.query(
  `CREATE TABLE \`${TABLE}\` (id INT PRIMARY KEY, kind ENUM(${members}) NOT NULL)`
);
const [rows] = await conn.query(
  `SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'kind'`,
  [TABLE]
);
const ct = rows[0].COLUMN_TYPE;
console.log(`COLUMN_TYPE = ${JSON.stringify(ct)}`);
console.log(
  `codes = ${[...ct].map((c) => c.codePointAt(0).toString(16).padStart(2, "0")).join(" ")}`
);
for (const [i, [name, v]] of VALUES.entries()) {
  await conn.execute(`INSERT INTO \`${TABLE}\` (id, kind) VALUES (?, ?)`, [i, v]);
  const [back] = await conn.execute(
    `SELECT kind FROM \`${TABLE}\` WHERE id = ?`,
    [i]
  );
  console.log(
    `  ${name}: declared ${JSON.stringify(v)} stored ${JSON.stringify(back[0].kind)} ${back[0].kind === v ? "OK" : "DIFFERENT"}`
  );
}
await conn.query(`DROP TABLE IF EXISTS \`${TABLE}\``);
await conn.end();
