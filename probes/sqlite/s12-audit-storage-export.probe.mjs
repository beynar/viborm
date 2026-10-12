// S12: the CLI's SQLite storage audit (`viborm check --db`, auditStorage in
// src/cli/commands/check.ts) is exported as a function, so runtime and Durable
// Object callers can run it without the CLI. The plan names neither the entry
// point nor the signature; this probe looks for `auditStorage` on
// viborm/migrations, where the SQLite repair helpers already live. A dynamic
// import, because a static named import of a missing export fails at link time.

export const meta = {
  id: "S12-audit",
  title: "auditStorage is exported from viborm/migrations",
  plan: "phase-1/lane-L/S12",
  needs: [],
  source:
    "completion-plan-2026-10/code-check/migrations-sqlite.md S12 (src/cli/commands/check.ts:81-141 auditStorage, CLI-only)",
};

export default async function probe() {
  const migrations = await import("viborm/migrations");
  const exported = migrations.auditStorage;
  return typeof exported === "function"
    ? {
        status: "pass",
        evidence: `viborm/migrations exports auditStorage (function, ${exported.length} declared parameter(s))`,
      }
    : {
        status: "fail",
        evidence: `missing export auditStorage on viborm/migrations (found ${typeof exported}); exports: ${Object.keys(migrations).sort().join(", ")}`,
      };
}
