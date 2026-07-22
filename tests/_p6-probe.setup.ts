// T3c P6 readiness probe (temporary, not committed): disable the V1 fallback arm
// for the WHOLE estate. Any test that reaches a V2 UnsupportedOperationError decline
// now sees it RE-THROWN instead of routed to V1 — surfacing every reachable
// accept-and-execute behavior still living behind the fallback across the full suite.
import { beforeEach } from "vitest";
import { setV1FallbackDisabled } from "../src/query-engine-v2/routing";

setV1FallbackDisabled(true);
beforeEach(() => {
  setV1FallbackDisabled(true);
});
