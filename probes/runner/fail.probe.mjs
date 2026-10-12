// Runner self-test: a probe whose target behaviour does not hold.
export const meta = {
  id: "RUNNER-FAIL",
  title: "A failing probe is reported as fail",
  plan: "phase-0/M0.1",
  needs: [],
  source: "scripts/probe-corpus.mjs",
};

export default async function probe() {
  return { status: "fail", evidence: "deliberate failure\nsecond line" };
}
