// parity-18: viborm/pg and viborm/postgres given a databaseUrl key that is
// undefined or empty, with no host in options, throw ClientInitializationError
// at construction instead of silently falling back to libpq defaults
// (PG* env or localhost:5432). Construction only: nothing connects.
import { s } from "viborm";
import { createClient as pgClient } from "viborm/pg";
import { createClient as postgresClient } from "viborm/postgres";

export const meta = {
  id: "parity-18",
  title: "pg/postgres with an undefined or empty URL and no host fail fast",
  plan: "track-a/parity-18",
  needs: [],
  source:
    "docs/architecture/adversarial-review-2026-10-09/lanes/parity.md parity-18; src/drivers/pg/index.ts:210-216,597-600; src/drivers/postgres/index.ts:180-194",
};

const note = s.model({ id: s.int().id(), body: s.string() });

const construct = (make, config) => {
  try {
    make({ schema: { note }, ...config });
    return "constructed";
  } catch (error) {
    return `${error?.name} ${error?.code}`;
  }
};

export default async function probe() {
  const lines = [];
  let ok = true;
  for (const [driver, make] of [
    ["pg", pgClient],
    ["postgres", postgresClient],
  ]) {
    for (const [label, url] of [
      ["undefined", undefined],
      ["''", ""],
    ]) {
      const got = construct(make, { databaseUrl: url });
      ok &&= got.startsWith("ClientInitializationError");
      lines.push(`${driver} databaseUrl ${label}: ${got}`);
    }
    // Explicit host: the caller chose the target, so construction proceeds.
    const control = construct(make, {
      databaseUrl: undefined,
      options: { host: "127.0.0.1", port: 1 },
    });
    ok &&= control === "constructed";
    lines.push(`${driver} undefined URL + options.host: ${control}`);
  }
  return { status: ok ? "pass" : "fail", evidence: lines.join("; ") };
}
