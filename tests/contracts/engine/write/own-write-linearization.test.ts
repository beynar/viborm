import { runOwnWriteLinearizationBehavior } from "@tests/contracts/engine/write/own-write-linearization-behavior";
import { describe } from "vitest";

describe("N6-U3 — own-write linearization (PGlite)", () => {
  runOwnWriteLinearizationBehavior({
    name: "PGlite transaction",
    pgliteMode: "transaction",
  });
  runOwnWriteLinearizationBehavior({
    name: "PGlite atomic batch",
    pgliteMode: "atomicBatch",
  });
});
