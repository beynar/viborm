# Common Validators Reference

## Overview

With VibORM's simplified validation API, all validation logic is delegated to user-provided validators. This document provides ready-to-use validators for common validation needs that replace previously built-in methods.

## String Validators

### Length Validation

```typescript
// Minimum length validator
const minLength = (min: number) => (value: string) =>
  value.length >= min || `Must be at least ${min} characters`;

// Maximum length validator
const maxLength = (max: number) => (value: string) =>
  value.length <= max || `Must be at most ${max} characters`;

// Exact length validator
const exactLength = (length: number) => (value: string) =>
  value.length === length || `Must be exactly ${length} characters`;

// Length range validator
const lengthRange = (min: number, max: number) => (value: string) =>
  (value.length >= min && value.length <= max) ||
  `Must be between ${min} and ${max} characters`;

// Usage
const nameField = s.string();
await nameField.validate("John", minLength(2), maxLength(50));
```

### Pattern Validation

```typescript
// Regex pattern validator
const regex =
  (pattern: RegExp, message = "Invalid format") =>
  (value: string) =>
    pattern.test(value) || message;

// Email validator
const email = () => (value: string) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || "Invalid email format";

// Phone number validator (US format)
const phoneUS = () => (value: string) =>
  /^\(\d{3}\) \d{3}-\d{4}$/.test(value) ||
  "Invalid phone format (xxx) xxx-xxxx";

// UUID validator
const uuid = () => (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  ) || "Invalid UUID format";

// URL validator
const url = () => (value: string) => {
  try {
    new URL(value);
    return true;
  } catch {
    return "Invalid URL format";
  }
};

// Usage
const emailField = s.string();
await emailField.validate(
  "user@example.com",
  email(),
  minLength(5),
  maxLength(100)
);
```

### Content Validation

```typescript
// Alphanumeric only
const alphanumeric = () => (value: string) =>
  /^[a-zA-Z0-9]+$/.test(value) || "Only letters and numbers allowed";

// Letters only
const lettersOnly = () => (value: string) =>
  /^[a-zA-Z\s]+$/.test(value) || "Only letters and spaces allowed";

// No whitespace
const noWhitespace = () => (value: string) =>
  !/\s/.test(value) || "Whitespace not allowed";

// Strong password
const strongPassword = () => (value: string) =>
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/.test(
    value
  ) ||
  "Password must contain uppercase, lowercase, number, and special character";

// Usage
const usernameField = s.string();
await usernameField.validate(
  "john_doe",
  minLength(3),
  maxLength(20),
  alphanumeric()
);
```

## Number Validators

### Range Validation

```typescript
// Minimum value validator
const minValue = (min: number) => (value: number) =>
  value >= min || `Must be at least ${min}`;

// Maximum value validator
const maxValue = (max: number) => (value: number) =>
  value <= max || `Must be at most ${max}`;

// Range validator
const numberRange = (min: number, max: number) => (value: number) =>
  (value >= min && value <= max) || `Must be between ${min} and ${max}`;

// Positive number
const positive = () => (value: number) => value > 0 || "Must be positive";

// Non-negative number
const nonNegative = () => (value: number) =>
  value >= 0 || "Must be non-negative";

// Usage
const ageField = s.int();
await ageField.validate(25, minValue(0), maxValue(120));
```

### Type-Specific Validation

```typescript
// Integer validator (for float/decimal fields)
const integer = () => (value: number) =>
  Number.isInteger(value) || "Must be an integer";

// Even number
const even = () => (value: number) => value % 2 === 0 || "Must be even";

// Odd number
const odd = () => (value: number) => value % 2 !== 0 || "Must be odd";

// Multiple of a number
const multipleOf = (multiple: number) => (value: number) =>
  value % multiple === 0 || `Must be a multiple of ${multiple}`;

// Precision validator
const precision = (maxDecimals: number) => (value: number) => {
  const decimals = (value.toString().split(".")[1] || "").length;
  return (
    decimals <= maxDecimals || `Must have at most ${maxDecimals} decimal places`
  );
};

// Usage
const priceField = s.decimal();
await priceField.validate(19.99, positive(), precision(2), maxValue(1000));
```

## Date Validators

```typescript
// Date range validators
const afterDate = (date: Date) => (value: Date) =>
  value > date || `Must be after ${date.toISOString()}`;

const beforeDate = (date: Date) => (value: Date) =>
  value < date || `Must be before ${date.toISOString()}`;

const dateRange = (start: Date, end: Date) => (value: Date) =>
  (value >= start && value <= end) ||
  `Must be between ${start.toISOString()} and ${end.toISOString()}`;

// Age validation
const minimumAge = (years: number) => (birthDate: Date) => {
  const today = new Date();
  const age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();

  if (
    monthDiff < 0 ||
    (monthDiff === 0 && today.getDate() < birthDate.getDate())
  ) {
    age--;
  }

  return age >= years || `Must be at least ${years} years old`;
};

// Future date
const futureDate = () => (value: Date) =>
  value > new Date() || "Must be in the future";

// Past date
const pastDate = () => (value: Date) =>
  value < new Date() || "Must be in the past";

// Usage
const birthdateField = s.dateTime();
await birthdateField.validate(
  new Date("1990-01-01"),
  pastDate(),
  minimumAge(18)
);
```

