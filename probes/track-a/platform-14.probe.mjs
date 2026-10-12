// platform-14: MySQL TLS URL refusals surface VibORM's own secret-free reason
// ("Unsupported MySQL TLS URL option" / "Unsupported MySQL sslmode") instead
// of "could not parse" + "Underlying error details redacted"; the `new URL()`
// failure, which can carry the URL, stays redacted. Node's URL TypeError keeps
// the URL in `input`, not in its message, so the whole error is inspected.
// Construction only: no MySQL server is contacted.
import { inspect } from "node:util";
import { s } from "viborm";
import { createClient } from "viborm/mysql2";

export const meta = {
  id: "platform-14",
  title: "MySQL TLS URL refusals keep their own message",
  plan: "track-a/platform-14",
  needs: [],
  source:
    "docs/architecture/adversarial-review-2026-10-09/lanes/platform.md platform-14 (probes/p06.out); src/drivers/shared/mysql-utils.ts:33-35,47-49; src/drivers/mysql2/index.ts:248-257",
};

const note = s.model({ id: s.int().id(), body: s.string() });
const AUTHORED = /Unsupported MySQL (TLS URL option|sslmode)/;
const SECRET = "hunter2-secret";

const construct = (databaseUrl) => {
  try {
    createClient({ schema: { note }, databaseUrl });
    return { text: "constructed without error", threw: false };
  } catch (error) {
    return {
      text: `${error?.code ?? error?.name} ${error?.message} | cause: ${error?.cause?.message ?? "none"}`,
      threw: true,
      exposed: [inspect(error, { depth: 6 }), error?.stack, error?.cause?.input]
        .join(" ")
        .includes(SECRET),
    };
  }
};

export default async function probe() {
  const lines = [];
  let ok = true;
  for (const query of [
    "sslmode=prefer",
    "ssl-mode=REQUIRED",
    "sslaccept=strict",
  ]) {
    const r = construct(`mysql://app:pw@127.0.0.1:3307/viborm?${query}`);
    ok &&= r.threw && AUTHORED.test(r.text);
    lines.push(`?${query}: ${r.text}`);
  }
  const malformed = construct(
    `mysql://app:${SECRET}@127.0.0.1:notaport/viborm`
  );
  ok &&= malformed.threw && !malformed.exposed;
  lines.push(
    `malformed URL with password: ${malformed.exposed ? "LEAKS the password" : "password redacted"}`
  );
  return { status: ok ? "pass" : "fail", evidence: lines.join("; ") };
}
