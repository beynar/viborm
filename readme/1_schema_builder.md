# 1. Schema Builder — Developer Specification

## Introduction

The Schema Builder is the foundation of our ORM. Its purpose is to allow users to define database models in a fully type-safe, chainable, and declarative way, without decorators. The schema builder must support all scalar types for MySQL and Postgres, relations (one-to-one, one-to-many, many-to-many), enums, JSONB, default values, and custom validators. All type helpers must reside in the `/types` directory. The API must be ergonomic, intuitive, and provide maximum type inference for downstream query building.

---

## Goals

- **Type Safety:** All model and field definitions must be fully type-safe and infer types for use in queries.
- **Chainable API:** The schema definition must use a chainable, functional API (no decorators).
- **Extensibility:** The schema builder must be easily extensible for future features (e.g., migrations, hooks).
- **Validation:** Built-in support for field and model-level validation.
- **No Decorators:** All configuration must be done via method chaining and object literals.

---

## Implementation Rules

### 1. Directory & File Structure

- All schema builder code must reside in `/src/schema/`.
- All type helpers, scalar types, enums, and validators must be in `/src/types/`.
- No code outside these directories may define or modify schema logic.

### 2. Model Class

- Implement a `Model` class (or factory function) that allows users to define a model with a field definition object.
- The API must look like:
  ```ts
  const user = s.model({ ...fields }).map("users");
  ```
- The model definition must:
  - Store the model name and optional database table mapping.
  - Store a map of field definitions.
  - Store a map of relation definitions.
  - Store index and unique constraint definitions.
  - Expose methods to introspect the model (for future migration and validation use).
- The model must be type-safe: the resulting `user` object must have a TypeScript type representing its fields and relations.
- **See [Model Class Specification](1.1_model_class.md) for detailed implementation requirements including indexes and database mapping.**

### 3. Field Class

- Implement a `Field` class (or factory) with chainable methods for:
  - Setting the type (string, int, float, boolean, date, jsonb, enum, etc.).
  - Setting default values.
  - Setting custom validators (including regex).
  - Marking as primary key, unique, nullable, etc.
  - Marking as auto-increment or ULID/UUID.
- Example:
  ```ts
  id: s.string().id().auto.ulid();
  email: s.string().validator(emailRegex);
  ```
- All scalar types and helpers must be imported from `/types/scalars.ts`.

### 4. Relation Class

- Implement a `Relation` class (or factory) with chainable methods for:
  - Defining one-to-one, one-to-many, and many-to-many relations.
  - Setting the referenced model and field.
  - Setting cascade options (on delete, on update).
  - Naming the junction table and fields for many-to-many (with sensible defaults).
- Example:
  ```ts
  friends: s.relation.many(() => user);
  lover: s.relation
    .one(() => user)
    .on("id")
    .ref("id");
  ```
- Relations must be type-safe and support circular/self-references.

### 5. Type Helpers

- All type helpers (TypeScript types, interfaces, utility types) must be in `/types/`.
- Types must be generic and composable, allowing inference of model and field types from schema definitions.

### 6. Validation

- The schema builder must support attaching validators at the field and model level.
- Validators must be composable and support both sync and async validation.
- All built-in validators (e.g., regex, min/max, enum) must be in `/types/validators.ts`.

### 7. Extensibility

- The schema builder must be designed to allow future features:
  - SQL migration generation.
  - Lifecycle hooks.
  - Telemetry.
- All internal state must be accessible for future introspection.

### 8. No Decorators

- Do not use TypeScript or JavaScript decorators anywhere in the schema builder.

---

## Example Usage

```ts
import { s } from "viborm";

const user = s
  .model({
    id: s.string().id().auto.ulid(),
    name: s.string(),
    email: s.string().validator(emailRegex),
    password: s.string(),
    friends: s.relation.many(() => user),
    lover: s.relation
      .one(() => user)
      .on("id")
      .ref("id"),
  })
  .map("users");
```

---

## Deliverables

- `model.ts`, `field.ts`, `relation.ts` in `/src/schema/`
- All type helpers and validators in `/src/types/`
- Full TypeScript support and type inference
- Unit tests for all schema builder features
- **[Model Class Specification](1.1_model_class.md)** - Detailed spec for model indexes and database mapping

---

## Prohibited

- No decorators
- No runtime type generation (all types must be inferred at compile time)
- No code outside `/src/schema/` and `/src/types/` may define schema logic

---

## Review Checklist

- [ ] All model/field/relation definitions are type-safe and chainable
- [ ] All type helpers are in `/types/`
- [ ] All validators are composable and testable
- [ ] No decorators are used
- [ ] Example usage compiles and infers correct types
