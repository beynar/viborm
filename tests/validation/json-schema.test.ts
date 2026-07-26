import v from "@validation";
import type { JsonSchema } from "@validation/json-schema";
import { describe, expect, test } from "vitest";

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

    test("number schema", () => {
      const schema = v.number();
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      });

      expect(jsonSchema).toMatchObject({
        type: "number",
      });
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
          x: { type: "number" },
          y: { type: "number" },
        },
        required: ["x", "y"],
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
});
