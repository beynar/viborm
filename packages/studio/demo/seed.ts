// Creates the demo tables and fills them: `npx jiti studio/demo/seed.ts sqlite|pg`.
import { createMigrationClient } from "viborm/migrations";

const target = process.argv[2] === "pg" ? "pg" : "sqlite";
const { client } = await import(
  target === "pg" ? "./pg.config.ts" : "./sqlite.config.ts"
);

// Additive on an empty database: push needs no consent.
await createMigrationClient(client).push();

await client.$transaction(async (tx: any) => {
  for (const model of ["post", "profile", "tag", "user"]) {
    await tx[model].deleteMany({});
  }
});

const people = [
  [
    "Ada Lovelace",
    "admin",
    "Wrote the first program.",
    "https://example.com/ada",
  ],
  ["Alan Turing", "author", "Machines and minds.", null],
  [
    "Grace Hopper",
    "author",
    "Compilers, and a moth.",
    "https://example.com/grace",
  ],
  ["Edsger Dijkstra", "reader", null, null],
  ["Barbara Liskov", "author", "Substitution.", null],
  [
    "Donald Knuth",
    "reader",
    "Art of programming.",
    "https://example.com/knuth",
  ],
] as const;
const labels = [
  "math",
  "history",
  "compilers",
  "theory",
  "hardware",
  "essays",
  "languages",
  "proofs",
];

const tags: { id: number }[] = [];
for (const label of labels)
  tags.push(await client.tag.create({ data: { label } }));

let n = 0;
for (const [name, role, bio, website] of people) {
  const email = `${name.split(" ")[0]!.toLowerCase()}@example.com`;
  const user = await client.user.create({
    data: {
      email,
      name,
      role,
      karma: BigInt(1000 * (n + 1)) * 1_000_000_007n,
      birthday: new Date(Date.UTC(1815 + 20 * people.findIndex(([who]) => who === name), 11, 10)),
      ...(bio === null && website === null
        ? {}
        : { profile: { create: { bio, website } } }),
    },
  });
  for (let i = 0; i < 3 + (n % 3); i++) {
    n++;
    await client.post.create({
      data: {
        title: `${name.split(" ")[1]} notes #${i + 1}`,
        body: `Draft ${i + 1} by ${name}.`,
        published: i % 2 === 0,
        publishedAt: i % 2 === 0 ? new Date(Date.UTC(2026, 9, 1 + i, 9, 30)) : null,
        rating: i % 3 === 0 ? null : `${(n % 5) + 0.25}`,
        metadata: { words: 120 * (i + 1), lang: "en" },
        authorId: user.id,
        tags: {
          connect: [
            { id: tags[n % tags.length]!.id },
            { id: tags[(n * 3) % tags.length]!.id },
          ],
        },
      },
    });
  }
}
console.log(
  `Seeded ${target}: ${people.length} users, ${n} posts, ${labels.length} tags.`
);
await client.$disconnect();
