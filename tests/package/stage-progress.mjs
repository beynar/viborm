/** Only explicit package-stage observations are forwarded to CI. */
export const PACKAGE_STAGE_PREFIX = "[viborm-package-stage] ";

/**
 * @template T
 * @param {string} compiler
 * @param {string} scenario
 * @param {string} stage
 * @param {() => T} work
 * @returns {T}
 */
export function runPackageStage(compiler, scenario, stage, work) {
  const started = performance.now();
  const publish = (event, details = {}) => {
    process.stderr.write(
      `${PACKAGE_STAGE_PREFIX}${JSON.stringify({ compiler, scenario, stage, event, ...details })}\n`
    );
  };
  publish("begin");
  let passed = false;
  try {
    const result = work();
    passed = true;
    return result;
  } finally {
    publish("end", { passed, wallMs: Math.round(performance.now() - started) });
  }
}
