// Test model with StringField chainable methods
import { string } from "./src/schema/fields/string.js";

// This should now work without type errors
const userModel = {
  id: string().id(), // StringField with ID
  email: string().unique().email(), // StringField with unique + email validation
  name: string(), // Basic StringField
  bio: string().nullable(), // StringField nullable
  tags: string().list(), // StringField list
  slug: string().unique(), // StringField unique
  description: string().default("No description"), // StringField with default
  username: string().minLength(3).maxLength(20), // StringField with length validation
};

// Test that type inference still works
type UserModel = {
  [K in keyof typeof userModel]: (typeof userModel)[K]["infer"];
};

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
};

console.log("Model test successful!");
console.log("Sample user:", sampleUser);

export { userModel, sampleUser };
export type { UserModel };
