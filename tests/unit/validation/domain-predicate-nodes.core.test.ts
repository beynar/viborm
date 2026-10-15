import { s } from "@schema";
import { createSchemaRegistry } from "@validation";
import { validateSchema } from "@validation/primitives/helpers";
import {
  admittingDomainPredicate,
  type DomainMarkers,
  valueNodeOr,
} from "@validation/primitives/parameter";
import v from "@validation/primitives/v";
import { describe, expect, it } from "vitest";

/**
 * The nodes a domain predicate's admission answers (RBAC plan K1(a)): while
 * one is admitted, each value position of the `where` schemas and each
 * `where`'s `$if` ask the admission what they stand for, so the schemas alone
 * decide which place is a value; the nodes are kept as they are, by
 * identity, then and later. Admitting one also lifts a caller's nesting bound
 * and asks every recursion for a written depth. Outside an admission a
 * marker is validated as what it is.
 */
describe("domain predicate nodes in the where schemas", () => {
  const node = s.model({
    id: s.string().id(),
    rank: s.int(),
    tags: s.string().array(),
    parentId: s.string().nullable(),
    parent: s
      .toOne(() => node)
      .fields("parentId")
      .references("id")
      .name("tree"),
    children: s.toMany(() => node).name("tree"),
  });
  const where = createSchemaRegistry({ node }).getModelSchemas(node).core.where;
  const parse = (value: unknown) =>
    validateSchema(where, value) as { value?: unknown; issues?: unknown[] } & {
      issues?: { message: string }[];
    };

  /** `{ control: "actor" }` is a call value; `$if: "ok"` a condition. */
  const actor = { node: "actor" };
  const condition = { node: "condition" };
  const markers: DomainMarkers = {
    value: (value) =>
      typeof value === "object" &&
      value !== null &&
      (value as { control?: unknown }).control === "actor"
        ? actor
        : undefined,
    condition: (spec) => (spec === "ok" ? condition : "refused"),
  };
  const admit = (value: unknown) =>
    admittingDomainPredicate(markers, () => parse(value));

  it("turns a marker into its node at every value position only while a domain predicate is admitted, and keeps the node by identity after", () => {
    /** Whether `value` holds `node` itself somewhere inside it. */
    const holds = (held: unknown): boolean =>
      held === actor ||
      (typeof held === "object" &&
        held !== null &&
        Object.values(held).some(holds));
    for (const filter of [
      { id: { control: "actor" } },
      { id: { contains: { control: "actor" } } },
      { rank: { in: { control: "actor" } } },
      { tags: { has: { control: "actor" } } },
      { tags: { equals: { control: "actor" } } },
      { parent: { is: { id: { control: "actor" } } } },
    ]) {
      const result = admit(filter);
      expect(result.issues, JSON.stringify(filter)).toBeUndefined();
      expect(holds(result.value), JSON.stringify(filter)).toBe(true);
      // Admitted, the predicate admits again, and parses, as itself.
      expect(parse(result.value).value, JSON.stringify(filter)).toEqual(
        result.value
      );
    }
    expect(parse({ rank: { in: { control: "actor" } } }).issues).toBeDefined();
    const wrapped = valueNodeOr(v.optional(v.string()));
    expect(
      (wrapped as unknown as { acceptsUndefined: boolean }).acceptsUndefined
    ).toBe(true);
  });

  it("reads $if as a condition where a where stands, conjoined with the filter beside it, only while a domain predicate is admitted", () => {
    expect(admit({ OR: [{ $if: "ok" }] }).value).toEqual({ OR: [condition] });
    expect(
      (admit({ OR: [{ $if: "ok" }] }).value as { OR: unknown[] }).OR[0]
    ).toBe(condition);
    const beside = admit({ rank: 1, $if: "ok" }).value as { AND: unknown[] };
    expect(beside.AND[0]).toEqual({ rank: { equals: 1 } });
    expect(beside.AND[1]).toBe(condition);
    expect(parse({ OR: [condition] }).value).toEqual({ OR: [condition] });
    expect(admit({ OR: [{ $if: "no" }] }).issues).toEqual([
      { message: "refused", path: ["OR", 0, "$if"] },
    ]);
    expect(parse({ $if: "ok" }).issues).toBeDefined();
  });

  it("asks a recursion for a written depth only while a domain predicate is admitted, and lifts the caller's nesting bound there", () => {
    for (const recurse of [true, {}]) {
      const filter = { parent: { recurse, self: true, some: { rank: 1 } } };
      expect(parse(filter).issues).toBeUndefined();
      expect(admit(filter).issues?.[0]?.message).toBe(
        "A row predicate's recurse must write its depth (false, or a number)"
      );
    }
    expect(
      admit({
        parent: { recurse: { depth: false }, self: true, some: { rank: 1 } },
      }).issues
    ).toBeUndefined();
    let deep: unknown = { rank: 1 };
    for (let depth = 0; depth < 20; depth++) deep = { AND: deep };
    expect(parse(deep).issues?.[0]?.message).toContain(
      "Filter nesting exceeds 16 levels"
    );
    expect(admit(deep).issues).toBeUndefined();
    // The bound and the depth rule are back once admission returns.
    expect(parse(deep).issues).toBeDefined();
    expect(
      parse({ parent: { recurse: true, self: true, some: { rank: 1 } } }).issues
    ).toBeUndefined();
  });
});
