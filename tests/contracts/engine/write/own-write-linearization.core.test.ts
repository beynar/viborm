import { buildRelationMutationProgram } from "@src/query-engine/builders/relation-mutation-parser";
import type { RelationRef } from "@src/query-engine/types";
import { linearizationSchema } from "@tests/contracts/engine/write/own-write-linearization-behavior";
import { describe, expect, test } from "vitest";

describe("N6-U3 — one order, one derivation (ATOM §4.1)", () => {
  test("the mutation program carries the documented execution order", () => {
    const relationRef = {
      name: "notes",
      targetModel: linearizationSchema.note,
      cardinality: "many",
      type: "oneToMany",
    };
    const program = buildRelationMutationProgram(
      // The program reads relation metadata only, so a structural stand-in is enough.
      relationRef as unknown as RelationRef,
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
