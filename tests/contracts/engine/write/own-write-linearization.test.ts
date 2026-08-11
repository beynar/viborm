import { describe, expect, test } from "vitest";
import { buildRelationMutationProgram } from "@src/query-engine/builders/relation-mutation-parser";
import type { RelationInfo } from "@src/query-engine/types";
import {
  linearizationSchema,
  runOwnWriteLinearizationBehavior,
} from "@tests/contracts/engine/write/own-write-linearization-behavior";

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

describe("N6-U3 — one order, one derivation (ATOM §4.1)", () => {
  test("the mutation program carries the documented execution order", () => {
    const relationInfo = {
      name: "notes",
      targetModel: linearizationSchema.note,
      cardinality: "many",
      type: "oneToMany",
    };
    const program = buildRelationMutationProgram(
      // The program reads relation METADATA only, so a structural stand-in is enough
      // here; building a real `RelationInfo` would add nothing this test asserts.
      relationInfo as unknown as RelationInfo,
      {
        disconnect: [{ id: 1 }],
        delete: [{ id: 2 }],
        update: [{ where: { id: 3 }, data: { body: "u" } }],
        upsert: [{ where: { id: 4 }, create: { id: 4 }, update: {} }],
        connectOrCreate: [{ where: { id: 5 }, create: { id: 5 } }],
        set: [{ id: 6 }],
        updateMany: [{ where: { id: 7 }, data: { body: "m" } }],
        deleteMany: [{ id: 8 }],
        connect: [{ id: 9 }],
        create: [{ id: 10, body: "c" }],
        createMany: { data: [{ id: 11, body: "cm" }] },
      }
    );
    expect(program?.entries.map((entry) => entry.kind)).toEqual([
      "disconnect",
      "delete",
      "update",
      "upsert",
      "connectOrCreate",
      "set",
      "updateMany",
      "deleteMany",
      "connect",
      "create",
      "createMany",
    ]);
  });
});
