// Simplified Auto Methods Demo
// Demonstrates the new direct auto-generation methods
import { s } from "./src/schema/index.js";

// ✅ String fields with direct auto methods (no more .auto. nesting)
const stringAutoFields = {
  // UUID generation
  uuid: s.string().uuid(),

  // ULID generation
  ulid: s.string().ulid(),

  // NanoID generation
  nanoid: s.string().nanoid(),

  // CUID generation
  cuid: s.string().cuid(),

  // Can still chain with other methods
  idWithUuid: s.string().id().uuid(),
  uniqueUlid: s.string().unique().ulid(),
};

// ✅ Number fields with direct auto methods
const numberAutoFields = {
  // Auto-increment (only works with int, not float/decimal)
  counter: s.int().autoIncrement(),

  // Can chain with other methods
  idWithIncrement: s.int().id().autoIncrement(),
  uniqueCounter: s.int().unique().autoIncrement(),
};

// ✅ DateTime fields with direct auto methods
const dateTimeAutoFields = {
  // Current timestamp on creation
  createdAt: s.dateTime().now(),

  // Auto-update timestamp
  updatedAt: s.dateTime().updatedAt(),

  // Can chain with other methods
  nullableCreatedAt: s.dateTime().nullable().now(),
  uniqueTimestamp: s.dateTime().unique().now(),
};

// ✅ Complete user model with simplified auto methods
const userModel = s.model("user", {
  // ID with auto-generation
  id: s.string().id().ulid(),

  // Regular fields
  name: s.string(),
  email: s.string().unique(),
  age: s.int().nullable(),

  // Auto-timestamps
  createdAt: s.dateTime().now(),
  updatedAt: s.dateTime().updatedAt(),

  // Optional fields with auto-generation
  sessionId: s.string().nullable().uuid(),
  viewCount: s.int().default(0).autoIncrement(),
});

// ✅ Type inference still works perfectly
type User = typeof userModel.infer;

// Example usage showing the simplified API:
console.log("✅ Simplified Auto Methods Demo");
console.log("Before: s.string().id().auto.ulid()");
console.log("After:  s.string().id().ulid()");
console.log("");
console.log("Before: s.int().auto.increment()");
console.log("After:  s.int().autoIncrement()");
console.log("");
console.log("Before: s.dateTime().auto.now()");
console.log("After:  s.dateTime().now()");

export { userModel, stringAutoFields, numberAutoFields, dateTimeAutoFields };
export type { User };
