# 6. Validation — Developer Specification

## Introduction

Validation ensures that data conforms to the schema before being persisted. Validation must be supported at both the field and model level, with built-in and custom validators. All validation logic must be composable, testable, and type-safe.

---

## Goals

- **Type Safety:** All validation logic must be type-safe and infer types from the schema.
- **Composability:** Validators must be composable and reusable.
- **Extensibility:** The validation system must allow easy addition of new validators.

---

## Implementation Rules

### 1. Directory & File Structure

- All validation code must reside in `/src/validation/`.
- All built-in validators must be in `/src/types/validators.ts`.
- No code outside these directories may define or modify validation logic.

### 2. Field Validation

- Each field must support attaching one or more validators via `.schema(fn)` or `.regex(pattern)`.
- Validators must be composable and support both sync and async validation.
- Built-in validators (regex, min/max, enum) must be provided.

### 3. Model Validation

- Models must support attaching validators that operate on the entire model instance.
- Model-level validators must be composable and support both sync and async validation.

### 4. Type Inference

- The validation system must use TypeScript generics to infer the types being validated.

### 5. Extensibility

- The validation system must be designed to allow future features (e.g., hooks, telemetry).
- All internal state must be accessible for future introspection.

---

## Example Usage

```ts
const user = s
  .model("user", {
    email: s.string().schema(emailRegex),
    age: s.int().schema((v) => v >= 0),
  })
  .schema((user) => user.email !== user.name);
```

---

## Deliverables

- `modelValidator.ts`, `fieldValidator.ts` in `/src/validation/`
- All built-in validators in `/src/types/validators.ts`
- Full TypeScript support and type inference
- Unit tests for all validation features

---

## Prohibited

- No decorators
- No code outside `/src/validation/` and `/src/types/` may define validation logic

---

## Review Checklist

- [ ] All validators are type-safe and composable
- [ ] All built-in validators are in `/types/validators.ts`
- [ ] No decorators are used
- [ ] Example usage compiles and infers correct types
