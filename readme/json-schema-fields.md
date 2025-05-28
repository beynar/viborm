# Schema-Based JSON Fields

VibORM's JSON fields support schema-based validation and type inference using the Standard Schema V1 interface. This allows you to define strongly-typed JSON fields with automatic validation while maintaining the flexibility of JSON data.

## Overview

JSON fields in VibORM can operate in two modes:

1. **Untyped Mode** (default): For maximum flexibility, accepts any JSON-serializable data
2. **Schema Mode**: For type safety and validation, uses a Standard Schema to define structure

## Basic Usage

### Untyped JSON Fields

```ts
import { s } from "baseorm";

const user = s.model("user", {
  id: s.string().id(),
  metadata: s.json(), // type: any
  settings: s.json().nullable(), // type: any | null
  tags: s.json().list(), // type: any[]
});
```

### Schema-Based JSON Fields

```ts
import { s } from "baseorm";
import type { StandardSchemaV1 } from "baseorm/types";

// Define your schema
const userPreferencesSchema: StandardSchemaV1<
  any,
  {
    theme: "light" | "dark" | "auto";
    language: string;
    notifications: {
      email: boolean;
      push: boolean;
    };
  }
> = {
  "~standard": {
    version: 1,
    vendor: "my-app",
    validate: async (value: unknown) => {
      // Validation logic here
      // Return { value: validatedData } or { issues: [...] }
    },
    types: {
      input: {} as any,
      output: {} as {
        theme: "light" | "dark" | "auto";
        language: string;
        notifications: {
          email: boolean;
          push: boolean;
        };
      },
    },
  },
};

const user = s.model("user", {
  id: s.string().id(),
  preferences: s.json(userPreferencesSchema), // Strongly typed!
  config: s.json(configSchema).nullable(), // ConfigType | null
  history: s.json(eventSchema).list(), // EventType[]
});

// Type inference works automatically
type UserType = typeof user.infer;
// UserType.preferences is { theme: "light" | "dark" | "auto"; language: string; ... }
```

## Standard Schema Interface

VibORM uses the Standard Schema V1 interface for maximum compatibility with validation libraries:

```ts
interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown
    ) => Result<Output> | Promise<Result<Output>>;
    readonly types?: {
      readonly input: Input;
      readonly output: Output;
    };
  };
}
```

## Working with Popular Validation Libraries

### Zod Integration

```ts
import { z } from "zod";

// Zod schemas can be easily adapted
const zodSchema = z.object({
  name: z.string(),
  age: z.number().min(0).max(120),
  email: z.string().email(),
});

const adaptedSchema: StandardSchemaV1<any, z.infer<typeof zodSchema>> = {
  "~standard": {
    version: 1,
    vendor: "zod",
    validate: async (value: unknown) => {
      const result = zodSchema.safeParse(value);
      if (result.success) {
        return { value: result.data };
      }
      return {
        issues: result.error.issues.map((issue) => ({
          message: issue.message,
          path: issue.path,
        })),
      };
    },
    types: {
      input: {} as any,
      output: {} as z.infer<typeof zodSchema>,
    },
  },
};
```

### Yup Integration

```ts
import * as yup from "yup";

const yupSchema = yup.object({
  name: yup.string().required(),
  age: yup.number().required().min(0),
});

const adaptedSchema: StandardSchemaV1<any, yup.InferType<typeof yupSchema>> = {
  "~standard": {
    version: 1,
    vendor: "yup",
    validate: async (value: unknown) => {
      try {
        const validated = await yupSchema.validate(value);
        return { value: validated };
      } catch (error) {
        return {
          issues: [{ message: error.message }],
        };
      }
    },
    types: {
      input: {} as any,
      output: {} as yup.InferType<typeof yupSchema>,
    },
  },
};
```

## Validation

Schema-based JSON fields automatically validate data using the provided schema:

```ts
const userField = s.json(userPreferencesSchema);

// Valid data
const validData = {
  theme: "dark",
  language: "en-US",
  notifications: { email: true, push: false },
};

const result = await userField.validate(validData);
// { valid: true, errors: undefined }

// Invalid data
const invalidData = {
  theme: "rainbow", // Invalid theme
  language: "en-US",
  // Missing notifications
};

const result = await userField.validate(invalidData);
// { valid: false, errors: ["Theme must be light, dark, or auto", "..."] }
```

## Chainable Operations

All field modifiers work seamlessly with schema-based JSON fields:

```ts
// Nullable schema-based field
const optionalSettings = s.json(settingsSchema).nullable();
// Type: SettingsType | null

// Array of schema-validated objects
const eventHistory = s.json(eventSchema).list();
// Type: EventType[]

// Default value with schema
const configWithDefaults = s.json(configSchema).default({
  theme: "light",
  language: "en-US",
  notifications: { email: true, push: true },
});
// Type: ConfigType (with default value)

// Default value with schema
const defaultPrefs = s.json(preferencesSchema).default({
  theme: "light",
  language: "en-US",
  notifications: { email: true, push: true },
});
```

## Real-World Example

```ts
// E-commerce product with flexible attributes
const productAttributesSchema: StandardSchemaV1<
  any,
  {
    color?: string;
    size?: "XS" | "S" | "M" | "L" | "XL" | "XXL";
    material?: string;
    weight?: number;
    dimensions?: {
      width: number;
      height: number;
      depth: number;
    };
  }
> = {
  "~standard": {
    version: 1,
    vendor: "ecommerce",
    validate: async (value: unknown) => {
      // Comprehensive validation logic
      // ...
      return { value: validatedValue };
    },
    types: {
      input: {} as any,
      output: {} as ProductAttributes,
    },
  },
};

const productModel = s.model("product", {
  id: s.string().id().auto.ulid(),
  name: s.string(),
  price: s.decimal(),

  // Strongly typed product attributes
  attributes: s.json(productAttributesSchema),

  // Flexible metadata for admin use
  metadata: s.json(),

  // Product variants (array of typed objects)
  variants: s.json(productAttributesSchema).list(),

  createdAt: s.dateTime().auto.now(),
});

// Type inference provides full IntelliSense
type Product = typeof productModel.infer;
// Product.attributes is strongly typed with all possible attributes
// Product.metadata is any for maximum flexibility
// Product.variants is ProductAttributes[]
```

## Benefits

- **Type Safety**: Full TypeScript type inference from schema definitions
- **Automatic Validation**: Built-in validation using schema definitions
- **IntelliSense Support**: Complete IDE autocomplete and type checking
- **Flexibility**: Mix typed and untyped JSON fields as needed
- **Library Agnostic**: Works with any validation library via Standard Schema
- **Performance**: Validation only runs when explicitly called
- **Backward Compatible**: Existing `s.json()` calls continue to work unchanged

## Migration Guide

Existing untyped JSON fields continue to work without changes:

```ts
// ✅ This continues to work exactly as before
const legacy = s.json(); // type: any

// ✅ Add schemas gradually
const enhanced = s.json(mySchema); // type: inferred from schema
```

For gradual migration, you can start by adding schemas to critical fields and leave others untyped for maximum flexibility.
