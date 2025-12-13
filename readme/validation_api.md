# Validation API - Simplified Approach

## Overview

VibORM provides a clean and simple validation API where the `validate()` method accepts any number of validators directly, eliminating the need for separate `validator()` methods.

All validation logic is delegated to user-provided validators. For common validation patterns (like min/max length, regex patterns, etc.), see the [Common Validators Reference](validation_validators.md).

## Core Principle

**One Method for All Validation**: Pass validators directly to `validate()` instead of registering them first.

## Field Validation

### Basic Usage

```typescript
import { s } from "viborm";

const emailField = s.string();

// Create validators
const emailValidator = (value: string) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(value) || "Invalid email format";
};

const minLengthValidator = (minLength: number) => (value: string) => {
  return (
    value.length >= minLength || `Must be at least ${minLength} characters`
  );
};

// ✅ Pass validators directly to validate()
const result = await emailField.validate(
  "user@example.com",
  emailValidator,
  minLengthValidator(5)
);

console.log(result); // { valid: true, errors: undefined }
```

### Multiple Validators

```typescript
const nameField = s.string();

const validators = [
  (val: string) => val.length > 0 || "Name is required",
  (val: string) => val.length <= 50 || "Name too long",
  (val: string) =>
    /^[a-zA-Z\s]+$/.test(val) || "Only letters and spaces allowed",
];

const result = await nameField.validate("John Doe", ...validators);
```

### Multiple Validators

```typescript
// Combine multiple validators
const ageField = s.int();

const minAge = (min: number) => (age: number) =>
  age >= min || `Must be at least ${min}`;
const maxAge = (max: number) => (age: number) =>
  age <= max || `Must be at most ${max}`;
const adultValidator = (age: number) => age >= 18 || "Must be 18 or older";

const result = await ageField.validate(
  25,
  minAge(0),
  maxAge(120),
  adultValidator
);
// Validates: type is number, >= 0, <= 120, AND >= 18
```

## Model Validation

### Basic Usage

```typescript
const userModel = s.model("user", {
  name: s.string(),
  email: s.string(),
  age: s.int(),
});

const userValidator = (user: any) => {
  return (user.name && user.email) || "Name and email are required";
};

const ageValidator = (user: any) => {
  return user.age >= 18 || "Must be 18 or older";
};

// ✅ Pass validators directly to validate()
const result = await userModel.validate(
  { name: "John", email: "john@example.com", age: 25 },
  userValidator,
  ageValidator
);
```

### Cross-Field Validation

```typescript
const registrationModel = s.model("registration", {
  password: s.string(),
  confirmPassword: s.string(),
  email: s.string(),
});

const passwordMatchValidator = (data: any) => {
  return data.password === data.confirmPassword || "Passwords must match";
};

const strongPasswordValidator = (data: any) => {
  const strongRegex =
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
  return strongRegex.test(data.password) || "Password must be strong";
};

const result = await registrationModel.validate(
  userData,
  passwordMatchValidator,
  strongPasswordValidator
);
```

## Relation Validation

### Basic Usage

```typescript
const userRelation = s.relation.one(() => User);

const relationValidator = (userId: string) => {
  return (typeof userId === "string" && userId.length > 0) || "Invalid user ID";
};

const result = await userRelation.validate("user123", relationValidator);
```

## Validation Result

All validation methods return a `ValidationResult`:

```typescript
interface ValidationResult {
  valid: boolean;
  errors?: string[] | undefined;
}
```

### Success

```typescript
{ valid: true, errors: undefined }
```

### Failure

```typescript
{
  valid: false,
  errors: [
    "Invalid email format",
    "Must be at least 5 characters"
  ]
}
```

## Standard Schema Integration

VibORM supports Standard Schema v1 validators:

```typescript
import { email, minLength } from "some-standard-schema-library";

const result = await emailField.validate(
  "test@example.com",
  email(),
  minLength(5)
);
```

## Best Practices

### 1. Reusable Validators

```typescript
// Create factory functions for common validators
const createMinLengthValidator = (min: number) => (value: string) =>
  value.length >= min || `Must be at least ${min} characters`;

const createEmailValidator = () => (value: string) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || "Invalid email format";

// Use across multiple fields
const emailValidator = createEmailValidator();
const minLength5 = createMinLengthValidator(5);
```

### 2. Validation Libraries

```typescript
// Use with existing validation libraries
import * as yup from "yup";

const yupValidator = (schema: yup.Schema) => async (value: any) => {
  try {
    await schema.validate(value);
    return true;
  } catch (error) {
    return error.message;
  }
};

const result = await field.validate(value, yupValidator(yup.string().email()));
```

### 3. Conditional Validation

```typescript
const conditionalValidator = (value: string) => {
  if (value.startsWith("admin_")) {
    return /^admin_[a-zA-Z0-9]+$/.test(value) || "Invalid admin format";
  }
  return true; // No validation for non-admin values
};
```

## Migration from Old API

If you were using the previous `validator()` methods:

### Before (❌ Removed)

```typescript
// This no longer works
const field = s
  .string()
  .schema(emailValidator)
  .schema(minLengthValidator(5));

const result = await field.validate("test@example.com");
```

### After (✅ New API)

```typescript
const field = s.string();

const result = await field.validate(
  "test@example.com",
  emailValidator,
  minLengthValidator(5)
);
```

## Benefits

1. **Simpler API**: One method instead of two (`validator()` + `validate()`)
2. **More Flexible**: Validators can be applied per validation call
3. **Better Testing**: Easy to test with different validator combinations
4. **Cleaner Autocompletion**: No redundant methods cluttering the API
5. **Functional Style**: Validators are passed as arguments, more functional approach

This approach aligns with the principle of making the common case simple while keeping advanced use cases possible.