## Array Validators

```typescript
// Array length validators
const minArrayLength = (min: number) => (value: any[]) =>
  value.length >= min || `Must have at least ${min} items`;

const maxArrayLength = (max: number) => (value: any[]) =>
  value.length <= max || `Must have at most ${max} items`;

const arrayLength = (length: number) => (value: any[]) =>
  value.length === length || `Must have exactly ${length} items`;

// Array content validators
const uniqueArray = () => (value: any[]) =>
  new Set(value).size === value.length || "All items must be unique";

const noEmptyStrings = () => (value: string[]) =>
  !value.some((item) => !item.trim()) || "Empty strings not allowed";

// Usage
const tagsField = s.string().list();
await tagsField.validate(
  ["tag1", "tag2"],
  minArrayLength(1),
  maxArrayLength(10),
  uniqueArray()
);
```

## Enum Validators

```typescript
// Enum value validator
const enumValue =
  <T extends readonly (string | number)[]>(enumValues: T) =>
  (value: any) =>
    enumValues.includes(value) || `Must be one of: ${enumValues.join(", ")}`;

// Case-insensitive enum validator
const enumValueIgnoreCase =
  <T extends readonly string[]>(enumValues: T) =>
  (value: string) =>
    enumValues.some((val) => val.toLowerCase() === value.toLowerCase()) ||
    `Must be one of: ${enumValues.join(", ")} (case insensitive)`;

// Usage
const statusEnum = ["active", "inactive", "pending"] as const;
const statusField = s.enum(statusEnum);
await statusField.validate("active", enumValue(statusEnum));
```

## JSON Validators

```typescript
// JSON schema validator (requires additional library like ajv)
const jsonSchema = (schema: any) => async (value: any) => {
  // Example with AJV (install: npm install ajv)
  // const Ajv = require('ajv');
  // const ajv = new Ajv();
  // const validate = ajv.compile(schema);
  // return validate(value) || validate.errors?.map(e => e.message).join(', ');

  // Simplified example
  return typeof value === "object" || "Must be a valid JSON object";
};

// Required properties validator
const requiredProperties = (props: string[]) => (value: any) => {
  const missing = props.filter((prop) => !(prop in value));
  return (
    missing.length === 0 || `Missing required properties: ${missing.join(", ")}`
  );
};

// Usage
const configField = s.json();
await configField.validate(
  { setting1: "value1", setting2: "value2" },
  requiredProperties(["setting1", "setting2"])
);
```

## Validator Composition

### Combining Validators

```typescript
// Create reusable validator combinations
const strongEmail = () => [
  email(),
  minLength(5),
  maxLength(254), // RFC 5321 limit
];

const username = () => [
  minLength(3),
  maxLength(20),
  alphanumeric(),
  noWhitespace(),
];

const securePassword = () => [minLength(8), maxLength(128), strongPassword()];

// Usage
const userEmailField = s.string();
await userEmailField.validate("user@example.com", ...strongEmail());

const userNameField = s.string();
await userNameField.validate("john_doe", ...username());
```

### Conditional Validators

```typescript
// Conditional validation
const conditionalValidator =
  <T>(
    condition: (value: T) => boolean,
    validator: (value: T) => true | string
  ) =>
  (value: T) =>
    !condition(value) || validator(value);

// Example: Only validate email format if value is provided (for optional fields)
const optionalEmail = () =>
  conditionalValidator((value: string) => value.length > 0, email());

// Usage
const optionalEmailField = s.string().nullable();
await optionalEmailField.validate("", optionalEmail()); // Passes
await optionalEmailField.validate("invalid", optionalEmail()); // Fails
```

## Integration with Validation Libraries

### Zod Integration

```typescript
import { z } from "zod";

const zodValidator =
  <T>(schema: z.ZodSchema<T>) =>
  async (value: unknown) => {
    const result = schema.safeParse(value);
    return (
      result.success || result.error.errors.map((e) => e.message).join(", ")
    );
  };

// Usage
const emailSchema = z.string().email().min(5).max(254);
const emailField = s.string();
await emailField.validate("user@example.com", zodValidator(emailSchema));
```

### Yup Integration

```typescript
import * as yup from "yup";

const yupValidator = (schema: yup.Schema) => async (value: any) => {
  try {
    await schema.validate(value);
    return true;
  } catch (error) {
    return error.message;
  }
};

// Usage
const emailSchema = yup.string().email().required().min(5).max(254);
const emailField = s.string();
await emailField.validate("user@example.com", yupValidator(emailSchema));
```

## Best Practices

1. **Create Validator Libraries**: Build collections of reusable validators for your domain
2. **Compose Validators**: Combine simple validators into more complex ones
3. **Use Factory Functions**: Create parameterized validators for flexibility
4. **Error Messages**: Provide clear, actionable error messages
5. **Performance**: Keep validators simple and fast for better performance
6. **Testing**: Test validators independently before using them in schemas

This approach gives you complete control over validation while maintaining clean, reusable code.
