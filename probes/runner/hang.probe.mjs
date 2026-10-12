// Runner self-test: a probe that never settles is killed at the time limit.
export const meta = {
  id: "RUNNER-HANG",
  title: "A hanging probe is killed and reported as error",
  plan: "phase-0/M0.1",
  needs: [],
  source: "scripts/probe-corpus.mjs",
};

export default function probe() {
  setInterval(() => undefined, 1000);
  return new Promise(() => undefined);
}
