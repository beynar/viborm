import { s } from "@schema";
import { hydrateSchemaNames } from "@schema/hydration";
import { createSchemaRegistry, parse, v } from "@validation";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";

describe("scalar schema interning", () => {
  const A = s
    .model({
      id: s.string().id(),
      name: s.string(),
      nick: s.string().nullable(),
      age: s.int().nullable(),
      tags: s.string().array(),
    })
    .map("intern_a");

  const B = s
    .model({
      id: s.string().id(),
      title: s.string(),
      subtitle: s.string().nullable(),
      count: s.int().nullable(),
      labels: s.string().array(),
    })
    .map("intern_b");

  const custom = z.string().email();
  const C = s
    .model({
      id: s.string().id(),
      email: s.string().schema(custom),
      plain: s.string(),
    })
    .map("intern_c");

  const schema = { A, B, C };
  hydrateSchemaNames(schema);
  const registry = createSchemaRegistry(schema);
  const a = registry.getModelSchemas(A) as any;
  const b = registry.getModelSchemas(B) as any;
  const c = registry.getModelSchemas(C) as any;

  test("same-shape fields share one filter instance across models", () => {
    // plain string
    expect(a.scalars.name.filter).toBe(b.scalars.title.filter);
    // nullable string
    expect(a.scalars.nick.filter).toBe(b.scalars.subtitle.filter);
    // nullable int
    expect(a.scalars.age.filter).toBe(b.scalars.count.filter);
    // string array
    expect(a.scalars.tags.filter).toBe(b.scalars.labels.filter);
    // update schemas too
    expect(a.scalars.name.update).toBe(b.scalars.title.update);
  });

  test("different shapes do not share", () => {
    // plain vs nullable string
    expect(a.scalars.name.filter).not.toBe(a.scalars.nick.filter);
    // string vs int
    expect(a.scalars.age.filter).not.toBe(a.scalars.nick.filter);
  });

  test("custom standard-schema fields are never interned", () => {
    expect(c.scalars.email.filter).not.toBe(c.scalars.plain.filter);
    expect(c.scalars.email.filter).not.toBe(a.scalars.name.filter);
    // but the plain sibling still interns with other models
    expect(c.scalars.plain.filter).toBe(a.scalars.name.filter);
  });

  test("builds create, update, and filter variants independently", () => {
    const isolated = s.model({
      value: s.string().schema(z.string()),
    });
    const isolatedRegistry = createSchemaRegistry({ isolated });
    const createSpy = vi.spyOn(v, "string");
    const updateSpy = vi.spyOn(v, "shorthandUpdate");

    try {
      const value = isolatedRegistry.getModelSchemas(isolated).scalars.value;
      if (!value) throw new Error("Expected the value scalar schema");

      expect(Object.keys(value)).toEqual([
        "base",
        "create",
        "update",
        "filter",
      ]);
      expect(value.filter).toBeDefined();
      expect(createSpy).not.toHaveBeenCalled();
      expect(updateSpy).not.toHaveBeenCalled();

      expect(value.create).toBeDefined();
      expect(createSpy).toHaveBeenCalledOnce();
      expect(updateSpy).not.toHaveBeenCalled();

      expect(value.update).toBeDefined();
      expect(updateSpy).toHaveBeenCalledOnce();
    } finally {
      createSpy.mockRestore();
      updateSpy.mockRestore();
    }
  });

  test("shared filter validates identically for both models", () => {
    const where = registry.getModelSchemas(A).core.where as any;
    const whereB = registry.getModelSchemas(B).core.where as any;

    const rA = parse(where, { name: { contains: "x" }, nick: null });
    expect(rA.issues).toBeUndefined();

    const rB = parse(whereB, { title: "exact", subtitle: { not: null } });
    expect(rB.issues).toBeUndefined();

    // error paths still carry the right field name despite the shared instance
    const bad = parse(where, { name: { contains: 5 } });
    expect(bad.issues?.[0]?.path?.[0]).toBe("name");
    const badB = parse(whereB, { title: { contains: 5 } });
    expect(badB.issues?.[0]?.path?.[0]).toBe("title");
  });

  test("custom schema still enforced through its filter", () => {
    const whereC = registry.getModelSchemas(C).core.where as any;
    expect(parse(whereC, { email: "a@x.com" }).issues).toBeUndefined();
    expect(parse(whereC, { email: "not-an-email" }).issues).toBeDefined();
  });
});
