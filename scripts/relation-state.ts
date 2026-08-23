/**
 * Which foreign key does an inverse `toMany` slot read?
 *
 * There is no per-relation inverse scan to ask any more: the schema-wide
 * resolver pairs both `.name(...)`d edges once, and the answer is the resolved
 * edge's own stored reference. Two same-target pairs are separated by their
 * exact matching names, never by declaration precedence.
 *
 * Run from the repository root:
 *   bun run scripts/relation-state.ts
 */

import { hydrateSchemaNames } from "@schema/hydration";
import { resolveSchemaOrThrow } from "@schema/validation/validator";
import { s } from "../src/schema";

const user = s.model({
  id: s.string().id(),
  posts: s.toMany(() => post).name("one"),
  authored: s.toMany(() => post).name("two"),
});

const post = s.model({
  id: s.string().id(),
  authorId: s.string(),
  co_authorId: s.string(),
  author: s
    .toOne(() => user)
    .fields("authorId")
    .references("id")
    .name("one"),
  co_author: s
    .toOne(() => user)
    .fields("co_authorId")
    .references("id")
    .name("two"),
});

const schema = { user, post };
hydrateSchemaNames(schema);
const relations = resolveSchemaOrThrow(schema);

function foreignFieldsOf(field: string): readonly string[] {
  const resolved = relations.get(user)?.get(field);
  if (!resolved) throw new Error(`user.${field} resolved to no slot`);
  const { edge } = resolved;
  if (edge.kind !== "foreignKey") {
    throw new Error(`user.${field} resolved to a ${edge.kind} edge`);
  }
  return edge.reference.members.map((member) => member.foreignField);
}

console.log("user.posts reads:", foreignFieldsOf("posts"));
console.log('Expected: ["authorId"]');

console.log("user.authored reads:", foreignFieldsOf("authored"));
console.log('Expected: ["co_authorId"]');
