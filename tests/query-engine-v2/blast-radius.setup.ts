import { beforeAll } from "vitest";
import { setV1FallbackDisabled } from "../../src/query-engine-v2/routing";

/**
 * The blast-radius gate setup (T3d — P6 Stage 0). Globally DISABLES the V1
 * fallback for the WHOLE estate: a V2 decline ({@link setV1FallbackDisabled}
 * makes an `UnsupportedOperationError` at construction RE-THROW instead of
 * routing to V1), so any reachable behavior still living behind the router's V1
 * fallback surfaces as a hard failure rather than silently passing through V1.
 *
 * This is the machine form of P6's deletion premise applied to the FULL local
 * estate (not just the conformance census): the only tests that may fail under it
 * are the documented residual in {@link file://./blast-radius-residual.ts} —
 * (b) tests that construct V1 internals directly / assert the V1-fallback route
 * (they are rewritten when V1 dies at P6) and the boundary-stopped decline
 * subsystems (batch generated/updated-PK dataflow; the relation-key /
 * referential-action legality engine; deep create-context grandchildren). The
 * `scripts/blast-radius-gate.mjs` runner asserts the observed failure set equals
 * that residual exactly (bidirectional), so a NEW decline (regression) OR a
 * silently-unlisted absorption both turn the gate red.
 *
 * Inert in production: the flag defaults off and is flipped only through this
 * setup file (loaded solely by `vitest.blast-radius.config.ts`). Set at module
 * load per forked worker AND per file, robust against any suite that captures and
 * restores a previous value.
 */
setV1FallbackDisabled(true);
beforeAll(() => {
  setV1FallbackDisabled(true);
});
