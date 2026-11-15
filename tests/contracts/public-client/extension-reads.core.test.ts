/**
 * What a row predicate reads of the row it judges (`readsAny`): a write is
 * judged again only where it changes one of those fields, so a predicate
 * the function cannot answer for must read them all.
 */

import { readsAny } from "@extensions/reads";
import type { PreparedPredicate } from "@query-engine/raptor3/shared/query";
import { describe, expect, test } from "vitest";

describe("readsAny", () => {
  test("a predicate it cannot answer for reads every field", () => {
    // No rule holds a window predicate today: the answer for one is the
    // careful one, whatever field is asked.
    const window = { kind: "window" } as unknown as PreparedPredicate;
    expect(readsAny(window, new Set(["title"]), ["id"])).toBe(true);
    expect(
      readsAny(
        { kind: "and", predicates: [{ kind: "always" }, window] } as never,
        new Set<string>(),
        []
      )
    ).toBe(true);
  });

  test("a predicate that holds for every row reads none", () => {
    expect(
      readsAny({ kind: "always" } as never, new Set(["title"]), ["id"])
    ).toBe(false);
  });
});
