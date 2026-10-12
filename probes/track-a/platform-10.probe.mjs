// platform-10: a supplied PGlite created from another module copy (here the
// CommonJS build, whose class is not the ESM class viborm imports) is either
// accepted, or refused with an error that names the duplicate-copy cause —
// never the internal "nested provider state outside TransactionBoundDriver".
import { createRequire } from "node:module";
import { PGlite as EsmPGlite } from "@electric-sql/pglite";
import { s } from "viborm";
import { createMigrationClient } from "viborm/migrations";
import { createClient } from "viborm/pglite";

export const meta = {
  id: "platform-10",
  title:
    "Supplied PGlite from another module copy is accepted or refused by name",
  plan: "track-a/platform-10",
  needs: [],
  source:
    "docs/architecture/adversarial-review-2026-10-09/lanes/platform.md platform-10 (probes/p15c.out, p15d.out); src/drivers/pglite/index.ts:211,259",
};

const note = s.model({ id: s.int().id(), body: s.string() }).map("note");
const NAMES_COPY = /cop(y|ies)|duplicate/i;

export default async function probe() {
  const { PGlite: CjsPGlite } = createRequire(import.meta.url)(
    "@electric-sql/pglite"
  );
  if (CjsPGlite === EsmPGlite)
    return {
      status: "fail",
      evidence:
        "setup: the CJS and ESM PGlite classes are identical; no second copy to test",
    };
  const pglite = new CjsPGlite();
  let db;
  const steps = [
    [
      "createClient",
      () => {
        db = createClient({ schema: { note }, client: pglite });
      },
    ],
    ["push", () => createMigrationClient(db).push()],
    [
      "$transaction",
      () =>
        db.$transaction(async (tx) =>
          tx.note.create({ data: { id: 1, body: "a" } })
        ),
    ],
    ["create", () => db.note.create({ data: { id: 2, body: "b" } })],
  ];
  const done = [];
  try {
    // The steps depend on each other: the first refusal decides the outcome.
    for (const [label, run] of steps) {
      try {
        await run();
        done.push(label);
      } catch (error) {
        const message = String(error?.message);
        return {
          status: NAMES_COPY.test(message) ? "pass" : "fail",
          evidence: `CJS PGlite supplied: ${done.join(", ") || "nothing"} ok; ${label} threw ${error?.code ?? error?.name}: ${message.slice(0, 160)}`,
        };
      }
    }
    const rows = await db.note.count();
    return {
      status: rows === 2 ? "pass" : "fail",
      evidence: `CJS PGlite supplied: ${done.join(", ")} ok; ${rows} rows stored`,
    };
  } finally {
    await db?.$disconnect();
    await pglite.close();
  }
}
