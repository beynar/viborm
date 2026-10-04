/**
 * The ON DELETE action a relation's constraint carries has one owner in the
 * resolved topology (`foreignKeyOnDelete`, `junctionOnDelete`): the migration
 * serializer spells the constraint from it and the engine's referential
 * requirement reads it to know which deletes the database refuses.
 */

import { s } from "@src/schema";
import {
  foreignKeyOnDelete,
  junctionOnDelete,
  resolvedEdges,
} from "@src/schema/validation/relation-resolution";
import { resolveSchemaOrThrow } from "@src/schema/validation/validator";
import { describe, expect, it } from "vitest";

const user = s.model({
  id: s.string().id(),
  required: s.toMany(() => required),
  optional: s.toMany(() => optional),
  declared: s.toMany(() => declared),
  topics: s
    .toMany(() => topic)
    .onDelete({ source: "restrict", target: "noAction" }),
  plain: s.toMany(() => plain),
});
const required = s.model({
  id: s.string().id(),
  userId: s.string(),
  user: s
    .toOne(() => user)
    .fields("userId")
    .references("id"),
});
const optional = s.model({
  id: s.string().id(),
  userId: s.string().nullable(),
  user: s
    .toOne(() => user)
    .fields("userId")
    .references("id"),
});
const declared = s.model({
  id: s.string().id(),
  userId: s.string().nullable(),
  user: s
    .toOne(() => user)
    .fields("userId")
    .references("id")
    .onDelete("cascade"),
});
const topic = s.model({ id: s.string().id(), users: s.toMany(() => user) });
const plain = s.model({ id: s.string().id(), users: s.toMany(() => user) });
const schema = { user, required, optional, declared, topic, plain };

const names = new Map(
  Object.entries(schema).map(([name, model]) => [model, name])
);

const actions = () => {
  const found: Record<string, unknown> = {};
  for (const edge of resolvedEdges(resolveSchemaOrThrow(schema))) {
    if (edge.kind === "foreignKey")
      found[names.get(edge.owner.source)!] = foreignKeyOnDelete(edge);
    if (edge.kind === "junction")
      found[edge.topology.table] = [
        junctionOnDelete(edge.topology.source),
        junctionOnDelete(edge.topology.target),
      ];
  }
  return found;
};

describe("the ON DELETE a constraint carries", () => {
  it("a stored reference: declared, else SET NULL when wholly nullable, else RESTRICT; a junction side: declared, else CASCADE", () => {
    expect(actions()).toMatchObject({
      required: "restrict",
      optional: "setNull",
      declared: "cascade",
    });
    expect(Object.values(actions()).filter(Array.isArray)).toEqual(
      expect.arrayContaining([
        ["restrict", "noAction"],
        ["cascade", "cascade"],
      ])
    );
  });
});
