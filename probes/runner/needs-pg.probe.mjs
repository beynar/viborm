// Runner self-test: without VIBORM_PROBE_PG_URL this is skipped, never run.
export const meta = {
  id: "RUNNER-NEEDS-PG",
  title: "A probe needing Postgres is skipped without its URL",
  plan: "phase-0/M0.1",
  needs: ["pg"],
  source: "scripts/probe-corpus.mjs",
};

export default async function probe() {
  return { status: "pass", evidence: "ran with a Postgres URL" };
}
