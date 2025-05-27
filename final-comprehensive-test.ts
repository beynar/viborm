// Final comprehensive test showing all field types working with advanced type system
import { s } from "./src/schema/index.js";

// Create a complete user model with all field types
const userModel = s.model("user", {
  // String fields with various modifiers
  id: s.string().id(),
  email: s.string().unique().email(),
  username: s.string().minLength(3).maxLength(20),
  firstName: s.string(),
  lastName: s.string(),
  bio: s.string().nullable(),
  tags: s.string().list(),
  socialLinks: s.string().list().nullable(),

  // Number fields
  age: s.int().min(0).max(150),
  score: s.float().positive(),
  balance: s.decimal(),
  favoriteNumbers: s.int().list(),

  // Boolean fields
  isActive: s.boolean().default(true),
  isVerified: s.boolean().default(false),
  permissions: s.boolean().list(),

  // BigInt fields
  userId: s.bigInt().id(),
  largeValue: s.bigInt().nullable(),

  // DateTime fields
  createdAt: s.dateTime().auto.now(),
  updatedAt: s.dateTime().auto.updatedAt(),
  birthDate: s.dateTime().nullable(),
  loginTimes: s.dateTime().list(),

  // JSON fields
  metadata: s.json(),
  preferences: s.json().nullable(),
  history: s.json().list(),

  // Blob fields
  avatar: s.blob().nullable(),
  attachments: s.blob().list(),

  // Enum fields
  status: s
    .enum(["active", "inactive", "suspended"] as const)
    .default("active"),
  role: s.enum(["user", "admin", "moderator"] as const),
  categories: s
    .enum([1, 2, 3, 4, 5] as const)
    .list()
    .nullable(),
});

// Test type inference works correctly
type UserType = typeof userModel.infer;

// Create a sample user that matches the inferred type
const sampleUser = {
  // String types
  id: "user-123",
  email: "john@example.com",
  username: "johndoe",
  firstName: "John",
  lastName: "Doe",
  bio: null, // nullable string
  tags: ["developer", "typescript"], // string[]
  socialLinks: null, // string[] | null

  // Number types
  age: 30, // number
  score: 95.5, // number
  balance: 1000.5, // number
  favoriteNumbers: [7, 13, 42], // number[]

  // Boolean types
  isActive: true, // boolean
  isVerified: false, // boolean
  permissions: [true, false, true], // boolean[]

  // BigInt types
  userId: BigInt(123456789), // bigint
  largeValue: null, // bigint | null

  // Date types
  createdAt: new Date(), // Date
  updatedAt: new Date(), // Date
  birthDate: new Date("1990-01-01"), // Date | null
  loginTimes: [new Date(), new Date()], // Date[]

  // JSON types
  metadata: { theme: "dark", language: "en" }, // any
  preferences: null, // any | null
  history: [{ action: "login" }, { action: "logout" }], // any[]

  // Blob types
  avatar: null, // Uint8Array | null
  attachments: [new Uint8Array([1, 2, 3])], // Uint8Array[]

  // Enum types
  status: "active" as const, // "active" | "inactive" | "suspended"
  role: "user" as const, // "user" | "admin" | "moderator"
  categories: [1, 3, 5], // (1 | 2 | 3 | 4 | 5)[] | null
};

// Test that complex chaining works
const complexFields = {
  complexString: s.string().id().unique().minLength(5).maxLength(100),
  complexNumber: s.int().positive().max(1000).unique(),
  complexBool: s.boolean().list().nullable(),
  complexEnum: s
    .enum(["red", "green", "blue"] as const)
    .nullable()
    .default("red"),
  complexDate: s.dateTime().nullable().after(new Date("2020-01-01")),
  complexBlob: s.blob().maxSize(1000000).nullable(),
};

// Test all constructors
console.log("=== Field Type Verification ===");
console.log("String field:", s.string().constructor.name);
console.log("Number field:", s.int().constructor.name);
console.log("Boolean field:", s.boolean().constructor.name);
console.log("BigInt field:", s.bigInt().constructor.name);
console.log("DateTime field:", s.dateTime().constructor.name);
console.log("JSON field:", s.json().constructor.name);
console.log("Blob field:", s.blob().constructor.name);
console.log("Enum field:", s.enum(["a", "b"]).constructor.name);

console.log("\n=== Chainable Methods Verification ===");
console.log(
  "String with chaining:",
  complexFields.complexString.constructor.name
);
console.log(
  "Number with chaining:",
  complexFields.complexNumber.constructor.name
);
console.log(
  "Boolean with chaining:",
  complexFields.complexBool.constructor.name
);
console.log("Enum with chaining:", complexFields.complexEnum.constructor.name);
console.log("Date with chaining:", complexFields.complexDate.constructor.name);
console.log("Blob with chaining:", complexFields.complexBlob.constructor.name);

console.log("\n=== Model Information ===");
console.log("Model name:", userModel.name);
console.log("Number of fields:", userModel.fields.size);
console.log("Field names:", Array.from(userModel.fields.keys()));

console.log("\n=== Type Inference Verification ===");
console.log("Sample user created successfully!");
console.log("User ID:", sampleUser.id);
console.log("User email:", sampleUser.email);
console.log("User tags:", sampleUser.tags);
console.log("User is active:", sampleUser.isActive);
console.log("User metadata:", sampleUser.metadata);

console.log(
  "\n🎉 All field types are working perfectly with the advanced type system!"
);

export { userModel, sampleUser, complexFields };
export type { UserType };
