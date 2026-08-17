import { runJunctionCreateManyBehavior } from "@tests/contracts/engine/write/junction-create-many-behavior";
import { describe } from "vitest";

describe("N3 — M2M completions (PGlite)", () => {
  runJunctionCreateManyBehavior({
    name: "PGlite transaction",
    pgliteMode: "transaction",
  });
  runJunctionCreateManyBehavior({
    name: "PGlite atomic batch",
    pgliteMode: "atomicBatch",
  });
});
