// Final comprehensive test using SchemaBuilder
import { s } from "./src/schema/index.js";

// This should now work without any type errors
const userModel = s.model("user", {
  id: s.string().id(), // StringField with ID
  email: s.string().unique().email(), // StringField with unique + email validation
  name: s.string(), // Basic StringField
  bio: s.string().nullable(), // StringField nullable
  tags: s.string().list(), // StringField list
  slug: s.string().unique(), // StringField unique
  description: s.string().default("No description"), // StringField with default
  username: s.string().minLength(3).maxLength(20), // StringField with length validation
  age: s.int(), // NumberField
  score: s.float(), // NumberField float
});

// Test that type inference still works using the model's infer property
type UserModel = typeof userModel.infer;

// This should resolve to:
// type UserModel = {
//   id: string;
//   email: string;
//   name: string;
//   bio: string | null;
//   tags: string[];
//   slug: string;
//   description: string;
//   username: string;
//   age: number;
//   score: number;
// }

// Test a sample user object
const sampleUser: UserModel = {
  id: "user-123",
  email: "test@example.com",
  name: "John Doe",
  bio: null,
  tags: ["developer", "typescript"],
  slug: "john-doe",
  description: "A developer",
  username: "johndoe",
  age: 30,
  score: 95.5,
};

console.log("Final test successful!");
console.log("Model name:", userModel.name);
console.log("Sample user:", sampleUser);

export { userModel, sampleUser };
export type { UserModel };
