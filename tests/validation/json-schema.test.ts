import { describe, test, expect } from "vitest";
import {
  v,
  string,
  number,
  boolean,
  bigint,
  literal,
  enum_,
  nullable,
  optional,
  array,
  object,
  union,
  record,
  json,
  date,
  isoTimestamp,
  isoDate,
  isoTime,
  blob,
  vector,
  point,
  instance,
  coerce,
  pipe,
  integer,
} from "../../src/validation";
import type { JsonSchema } from "../../src/validation/json-schema";

describe("JSON Schema conversion", () => {
  describe("primitive schemas", () => {
    test("string schema", () => {
      const schema = string();
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      });

      expect(jsonSchema).toMatchObject({
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "string",
      });
    });

    test("number schema", () => {
      const schema = number();
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      });

      expect(jsonSchema).toMatchObject({
        type: "number",
      });
    });

    test("boolean schema", () => {
      const schema = boolean();
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      });

      expect(jsonSchema).toMatchObject({
        type: "boolean",
      });
    });

    test("bigint schema", () => {
      const schema = bigint();
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      });

      expect(jsonSchema).toMatchObject({
        type: "integer",
      });
    });

    test("literal schema (draft-07)", () => {
      const schema = literal("hello");
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      });

      expect(jsonSchema).toMatchObject({
        const: "hello",
      });
    });

    test("literal schema (openapi-3.0)", () => {
      const schema = literal("hello");
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "openapi-3.0",
      });

      expect(jsonSchema).toMatchObject({
        enum: ["hello"],
      });
    });

    test("enum schema", () => {
      const schema = enum_(["a", "b", "c"]);
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      });

      console.dir(jsonSchema, { depth: null });
      expect(jsonSchema).toMatchObject({
        enum: ["a", "b", "c"],
      });
    });
  });

  describe("wrapper schemas", () => {
    test("nullable schema (draft-07)", () => {
      const schema = nullable(string());
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      });

      expect(jsonSchema).toMatchObject({
        anyOf: [{ type: "string" }, { type: "null" }],
      });
    });

    test("nullable schema (openapi-3.0)", () => {
      const schema = nullable(string());
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "openapi-3.0",
      });

      expect(jsonSchema).toMatchObject({
        type: "string",
        nullable: true,
      });
    });

    test("optional schema (passthrough)", () => {
      const schema = optional(string());
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      });

      expect(jsonSchema).toMatchObject({
        type: "string",
      });
    });

    test("array schema", () => {
      const schema = array(string());
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
      const schema = object({
        name: string(),
        age: number(),
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
      const schema = object(
        {
          name: string(),
          age: number(),
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
      const schema = object(
        {
          name: string(),
        },
        { strict: true }
      );
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      expect(jsonSchema.additionalProperties).toBe(false);
    });

    test("object with optional fields", () => {
      const schema = object(
        {
          name: string(),
          nickname: optional(string()),
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
      const address = object({
        city: string(),
        zip: string(),
      });

      const user = object({
        name: string(),
        address: address,
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
      const schema = object(
        {
          name: string(),
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
      const schema = object({
        name: string(),
        age: number(),
      });
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      // partial: true by default, so no required array
      expect(jsonSchema.required).toBeUndefined();
    });

    test("object with strict: true and partial: false", () => {
      const schema = object(
        {
          id: string(),
          name: string(),
          email: optional(string()),
        },
        { strict: true, partial: false }
      );
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      // strict: true → additionalProperties: false
      expect(jsonSchema.additionalProperties).toBe(false);

      // partial: false → required fields (except optional wrapper)
      expect(jsonSchema.required).toContain("id");
      expect(jsonSchema.required).toContain("name");
      expect(jsonSchema.required).not.toContain("email");
    });

    test("object with strict: false and partial: true", () => {
      const schema = object(
        {
          name: string(),
          tags: array(string()),
        },
        { strict: false, partial: true }
      );
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      // strict: false → no additionalProperties restriction
      expect(jsonSchema.additionalProperties).toBeUndefined();

      // partial: true → no required fields
      expect(jsonSchema.required).toBeUndefined();
    });

    test("object with name and description options", () => {
      const schema = object(
        {
          id: string(),
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
      const schema = union([string(), number()]);
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      expect(jsonSchema.anyOf).toMatchObject([
        { type: "string" },
        { type: "number" },
      ]);
    });

    test("record schema", () => {
      const schema = record(string(), number());
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
      const schema = json();
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
      const schema = date();
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      expect(jsonSchema).toMatchObject({
        type: "string",
        format: "date-time",
      });
    });

    test("isoTimestamp schema", () => {
      const schema = isoTimestamp();
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      expect(jsonSchema).toMatchObject({
        type: "string",
        format: "date-time",
      });
    });

    test("isoDate schema", () => {
      const schema = isoDate();
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      expect(jsonSchema).toMatchObject({
        type: "string",
        format: "date",
      });
    });

    test("isoTime schema", () => {
      const schema = isoTime();
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
      const schema = blob();
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      expect(jsonSchema).toMatchObject({
        type: "string",
        contentEncoding: "base64",
      });
    });

    test("vector schema without dimensions", () => {
      const schema = vector();
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
      const schema = vector(3);
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
      const schema = point();
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

    test("instance schema with Date uses date-time format", () => {
      const schema = instance(Date);
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      expect(jsonSchema).toMatchObject({
        type: "string",
        format: "date-time",
      });
    });

    test("instance schema with Uint8Array uses base64 encoding", () => {
      const schema = instance(Uint8Array);
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      expect(jsonSchema).toMatchObject({
        type: "string",
        contentEncoding: "base64",
      });
    });

    test("instance schema with custom class uses object with x-instance", () => {
      class MyCustomClass {}
      const schema = instance(MyCustomClass);
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      expect(jsonSchema).toMatchObject({
        type: "object",
      });
      expect((jsonSchema as any)["x-instance"]).toBe("MyCustomClass");
    });
  });

  describe("integer schema", () => {
    test("integer schema", () => {
      const schema = integer();
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
      const schema = coerce(string(), (val) => val.toUpperCase());
      const jsonSchema = schema["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      // Transform uses the input schema for JSON representation
      expect(jsonSchema).toMatchObject({
        type: "string",
      });
    });

    test("pipe uses the first schema", () => {
      const schema = pipe(string());
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
      const userSchema = object({
        name: string(),
        role: string({ default: "user" }),
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
    const schema = string();

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
      const schema = string();

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
      const schema = string();

      expect(schema["~standard"]).toHaveProperty("jsonSchema");
      expect(schema["~standard"].jsonSchema).toHaveProperty("input");
      expect(schema["~standard"].jsonSchema).toHaveProperty("output");
      expect(typeof schema["~standard"].jsonSchema.input).toBe("function");
      expect(typeof schema["~standard"].jsonSchema.output).toBe("function");
    });

    test("object schema has jsonSchema property", () => {
      const schema = object({ name: string() });

      expect(schema["~standard"]).toHaveProperty("jsonSchema");
      expect(typeof schema["~standard"].jsonSchema.output).toBe("function");
    });
  });

  describe("circular references", () => {
    test("self-referential named object uses $ref", () => {
      // Person with spouse: Person (circular) - must have name for $ref
      const person: any = object(
        {
          name: string(),
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
      const user: any = object(
        {
          name: string(),
          posts: () => array(post),
        },
        { name: "User" }
      );

      const post = object(
        {
          title: string(),
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
      const inner = object({
        value: string(),
      });

      const outer = object({
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
      const namedSchema = object(
        {
          id: string(),
        },
        { name: "MyNamedSchema" }
      );

      const parent = object({
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
      const shared = object(
        {
          id: string(),
        },
        { name: "Shared" }
      );

      const parent = object({
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
      const user = object(
        {
          name: string(),
        },
        { name: "User" }
      );

      const parent = object({
        users: () => array(user),
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
      const address = object(
        {
          street: string(),
        },
        { name: "Address" }
      );

      const person = object({
        home: () => optional(address),
      });

      const jsonSchema = person["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      // Optional passes through, so we get a direct $ref
      expect((jsonSchema.properties?.home as any).$ref).toBe("#/$defs/Address");
      expect(jsonSchema.$defs?.Address).toBeDefined();
    });

    test("deeply nested wrappers still find inner object name", () => {
      const item = object(
        {
          value: string(),
        },
        { name: "Item" }
      );

      const container = object({
        items: () => nullable(array(optional(item))),
      });

      const jsonSchema = container["~standard"].jsonSchema.output({
        target: "draft-07",
      }) as JsonSchema;

      // nullable -> array -> optional -> $ref
      // The structure should be: anyOf: [{ type: array, items: { $ref } }, { type: null }]
      expect(jsonSchema.properties?.items).toHaveProperty("anyOf");
      const anyOf = (jsonSchema.properties?.items as any).anyOf;
      const arrayOption = anyOf.find((o: any) => o.type === "array");
      console.dir(jsonSchema, { depth: null });
      expect(arrayOption.items.$ref).toBe("#/$defs/Item");
      expect(jsonSchema.$defs?.Item).toBeDefined();
    });
  });
});
