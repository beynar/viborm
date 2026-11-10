import { describe, expect, test } from "vitest";
import { parseQueryCode } from "../src/query-code";

describe("VibORM query code", () => {
  test("reads one call with comments, literal arguments and nested relations", () => {
    expect(
      parseQueryCode(`// A read
      await client.user.findMany({
        where: { OR: [{ name: 'Ada' }, { name: "Bob" }], active: true, missing: null },
        include: { posts: { select: { title: true } } },
        orderBy: { id: 'desc' }, take: 2, // trailing commas are valid
      });`)
    ).toEqual({
      model: "user",
      operation: "findMany",
      args: {
        where: {
          OR: [{ name: "Ada" }, { name: "Bob" }],
          active: true,
          missing: null,
        },
        include: { posts: { select: { title: true } } },
        orderBy: { id: "desc" },
        take: 2,
      },
    });
  });

  test("accepts bracket model names, omitted args, parentheses and scalar literal forms", () => {
    expect(parseQueryCode('(client["odd-name"]["count"]())')).toEqual({
      model: "odd-name",
      operation: "count",
      args: {},
    });
    const parsed = parseQueryCode(
      "client.user.findMany({ where: { karma: -1_000n, score: +1.5, name: `Ada`, createdAt: new Date('2026-01-01T00:00:00Z'), deleted: false, optional: undefined }, take: 0x10 })"
    );
    expect(parsed.args).toEqual({
      where: {
        karma: -1000n,
        score: 1.5,
        name: "Ada",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        deleted: false,
        optional: undefined,
      },
      take: 16,
    });
    expect(
      parseQueryCode("client.user.count({where:{createdAt:new Date(0)}})").args
    ).toEqual({ where: { createdAt: new Date(0) } });
    expect(
      parseQueryCode("client.user.count({where:{score:-1.5}})").args
    ).toEqual({
      where: { score: -1.5 },
    });
  });

  test("special property names remain own data properties", () => {
    const parsed = parseQueryCode(
      'client.user.findMany({ where: { "__proto__": { polluted: true } } })'
    );
    expect(parsed.args).toEqual(
      JSON.parse('{"where":{"__proto__":{"polluted":true}}}')
    );
    expect(Object.getPrototypeOf(parsed.args)).toBe(Object.prototype);
    expect(Reflect.get({}, "polluted")).toBeUndefined();
  });

  test.each([
    "",
    "   ",
    "client.user.findMany({take:})",
    "client.user.count(); client.user.count()",
    "const x = client.user.count()",
    "await client.user.deleteMany({})",
    "client.$queryRawUnsafe('SELECT 1')",
    "globalThis.process.exit()",
    "client.user.findMany({where:process.env})",
    "client.user.findMany({where:(()=>{throw 1})()})",
    "client.user.findMany({...other})",
    "client.user.findMany({[key]:1})",
    "client.user.findMany({get where(){return {}}})",
    "client.user.findMany({where})",
    "client.user.findMany([])",
    "client.user.findMany(null)",
    "client.user.findMany(new Date(0))",
    "client.user.findMany({}, {})",
    "client.user.findMany(...args)",
    "client.user?.findMany()",
    "client?.user.findMany()",
    "client.user.findMany?.()",
    "client.user.findMany<T>()",
    "client.user.findMany({take:1 as number})",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Parser input must contain an unevaluated template expression.
    "client.user.findMany({where:{x:`value ${danger()}`}})",
    "client.user.findMany({take:1e999})",
    "client.user.findMany({where:{x:new Date('invalid')}})",
    "client.user.findMany({where:{x:new Date()}})",
    "client.user.findMany({where:{x:new Date<T>(0)}})",
    "client.user.findMany({where:{x:new Date(true)}})",
    "client.user.findMany({where:{x:new Other(1)}})",
    "client.user.findMany({where:{x:+1n}})",
    "client.user.findMany({where:{x:[,1]}})",
  ])("refuses unsupported or executable syntax: %s", (source) => {
    expect(() => parseQueryCode(source)).toThrow();
  });

  test("bounds source size and argument nesting", () => {
    expect(() => parseQueryCode(42)).toThrow();
    expect(() => parseQueryCode(" ".repeat(65_537))).toThrow();
    expect(() =>
      parseQueryCode(
        `client.user.count({x:${"[".repeat(66)}0${"]".repeat(66)}})`
      )
    ).toThrow("nested");
  });
});
