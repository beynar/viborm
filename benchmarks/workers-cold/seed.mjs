/**
 * The D1 seed every arm reads: 100 users and 1,000 posts (the same shape as
 * benchmarks/probe-cold.mjs). Prints one SQL script for `cf d1 query`:
 *
 *   cf d1 query <database-id> --sql "$(node benchmarks/workers-cold/seed.mjs)"
 */
const q = (value) =>
  value === null
    ? "NULL"
    : typeof value === "number"
      ? String(value)
      : `'${value}'`;

const statements = [
  "CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, email TEXT NOT NULL, age INTEGER)",
  "CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT, published INTEGER NOT NULL, views INTEGER NOT NULL, authorId TEXT NOT NULL)",
];
const users = [];
for (let i = 0; i < 100; i++)
  users.push(
    `(${q(`u${i}`)},${q(i % 7 === 0 ? null : `User ${i}`)},${q(`u${i}@x.com`)},${20 + (i % 50)})`
  );
statements.push(`INSERT INTO users VALUES ${users.join(",")}`);
// D1 caps one statement's size: insert posts in chunks of 250.
for (let chunk = 0; chunk < 1000; chunk += 250) {
  const posts = [];
  for (let i = chunk; i < chunk + 250; i++)
    posts.push(
      `(${q(`p${i}`)},${q(`Post ${i}`)},${q(`content ${i}`)},${i % 2},${i},${q(`u${i % 100}`)})`
    );
  statements.push(`INSERT INTO posts VALUES ${posts.join(",")}`);
}
process.stdout.write(statements.join(";"));
