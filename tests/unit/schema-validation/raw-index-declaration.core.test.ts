/**
 * `.rawIndex()` at the schema: what the builder refuses, and the names a raw
 * index claims beside the declared ones (I002) and the generated storage
 * names a variant relation would otherwise take (P008). Its text is read by
 * the migration layer, per dialect, and is not this layer's.
 */

import { s } from "@src/schema";
import { validateSchema } from "@src/schema/validation";
import { describe, expect, it } from "vitest";

const NEEDS_NAME = /needs a name/;
const NEEDS_TEXT = /needs a pg text/;

const codes = (result: ReturnType<typeof validateSchema>) =>
  result.errors.map(({ code }) => code);

describe("a raw index declaration", () => {
  it("keeps one text per dialect it is given, and refuses an empty name or text", () => {
    const model = s
      .model({ id: s.string().id(), title: s.string() })
      .rawIndex("documents_title", {
        sqlite: "CREATE INDEX {name} ON {table} (lower({title}))",
      });
    expect(model["~"].state.rawIndexes).toEqual([
      {
        name: "documents_title",
        templates: {
          sqlite: "CREATE INDEX {name} ON {table} (lower({title}))",
        },
      },
    ]);
    const base = s.model({ id: s.string().id() });
    expect(() => base.rawIndex("", { pg: "CREATE INDEX" })).toThrow(NEEDS_NAME);
    expect(() => base.rawIndex("x", { pg: "  " })).toThrow(NEEDS_TEXT);
  });

  it("shares the model's index names (I002)", () => {
    const model = s
      .model({ id: s.string().id(), title: s.string() })
      .index(["title"], { name: "documents_title" })
      .rawIndex("documents_title", {
        pg: "CREATE INDEX {name} ON {table} ({title})",
      });
    expect(codes(validateSchema({ document: model }))).toContain("I002");
    const twice = s
      .model({ id: s.string().id(), title: s.string() })
      .rawIndex("documents_raw", {
        pg: "CREATE INDEX {name} ON {table} ({title})",
      })
      .rawIndex("documents_raw", {
        pg: "CREATE INDEX {name} ON {table} ({title})",
      });
    expect(codes(validateSchema({ document: twice }))).toContain("I002");
  });

  it("claims its name against a variant relation's generated index (P008)", () => {
    const post = s.model({ id: s.string().id() });
    const owner = s
      .model({ id: s.string().id(), target: s.toOne({ post: () => post }) })
      .rawIndex("owner_target_poly_idx", {
        pg: "CREATE INDEX {name} ON {table} ({id})",
      })
      .map("owner");
    expect(codes(validateSchema({ owner, post }))).toContain("P008");
  });
});
