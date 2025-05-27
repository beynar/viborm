// Type-Safe Auto Method Demonstration
// Shows how auto methods are now properly constrained by field types

import {
  string,
  int,
  float,
  datetime,
  boolean,
  json,
} from "./src/schema/fields/index.js";

console.log("=== Type-Safe Auto Methods Demo ===\n");

// ✅ String fields have: uuid, ulid, nanoid, cuid
console.log("String Field Auto Methods:");
const userIdField = string().id().auto.uuid();
const sessionIdField = string().auto.ulid();
const tokenField = string().auto.nanoid();
const correlationField = string().auto.cuid();

console.log(`- UUID field: ${userIdField.autoGenerate}`);
console.log(`- ULID field: ${sessionIdField.autoGenerate}`);
console.log(`- NanoID field: ${tokenField.autoGenerate}`);
console.log(`- CUID field: ${correlationField.autoGenerate}\n`);

// ✅ Int fields have: increment (only int, not float/decimal)
console.log("Number Field Auto Methods:");
const counterField = int().auto.increment();
console.log(`- Int increment field: ${counterField.autoGenerate}`);

// Note: float().auto.increment() would be a compile-time error
// Note: decimal().auto.increment() would be a compile-time error
console.log(
  "- Float and decimal fields do NOT have auto.increment (only int does)\n"
);

// ✅ DateTime fields have: now, updatedAt
console.log("DateTime Field Auto Methods:");
const createdAtField = datetime().auto.now();
const updatedAtField = datetime().auto.updatedAt();

console.log(`- Now field: ${createdAtField.autoGenerate}`);
console.log(`- UpdatedAt field: ${updatedAtField.autoGenerate}\n`);

// ✅ Boolean and JSON fields have NO auto methods
console.log("Fields WITHOUT Auto Methods:");
const isActiveField = boolean();
const metadataField = json();

console.log("- Boolean fields: No auto property available");
console.log("- JSON fields: No auto property available");
console.log("- Blob fields: No auto property available");
console.log("- Enum fields: No auto property available\n");

console.log(
  "✅ Type safety ensures you can only use appropriate auto methods for each field type!"
);

// These would all be compile-time errors:
// string().auto.increment()     // ❌ increment not available on string
// int().auto.uuid()            // ❌ uuid not available on int
// datetime().auto.cuid()       // ❌ cuid not available on datetime
// boolean().auto.uuid()        // ❌ auto not available on boolean
// json().auto.nanoid()         // ❌ auto not available on json
// float().auto.increment()     // ❌ increment only available on int
