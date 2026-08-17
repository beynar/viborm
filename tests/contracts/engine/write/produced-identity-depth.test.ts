import { runProducedIdentityBehavior } from "@tests/contracts/engine/write/produced-identity-depth-behavior";
import { describe } from "vitest";

describe("N4-U2 / N4-U4 — produced identity at depth (PGlite)", () => {
  runProducedIdentityBehavior({
    name: "PGlite transaction",
    pgliteMode: "transaction",
  });
  runProducedIdentityBehavior({
    name: "PGlite atomic batch",
    pgliteMode: "atomicBatch",
  });
});
