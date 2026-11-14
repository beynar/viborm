/**
 * `defineFilters()` brings what reads filters alone: in a program where
 * nothing brought what reads `verbs` and `confine`, a definition declaring
 * one is refused when applied, never applied unjudged. Nothing in this file
 * calls `defineExtension()`, which would bring it for the whole program.
 */

import { createClient } from "@drivers/sqlite3";
import { ClientInitializationError } from "@errors";
import { defineFilters } from "@extensions/define";
import { s } from "@schema";
import { v } from "@validation";
import { expect, test } from "vitest";

const node = s.model({ id: s.string().id(), ownerId: s.string() });
const schema = { node };

test("a definition built with defineFilters() that declares verbs, confine or a named predicate is refused when applied", async () => {
  const base = createClient({ schema, dataDir: ":memory:" });
  const own = { ownerId: { control: "user" } };
  const rows: object[] = [
    { verbs: { node: { predicates: { own }, read: "own" } } },
    { verbs: { node: () => ({ predicates: { own }, read: "own" }) } },
    { verbs: { node: { predicates: { own }, read: "own", reads: {} } } },
    { confine: { node: own } },
  ];
  for (const extra of rows) {
    const definition = defineFilters({
      name: "filters",
      controls: { user: { schema: v.string() } },
      rows: { control: "as", default: "all", models: {}, ...extra },
    } as never);
    const apply = () => base.$extends(definition);
    expect(apply, JSON.stringify(extra)).toThrow(ClientInitializationError);
    expect(apply, JSON.stringify(extra)).toThrow(
      "An extension whose `rows` declare `verbs` or `confine` must be built with defineExtension()."
    );
  }
  const named = defineFilters({
    name: "filters",
    rows: {
      control: "as",
      default: "all",
      models: { node: { all: { root: "own" } } },
    },
  } as never);
  expect(() => base.$extends(named)).toThrow(
    'Extension "filters" rows.node.all.root at "root": names unknown predicate "own".'
  );
  await base.$disconnect();
});
