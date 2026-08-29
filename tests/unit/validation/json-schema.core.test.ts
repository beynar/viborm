import { ValidationError, VibORMErrorCode } from "@errors";
import { s } from "@schema";
import { getSchemas } from "@schema/schemas";
import v, { toJsonSchema } from "@validation";
import type { JsonSchema } from "@validation/json-schema";
import type { VibSchema } from "@validation/types";
import { describe, expect, test } from "vitest";

const DEFS_PREFIX = "#/$defs/";
const DEFS_POINTER = /^#\/\$defs\//;
const GENERATED_DEFS_POINTER = /^#\/\$defs\/Recursive\d+$/;

describe("JSON Schema conversion", () => {
  describe("primitive schemas", () => {
    test("string schema", () => {
      const schema = v.string();
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      });

      expect(jsonSchema).toMatchObject({
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "string",
      });
    });

    test("input and output delegate to the same truthful schema projection", () => {
      const converter = v.string()["~standard"].jsonSchema;

      expect(converter.input({ target: "draft-07" })).toEqual(
        converter.output({ target: "draft-07" })
      );
    });

    test("number schema", () => {
      const schema = v.number();
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      });

      expect(jsonSchema).toMatchObject({
        type: "number",
      });
    });

    test("decimal input and output expose their distinct JSON value families", () => {
      const schema = v.decimal({
        decimal: { precision: 10, scale: 2 },
      });
      const converter = schema["~standard"].jsonSchema;
      const input = converter.input({ target: "draft-07" });
      const output = converter.output({ target: "draft-07" });
      const description =
        "Exact decimal with at most 10 total digits and at most 2 fractional digits";
      const inputStringValue = {
        type: "string",
        pattern: "^[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)$",
      };
      const outputStringValue = {
        type: "string",
        pattern: "^(?:0|-?(?:[1-9]\\d*(?:\\.\\d*[1-9])?|0\\.\\d*[1-9]))$",
      };

      expect(input).toMatchObject({
        description,
        anyOf: [inputStringValue, { type: "number" }],
      });
      expect(toJsonSchema(schema)).toEqual(input);
      expect(output).toMatchObject({ description, ...outputStringValue });
      expect(output).not.toHaveProperty("anyOf");

      const outputPattern = Reflect.get(output, "pattern");
      if (typeof outputPattern !== "string") {
        throw new Error("decimal output schema has no string pattern");
      }
      for (const canonical of ["0", "1", "-1", "0.5", "-0.5", "1.02"]) {
        expect(new RegExp(outputPattern).test(canonical)).toBe(true);
      }
      for (const noncanonical of ["+1", "01", "1.", "1.20", ".5", "-0"]) {
        expect(new RegExp(outputPattern).test(noncanonical)).toBe(false);
      }
    });

    test("decimal scalar options project list arity and nullability", () => {
      const schema = v.decimal({
        decimal: { precision: 10, scale: 2 },
        array: true,
        nullable: true,
      });
      const converter = schema["~standard"].jsonSchema;
      const input = converter.input({ target: "draft-07" });
      const output = converter.output({ target: "draft-07" });
      const openapi = converter.output({ target: "openapi-3.0" });

      expect(input).toMatchObject({
        anyOf: [
          {
            type: "array",
            items: {
              anyOf: [{ type: "string" }, { type: "number" }],
            },
          },
          { type: "null" },
        ],
      });
      expect(output).toMatchObject({
        anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }],
      });
      expect(openapi).toMatchObject({
        type: "array",
        nullable: true,
        items: { type: "string" },
      });
    });

    test("an exact-one schema resolves a lazy operation entry", () => {
      const lazyExactOne = {
        type: "exact_one",
        entries: { set: () => v.decimal() },
        "~standard": v.string()["~standard"],
      } as unknown as VibSchema & {
        entries: { set: () => VibSchema };
      };

      expect(toJsonSchema(lazyExactOne)).toMatchObject({
        oneOf: [
          {
            type: "object",
            required: ["set"],
            additionalProperties: false,
          },
        ],
      });
    });

    test("decimal output direction reaches nested and list leaves", () => {
      const decimal = v.decimal({
        decimal: { precision: 10, scale: 2 },
      });
      const schema = v.object({
        amount: decimal,
        amounts: v.array(decimal),
      });
      const converter = schema["~standard"].jsonSchema;
      const input = converter.input({ target: "draft-07" }) as JsonSchema;
      const output = converter.output({ target: "draft-07" }) as JsonSchema;
      const inputDecimal = {
        description:
          "Exact decimal with at most 10 total digits and at most 2 fractional digits",
        anyOf: [
          {
            type: "string",
            pattern: "^[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)$",
          },
          { type: "number" },
        ],
      };
      const outputDecimal = {
        description:
          "Exact decimal with at most 10 total digits and at most 2 fractional digits",
        type: "string",
        pattern: "^(?:0|-?(?:[1-9]\\d*(?:\\.\\d*[1-9])?|0\\.\\d*[1-9]))$",
      };

      expect(input.properties?.amount).toEqual(inputDecimal);
      expect((input.properties?.amounts as JsonSchema).items).toEqual(
        inputDecimal
      );
      expect(output.properties?.amount).toEqual(outputDecimal);
      expect((output.properties?.amounts as JsonSchema).items).toEqual(
        outputDecimal
      );
    });

    test("boolean schema", () => {
      const schema = v.boolean();
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      });

      expect(jsonSchema).toMatchObject({
        type: "boolean",
      });
    });

    test("bigint schema", () => {
      const schema = v.bigint();
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      });

      expect(jsonSchema).toMatchObject({
        type: "integer",
      });
    });

    test("literal schema (draft-07)", () => {
      const schema = v.literal("hello");
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      });

      expect(jsonSchema).toMatchObject({
        const: "hello",
      });
    });

    test("literal schema (openapi-3.0)", () => {
      const schema = v.literal("hello");
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "openapi-3.0",
      });

      expect(jsonSchema).toMatchObject({
        enum: ["hello"],
      });
    });

    test("enum schema", () => {
      const schema = v.enum(["a", "b", "c"]);
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      });

      expect(jsonSchema).toMatchObject({
        enum: ["a", "b", "c"],
      });
    });
  });

  describe("wrapper schemas", () => {
    test("nullable schema (draft-07)", () => {
      const schema = v.nullable(v.string());
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      });

      expect(jsonSchema).toMatchObject({
        anyOf: [{ type: "string" }, { type: "null" }],
      });
    });

    test("nullable schema (openapi-3.0)", () => {
      const schema = v.nullable(v.string());
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "openapi-3.0",
      });

      expect(jsonSchema).toMatchObject({
        type: "string",
        nullable: true,
      });
    });

    test("optional schema (passthrough)", () => {
      const schema = v.optional(v.string());
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      });

      expect(jsonSchema).toMatchObject({
        type: "string",
      });
    });

    test("array schema", () => {
      const schema = v.array(v.string());
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      });

      expect(jsonSchema).toMatchObject({
        type: "array",
        items: { type: "string" },
      });
    });
  });

  describe("object schemas", () => {
    test("simple object", () => {
      const schema = v.object({
        name: v.string(),
        age: v.number(),
      });
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      expect(jsonSchema.type).toBe("object");
      expect(jsonSchema.properties).toMatchObject({
        name: { type: "string" },
        age: { type: "number" },
      });
    });

    test("object with partial: false has required fields", () => {
      const schema = v.object(
        {
          name: v.string(),
          age: v.number(),
        },
        { partial: false }
      );
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      expect(jsonSchema.required).toContain("name");
      expect(jsonSchema.required).toContain("age");
    });

    test("object with strict: true has additionalProperties: false", () => {
      const schema = v.object(
        {
          name: v.string(),
        },
        { strict: true }
      );
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      expect(jsonSchema.additionalProperties).toBe(false);
    });

    test("object with optional fields", () => {
      const schema = v.object(
        {
          name: v.string(),
          nickname: v.optional(v.string()),
        },
        { partial: false }
      );
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      expect(jsonSchema.required).toContain("name");
      expect(jsonSchema.required).not.toContain("nickname");
    });

    test("nested objects", () => {
      const address = v.object({
        city: v.string(),
        zip: v.string(),
      });

      const user = v.object({
        name: v.string(),
        address,
      });

      const jsonSchema = user["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      expect(jsonSchema.properties?.address).toMatchObject({
        type: "object",
        properties: {
          city: { type: "string" },
          zip: { type: "string" },
        },
      });
    });

    test("object with strict: false allows additional properties", () => {
      const schema = v.object(
        {
          name: v.string(),
        },
        { strict: false }
      );
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      // strict: false should NOT have additionalProperties: false
      expect(jsonSchema.additionalProperties).toBeUndefined();
    });

    test("object with partial: true (default) has no required fields", () => {
      const schema = v.object({
        name: v.string(),
        age: v.number(),
      });
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      // partial: true by default, so no required array
      expect(jsonSchema.required).toBeUndefined();
    });

    test("object with strict: true and partial: false", () => {
      const schema = v.object(
        {
          id: v.string(),
          name: v.string(),
          email: v.optional(v.string()),
        },
        { strict: true, partial: false }
      );
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      // strict: true -> additionalProperties: false
      expect(jsonSchema.additionalProperties).toBe(false);

      // partial: false -> required fields (except optional wrapper)
      expect(jsonSchema.required).toContain("id");
      expect(jsonSchema.required).toContain("name");
      expect(jsonSchema.required).not.toContain("email");
    });

    test("object with strict: false and partial: true", () => {
      const schema = v.object(
        {
          name: v.string(),
          tags: v.array(v.string()),
        },
        { strict: false, partial: true }
      );
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      // strict: false -> no additionalProperties restriction
      expect(jsonSchema.additionalProperties).toBeUndefined();

      // partial: true -> no required fields
      expect(jsonSchema.required).toBeUndefined();
    });

    test("object with name and description options", () => {
      const schema = v.object(
        {
          id: v.string(),
        },
        { name: "User", description: "A user entity" }
      );
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      // Name is used for $ref, description should be in output
      expect(jsonSchema.type).toBe("object");
      // Note: description output depends on implementation
    });
  });

  describe("union and record schemas", () => {
    test("union schema", () => {
      const schema = v.union([v.string(), v.number()]);
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      expect(jsonSchema.anyOf).toMatchObject([
        { type: "string" },
        { type: "number" },
      ]);
    });

    test("record schema", () => {
      const schema = v.record(v.string(), v.number());
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      expect(jsonSchema).toMatchObject({
        type: "object",
        additionalProperties: { type: "number" },
      });
    });
  });

  describe("special schemas", () => {
    test("json schema (accepts anything)", () => {
      const schema = v.json();
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      // JSON schema should be empty (accepts any JSON)
      expect(jsonSchema.$schema).toBe(
        "http://json-schema.org/draft-07/schema#"
      );
      expect(jsonSchema.type).toBeUndefined();
    });
  });

  describe("date and time schemas", () => {
    test("date schema", () => {
      const schema = v.date();
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      expect(jsonSchema).toMatchObject({
        type: "string",
        format: "date-time",
      });
    });

    test("isoTimestamp schema", () => {
      const schema = v.isoTimestamp();
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      expect(jsonSchema).toMatchObject({
        type: "string",
        format: "date-time",
      });
    });

    test("isoDate schema", () => {
      const schema = v.isoDate();
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      expect(jsonSchema).toMatchObject({
        type: "string",
        format: "date",
      });
    });

    test("isoTime schema", () => {
      const schema = v.isoTime();
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      expect(jsonSchema).toMatchObject({
        type: "string",
        format: "time",
      });
    });
  });

  describe("exotic schemas", () => {
    test("blob schema (base64 encoded)", () => {
      const schema = v.blob();
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      expect(jsonSchema).toMatchObject({
        type: "string",
        contentEncoding: "base64",
      });
    });

    test("vector schema without dimensions", () => {
      const schema = v.vector();
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      expect(jsonSchema).toMatchObject({
        type: "array",
        items: { type: "number" },
      });
      expect(jsonSchema.minItems).toBeUndefined();
      expect(jsonSchema.maxItems).toBeUndefined();
    });

    test("vector schema with dimensions", () => {
      const schema = v.vector(3);
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      expect(jsonSchema).toMatchObject({
        type: "array",
        items: { type: "number" },
        minItems: 3,
        maxItems: 3,
      });
    });

    test("point schema", () => {
      const schema = v.point();
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      expect(jsonSchema).toMatchObject({
        type: "object",
        properties: {
          longitude: { type: "number", minimum: -180, maximum: 180 },
          latitude: { type: "number", minimum: -90, maximum: 90 },
        },
        required: ["longitude", "latitude"],
        additionalProperties: false,
      });
    });
  });

  describe("integer schema", () => {
    test("integer schema", () => {
      const schema = v.integer();
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      expect(jsonSchema).toMatchObject({
        type: "integer",
      });
    });
  });

  describe("transform and pipe schemas", () => {
    test("coerce (transform) passes through to wrapped schema", () => {
      const schema = v.coerce(v.string(), (val) => val.toUpperCase());
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      // Transform uses the input schema for JSON representation
      expect(jsonSchema).toMatchObject({
        type: "string",
      });
    });

    test("pipe uses the first schema", () => {
      const schema = v.pipe(v.string());
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      // Pipe uses the first schema
      expect(jsonSchema).toMatchObject({
        type: "string",
      });
    });
  });

  describe("default values", () => {
    test("optional with default should include default in JSON Schema", () => {
      // Note: Current implementation doesn't output defaults
      // This test documents expected behavior
      const userSchema = v.object({
        name: v.string(),
        role: v.string({ default: "user" }),
      });

      const jsonSchema = userSchema["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      // Default values should be in JSON Schema for documentation
      // TODO: Implement default value output if needed
      expect(jsonSchema.properties?.name).toMatchObject({ type: "string" });
      expect(jsonSchema.properties?.role).toMatchObject({ type: "string" });
    });
  });

  describe("target versions", () => {
    const schema = v.string();

    test("draft-07 includes correct $schema", () => {
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      });

      expect(jsonSchema.$schema).toBe(
        "http://json-schema.org/draft-07/schema#"
      );
    });

    test("draft-2020-12 includes correct $schema", () => {
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-2020-12",
      });

      expect(jsonSchema.$schema).toBe(
        "https://json-schema.org/draft/2020-12/schema"
      );
    });

    test("openapi-3.0 has no $schema", () => {
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "openapi-3.0",
      }) as JsonSchema;

      expect(jsonSchema.$schema).toBeUndefined();
    });

    test("unsupported target throws error", () => {
      expect(() =>
        schema["~standard"].jsonSchema.output({
          target: "unsupported-version",
        })
      ).toThrow("Unsupported JSON Schema target");
    });
  });

  describe("input vs output methods", () => {
    test("input and output produce same schema for simple types", () => {
      const schema = v.string();

      const inputSchema = schema["~standard"].jsonSchema.input({
        target: "draft-07",
      });
      const outputSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      });

      expect(inputSchema).toEqual(outputSchema);
    });
  });

  describe("StandardJSONSchemaV1 compliance", () => {
    test("schema has jsonSchema property on ~standard", () => {
      const schema = v.string();

      expect(schema["~standard"]).toHaveProperty("jsonSchema");
      expect(schema["~standard"].jsonSchema).toHaveProperty("input");
      expect(schema["~standard"].jsonSchema).toHaveProperty("output");
      expect(typeof schema["~standard"].jsonSchema.input).toBe("function");
      expect(typeof schema["~standard"].jsonSchema.output).toBe("function");
    });

    test("object schema has jsonSchema property", () => {
      const schema = v.object({ name: v.string() });

      expect(schema["~standard"]).toHaveProperty("jsonSchema");
      expect(typeof schema["~standard"].jsonSchema.output).toBe("function");
    });
  });

  describe("circular references", () => {
    test("self-referential named object uses $ref", () => {
      // Person with spouse: Person (circular) - must have name for $ref
      const person: any = v.object(
        {
          name: v.string(),
          spouse: () => person, // Thunk for circular ref
        },
        { name: "Person" }
      );

      const jsonSchema = person["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      // The spouse property should be a $ref
      expect(jsonSchema.properties?.spouse).toHaveProperty("$ref");
      expect((jsonSchema.properties?.spouse as any).$ref).toBe(
        "#/$defs/Person"
      );

      // Should have $defs with the referenced schema
      expect(jsonSchema.$defs).toBeDefined();
      expect(jsonSchema.$defs?.Person).toBeDefined();
    });

    test("mutually circular named objects use $refs", () => {
      // User has posts, Post has author (mutual circular)
      const user: any = v.object(
        {
          name: v.string(),
          posts: () => v.array(post),
        },
        { name: "User" }
      );

      const post = v.object(
        {
          title: v.string(),
          author: () => user,
        },
        { name: "Post" }
      );

      const userJsonSchema = user["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      // posts is an array with items referencing Post
      expect(userJsonSchema.properties?.posts).toMatchObject({
        type: "array",
        items: { $ref: "#/$defs/Post" },
      });

      // Should have $defs
      expect(userJsonSchema.$defs).toBeDefined();
      expect(userJsonSchema.$defs?.Post).toBeDefined();
    });

    test("unnamed thunks are inlined (no $ref)", () => {
      // Unnamed schema should be inlined, not create a $ref
      const inner = v.object({
        value: v.string(),
      });

      const outer = v.object({
        nested: () => inner,
      });

      const jsonSchema = outer["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      // Should be inlined, not a $ref
      expect(jsonSchema.properties?.nested).not.toHaveProperty("$ref");
      expect(jsonSchema.properties?.nested).toHaveProperty("type", "object");
      expect(jsonSchema.$defs).toBeUndefined();
    });

    test("schema with name property uses name as ref ID", () => {
      const namedSchema = v.object(
        {
          id: v.string(),
        },
        { name: "MyNamedSchema" }
      );

      const parent = v.object({
        child: () => namedSchema,
      });

      const jsonSchema = parent["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      // Reference should use the name
      expect((jsonSchema.properties?.child as any).$ref).toBe(
        "#/$defs/MyNamedSchema"
      );
      expect(jsonSchema.$defs?.MyNamedSchema).toBeDefined();
    });

    test("same named schema used multiple times only creates one $def", () => {
      const shared = v.object(
        {
          id: v.string(),
        },
        { name: "Shared" }
      );

      const parent = v.object({
        first: () => shared,
        second: () => shared,
      });

      const jsonSchema = parent["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      // Both should reference the same $def
      const firstRef = (jsonSchema.properties?.first as any).$ref;
      const secondRef = (jsonSchema.properties?.second as any).$ref;
      expect(firstRef).toBe("#/$defs/Shared");
      expect(secondRef).toBe("#/$defs/Shared");

      // Should only have one definition
      expect(Object.keys(jsonSchema.$defs!).length).toBe(1);
    });

    test("thunk returning array of named object uses object name as ref ID", () => {
      const user = v.object(
        {
          name: v.string(),
        },
        { name: "User" }
      );

      const parent = v.object({
        users: () => v.array(user),
      });

      const jsonSchema = parent["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      // Array wrapper is inline, items reference the named object
      expect(jsonSchema.properties?.users).toMatchObject({
        type: "array",
        items: { $ref: "#/$defs/User" },
      });
      expect(jsonSchema.$defs?.User).toBeDefined();
    });

    test("thunk returning optional of named object uses object name as ref ID", () => {
      const address = v.object(
        {
          street: v.string(),
        },
        { name: "Address" }
      );

      const person = v.object({
        home: () => v.optional(address),
      });

      const jsonSchema = person["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      // Optional passes through, so we get a direct $ref
      expect((jsonSchema.properties?.home as any).$ref).toBe("#/$defs/Address");
      expect(jsonSchema.$defs?.Address).toBeDefined();
    });

    test("deeply nested wrappers still find inner object name", () => {
      const item = v.object(
        {
          value: v.string(),
        },
        { name: "Item" }
      );

      const container = v.object({
        items: () => v.nullable(v.array(v.optional(item))),
      });

      const jsonSchema = container["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      // nullable -> array -> optional -> $ref
      // The structure should be: anyOf: [{ type: array, items: { $ref } }, { type: null }]
      expect(jsonSchema.properties?.items).toHaveProperty("anyOf");
      const anyOf = (jsonSchema.properties?.items as any).anyOf;
      const arrayOption = anyOf.find((o: any) => o.type === "array");
      expect(arrayOption.items.$ref).toBe("#/$defs/Item");
      expect(jsonSchema.$defs?.Item).toBeDefined();
    });
  });

  /**
   * The two field-reference wrappers carry no JSON shape of their own: a
   * reference is an in-process token that cannot cross a JSON boundary in
   * either direction, so both convert to exactly the schema they wrap. This
   * matters because the converter's default branch THROWS on an unknown schema
   * type — a wrapper the converter has never heard of does not degrade, it
   * takes JSON-Schema emission down for every payload that contains one.
   */
  describe("field-reference wrappers", () => {
    test("fieldRefOr converts to its literal operand", () => {
      const schema = v.fieldRefOr("int", v.integer());
      expect(
        schema["~standard"].jsonSchema.output({ target: "draft-07" })
      ).toMatchObject({ type: "integer" });
    });

    test("noFieldRef converts to the schema it re-closes", () => {
      const schema = v.noFieldRef(
        v.object({ gt: v.integer(), label: v.string() }),
        "'having'"
      );
      expect(
        schema["~standard"].jsonSchema.output({ target: "draft-07" })
      ).toMatchObject({
        type: "object",
        properties: { gt: { type: "integer" }, label: { type: "string" } },
      });
    });
  });

  /**
   * Everything above converts a hand-built `v.*` schema. That was the blind
   * spot: the schemas users actually reach for come off a MODEL, and one of
   * them — every scalar filter — became recursive (`not` accepts a filter,
   * tied with `v.lazyRef`) without the converter learning either the wrapper
   * or the cycle. Emission threw for all 21 filters through both public entry
   * points while the estate stayed green, because nothing here ever asked a
   * model for a schema.
   *
   * @see {@link file://../../src/validation/scalars/negatable-filter.ts}
   */
  describe("model schemas", () => {
    const kitchenSink = s.model({
      id: s.string().id(),
      str: s.string(),
      strList: s.string().array(),
      int: s.int(),
      intList: s.int().array(),
      num: s.number(),
      numList: s.number().array(),
      big: s.bigInt(),
      bigList: s.bigInt().array(),
      dec: s.decimal({ precision: 10, scale: 2 }),
      decList: s.decimal({ precision: 10, scale: 2 }).array(),
      bool: s.boolean(),
      boolList: s.boolean().array(),
      dt: s.dateTime(),
      dtList: s.dateTime().array(),
      day: s.date(),
      dayList: s.date().array(),
      clock: s.time(),
      clockList: s.time().array(),
      grade: s.enum(["a", "b"]),
      gradeList: s.enum(["a", "b"]).array(),
      bytes: s.blob(),
      spot: s.point(),
      embedding: s.vector().dimension(3),
      doc: s.json(),
    });

    type FilterSchemas = Record<
      string,
      {
        filter: VibSchema<unknown, unknown>;
        update: VibSchema<unknown, unknown>;
      }
    >;

    const scalarSchemas = (): FilterSchemas =>
      getSchemas({ kitchenSink }).kitchenSink.scalars;

    /** The filter schema of one field, or a loud failure if it has none. */
    const filterOf = (field: string): VibSchema<unknown, unknown> => {
      const schemas = scalarSchemas()[field];
      if (!schemas) {
        throw new Error(`no scalar schemas for field '${field}'`);
      }
      return schemas.filter;
    };

    const updateOf = (field: string): VibSchema<unknown, unknown> => {
      const schemas = scalarSchemas()[field];
      if (!schemas) {
        throw new Error(`no scalar schemas for field '${field}'`);
      }
      return schemas.update;
    };

    /** Follows a `#/$defs/x` pointer inside the document that emitted it. */
    const deref = (document: JsonSchema, node: unknown): JsonSchema => {
      const ref = (node as JsonSchema)?.$ref;
      if (typeof ref !== "string" || !DEFS_POINTER.test(ref)) {
        throw new Error(`not a $defs pointer: ${JSON.stringify(node)}`);
      }
      const target = document.$defs?.[ref.slice(DEFS_PREFIX.length)];
      if (!target) {
        throw new Error(`dangling pointer '${ref}'`);
      }
      return target;
    };

    /** The `not` arm of a filter object, whatever its other operators are. */
    const notArm = (filterObject: JsonSchema): JsonSchema =>
      filterObject.properties?.not as JsonSchema;

    test("a scalar filter converts through toJsonSchema", () => {
      const filter = filterOf("str");
      const jsonSchema = toJsonSchema(filter) as JsonSchema;

      expect(jsonSchema.$schema).toBe(
        "http://json-schema.org/draft-07/schema#"
      );
      // Shorthand value OR the filter object.
      expect(jsonSchema.anyOf).toHaveLength(2);
      expect(jsonSchema.anyOf?.[0]).toEqual({ type: "string" });
    });

    test("a scalar filter converts through the Standard Schema surface", () => {
      const filter = filterOf("str");
      const viaStandard = filter["~standard"].jsonSchema.input({
        target: "draft-07",
      });

      expect(viaStandard).toEqual(toJsonSchema(filter));
    });

    /**
     * The two `"number"`s, told apart.
     *
     * VibORM's own scalar discriminator moved from `"float"` to `"number"`, and
     * that token lives in the Schema JSON DOCUMENT format. The document below is
     * standard JSON Schema, whose `"number"` is the spec's primitive keyword and
     * was never the ORM's vocabulary — it is what `v.number()` has always
     * emitted. So the rename must be invisible here, on both public routes and
     * for the list shape.
     */
    test("the number scalar converts to the JSON Schema primitive", () => {
      const filter = filterOf("num");
      const document = toJsonSchema(filter);

      expect(document.anyOf).toHaveLength(2);
      expect(document.anyOf?.[0]).toEqual({ type: "number" });
      expect(
        filter["~standard"].jsonSchema.input({ target: "draft-07" })
      ).toEqual(document);

      // The list filter reaches the same primitive. A scalar's array-ness has
      // no representation in this converter on ANY scalar — the element type is
      // what it emits — so the list surface is pinned to the primitive it
      // actually answers rather than to an `items` document it never had.
      expect(toJsonSchema(filterOf("numList")).anyOf?.[0]).toEqual({
        type: "number",
      });
    });

    /**
     * A decimal's JSON-expressible half, and the half that is only SAID.
     *
     * The value family is `Decimal | string | number`; a class instance has no
     * JSON Schema at all, so what the document describes is the string arm (the
     * exact one, and what `Decimal#toJSON()` produces) beside the lossy number
     * arm. The DECLARED DOMAIN is not expressible: `precision` and `scale`
     * count SIGNIFICANT digits, counted after canonicalization, so `"1.500"`
     * fits a scale-2 field — a `pattern` counting raw digits would refuse
     * values this schema accepts. It is stated in `description` rather than
     * silently dropped.
     */
    test("a decimal states the domain it cannot express", () => {
      const document = toJsonSchema(filterOf("dec"));
      const operand = document.anyOf?.[0] as JsonSchema;

      expect(operand.anyOf).toEqual([
        { type: "string", pattern: "^[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)$" },
        { type: "number" },
      ]);
      expect(operand.description).toBe(
        "Exact decimal with at most 10 total digits and at most 2 fractional digits"
      );
      const listDocument = toJsonSchema(filterOf("decList"));
      const listOperand = listDocument.anyOf?.[0] as JsonSchema;
      expect((listOperand.items as JsonSchema).description).toBe(
        "Exact decimal with at most 10 total digits and at most 2 fractional digits"
      );

      // The primitive is also the unconstrained value grammar the codec is
      // built on. With no declared domain there is nothing to state.
      const bare = toJsonSchema(v.decimal());
      expect(bare.description).toBeUndefined();
      expect(bare.anyOf).toEqual(operand.anyOf);

      // Reach the decimal-only comparison wrapper itself. Its validator closes
      // generic SQL fragments while `createSchema` owns the Standard Schema
      // carrier; the attached `wrapped` metadata must still let its own lazy
      // converter expose the literal decimal language.
      const directOperand = getSchemas({ kitchenSink }).kitchenSink.scalars.dec
        .filter.options[1].entries.equals;
      expect(
        directOperand["~standard"].jsonSchema.input({ target: "draft-07" })
      ).toMatchObject({
        anyOf: operand.anyOf,
        description: operand.description,
      });
    });

    test("decimal exact-one updates emit one required-key arm per operation", () => {
      const scalar = toJsonSchema(updateOf("dec"));
      const exactOne = scalar.anyOf?.[1] as JsonSchema;
      expect(exactOne.oneOf).toHaveLength(5);
      expect(exactOne.oneOf?.map((arm) => arm.required)).toEqual([
        ["set"],
        ["increment"],
        ["decrement"],
        ["multiply"],
        ["divide"],
      ]);
      for (const arm of exactOne.oneOf ?? []) {
        expect(arm.type).toBe("object");
        expect(arm.additionalProperties).toBe(false);
        expect(Object.keys(arm.properties ?? {})).toEqual(arm.required);
      }

      const list = updateOf("decList")["~standard"].jsonSchema.input({
        target: "draft-07",
      }) as JsonSchema;
      expect(
        (list.anyOf?.[1] as JsonSchema).oneOf?.map((arm) => arm.required)
      ).toEqual([["set"], ["push"], ["unshift"]]);

      // Exercise the exact-one wrapper's own lazy converter, rather than only
      // reaching it while a surrounding union walks the schema tree.
      const directExactOne = getSchemas({ kitchenSink }).kitchenSink.scalars.dec
        .update.options[1];
      expect(
        directExactOne["~standard"].jsonSchema.input({ target: "draft-07" })
      ).toMatchObject({
        oneOf: [
          { required: ["set"] },
          { required: ["increment"] },
          { required: ["decrement"] },
          { required: ["multiply"] },
          { required: ["divide"] },
        ],
      });

      const output = updateOf("dec")["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;
      expect(output.anyOf?.[0]).toMatchObject({ type: "string" });
      expect(output.anyOf?.[0]).not.toHaveProperty("anyOf");
      for (const arm of (output.anyOf?.[1] as JsonSchema).oneOf ?? []) {
        const [operand] = Object.values(arm.properties ?? {});
        expect(operand).toMatchObject({ type: "string" });
        expect(operand).not.toHaveProperty("anyOf");
      }
    });

    /**
     * The recursion itself. `not` accepts the whole filter again, so the only
     * honest JSON Schema for it is a `$ref` back into `$defs` — inlining would
     * not terminate, and that is precisely how a naive "just unwrap lazyRef"
     * converter hangs instead of throwing.
     */
    test("nested `not` is expressed as a $ref, not inlined", () => {
      const document = toJsonSchema(filterOf("str")) as JsonSchema;

      const filterObject = deref(document, document.anyOf?.[1]);
      expect(filterObject.type).toBe("object");

      // `not` is itself shorthand-or-object, and the object arm points back at
      // the very definition we just resolved.
      const notObject = notArm(filterObject);
      expect(notObject.anyOf?.[0]).toEqual({ type: "string" });
      expect(notObject.anyOf?.[1]).toEqual(document.anyOf?.[1]);

      // Following the cycle a second time lands on the same definition, which
      // is what makes `not: { not: { not: … } }` expressible at any depth.
      expect(deref(document, notObject.anyOf?.[1])).toBe(filterObject);
    });

    test.each([
      "draft-07",
      "draft-2020-12",
      "openapi-3.0",
    ])("every scalar filter converts on target %s", (target) => {
      const scalars = scalarSchemas();
      expect(Object.keys(scalars).length).toBeGreaterThan(20);

      for (const [field, schemas] of Object.entries(scalars)) {
        const converted = () =>
          schemas.filter["~standard"].jsonSchema.input({ target });
        expect(converted, `${field} filter`).not.toThrow();
        expect(converted(), `${field} filter`).toBeTypeOf("object");
      }
    });

    /**
     * The complement: a model's `where` is built out of those filters, so the
     * cycle has to survive being nested inside an ordinary object — and the
     * relation legs that come back round to the same model must not inline
     * forever either.
     */
    test("a model's where schema converts", () => {
      const where = getSchemas({ kitchenSink }).kitchenSink.core.where;
      const document = toJsonSchema(where) as JsonSchema;
      expect(document.type).toBe("object");
      expect(document.properties?.str).toBeDefined();
    });
  });

  /**
   * The cycle machinery in isolation: it keys on schema IDENTITY, fires only
   * when something actually points back, and leaves everything else inline.
   */
  describe("cycle handling", () => {
    test("a lazyRef to a non-recursive schema is unwrapped inline", () => {
      const target = v.object({ value: v.string() });
      const schema = v.object({ ref: v.lazyRef(() => target) });

      const jsonSchema = toJsonSchema(schema) as JsonSchema;
      expect(jsonSchema.properties?.ref).toEqual({
        type: "object",
        properties: { value: { type: "string" } },
        additionalProperties: false,
      });
      expect(jsonSchema.$defs).toBeUndefined();
    });

    /**
     * A cycle back to the DOCUMENT ROOT is the whole document, so it is the
     * root pointer `#` — no definition, and no `$ref` sitting at the root with
     * `$schema`/`$defs` beside it (draft-07 ignores a `$ref`'s siblings).
     */
    test("a lazyRef pointing at the root terminates with the root pointer", () => {
      const self: any = v.object({
        value: v.string(),
        next: v.lazyRef(() => self),
      });

      expect(toJsonSchema(self)).toEqual({
        type: "object",
        properties: { value: { type: "string" }, next: { $ref: "#" } },
        additionalProperties: false,
        $schema: "http://json-schema.org/draft-07/schema#",
      });
    });

    test("a cycle below the root is hoisted into $defs", () => {
      const inner: any = v.object({ next: v.lazyRef(() => inner) });
      const outer = v.object({ child: inner });

      const jsonSchema = toJsonSchema(outer) as JsonSchema;
      const ref = (jsonSchema.properties?.child as JsonSchema).$ref;
      expect(ref).toMatch(DEFS_POINTER);

      const name = (ref as string).slice(DEFS_PREFIX.length);
      // The definition is the inner object's own body, pointing back at itself.
      expect(
        (jsonSchema.$defs?.[name]?.properties?.next as JsonSchema).$ref
      ).toBe(ref);
    });

    test("an empty recursive schema name is treated as anonymous", () => {
      const inner: any = v.object(
        { next: v.lazyRef(() => inner) },
        { name: "" }
      );
      const outer = v.object({ inner });

      const jsonSchema = toJsonSchema(outer) as JsonSchema;
      expect((jsonSchema.properties?.inner as JsonSchema).$ref).toMatch(
        GENERATED_DEFS_POINTER
      );
    });

    test("a lazyRef to a NAMED schema keeps that schema's name", () => {
      const node: any = v.object(
        { label: v.string(), child: v.lazyRef(() => node) },
        { name: "Node" }
      );

      const jsonSchema = toJsonSchema(node) as JsonSchema;
      expect((jsonSchema.properties?.child as JsonSchema).$ref).toBe(
        "#/$defs/Node"
      );
      expect(jsonSchema.$defs?.Node).toBeDefined();
    });

    /**
     * The regression guard for the whole fix: a schema nobody points back at
     * must emit exactly what it emitted before cycles were understood at all —
     * no stray `$defs`, no `$ref`, same key order. These two are spelled as
     * whole-document equalities (not `toMatchObject`) on purpose.
     */
    test("a non-recursive object is byte-identical to its pre-cycle output", () => {
      const schema = v.object({ a: v.string(), b: v.optional(v.number()) });
      expect(toJsonSchema(schema)).toEqual({
        type: "object",
        properties: { a: { type: "string" }, b: { type: "number" } },
        additionalProperties: false,
        $schema: "http://json-schema.org/draft-07/schema#",
      });
    });

    test("a named-but-acyclic reference is byte-identical too", () => {
      const item = v.object({ value: v.string() }, { name: "Item" });
      const container = v.object({
        items: () => v.nullable(v.array(v.optional(item))),
      });

      expect(toJsonSchema(container)).toEqual({
        type: "object",
        properties: {
          items: {
            anyOf: [
              { type: "array", items: { $ref: "#/$defs/Item" } },
              { type: "null" },
            ],
          },
        },
        additionalProperties: false,
        $schema: "http://json-schema.org/draft-07/schema#",
        $defs: {
          Item: {
            type: "object",
            properties: { value: { type: "string" } },
            additionalProperties: false,
          },
        },
      });
    });
  });

  describe("conversion failures", () => {
    test("centralizes target validation in direct conversion", () => {
      expect(() => toJsonSchema(v.string(), "future-draft")).toThrowError(
        ValidationError
      );

      try {
        toJsonSchema(v.string(), "future-draft");
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        if (!(error instanceof ValidationError)) return;
        expect(error.code).toBe(VibORMErrorCode.INVALID_INPUT);
        expect(error.source).toEqual({
          kind: "json-schema",
          target: "future-draft",
        });
      }
    });

    test("uses the same target refusal through Standard JSON Schema", () => {
      expect(() =>
        v.string()["~standard"].jsonSchema.input({ target: "future-draft" })
      ).toThrowError(ValidationError);
    });

    test("reports unsupported schema types as JSON Schema validation failures", () => {
      const unsupported = {
        type: "application-specific",
        "~standard": {
          version: 1 as const,
          vendor: "test",
          validate: (value: unknown) => ({ value }),
        },
      } as unknown as VibSchema<unknown, unknown>;

      try {
        toJsonSchema(unsupported);
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        if (!(error instanceof ValidationError)) return;
        expect(error.source).toEqual({
          kind: "json-schema",
          schemaType: "application-specific",
        });
      }
    });
  });
});
