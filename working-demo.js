// Working Type System Demo
// Shows the advanced type system working with string and number fields
import { string } from "./src/schema/fields/string.js";
import { int, float } from "./src/schema/fields/number.js";
// String field examples
const name = string();
const optionalName = string().nullable();
const tags = string().list();
const optionalTags = string().list().nullable();
// Number field examples
const age = int();
const optionalAge = int().nullable();
const scores = float().list();
// Complex combinations
const id = string().id();
const uniqueEmail = string().unique();
const defaultDescription = string().default("No description");
// Show the types work correctly
function demonstrateWorkingTypes() {
    // These should all be properly typed
    const nameValue = "Alice";
    const optionalNameValue = null;
    const tagsValue = ["tag1", "tag2"];
    const optionalTagsValue = null;
    const ageValue = 25;
    const optionalAgeValue = null;
    const scoresValue = [95.5, 87.2, 92.1];
    const idValue = "user-123";
    const uniqueEmailValue = "user@example.com";
    const defaultDescriptionValue = "A user";
    console.log({
        nameValue,
        optionalNameValue,
        tagsValue,
        optionalTagsValue,
        ageValue,
        optionalAgeValue,
        scoresValue,
        idValue,
        uniqueEmailValue,
        defaultDescriptionValue,
    });
}
// Schema example with mixed field types
const userSchema = {
    id: string().id(),
    email: string().unique(),
    name: string(),
    age: int(),
    bio: string().nullable(),
    tags: string().list(),
    scores: float().list().nullable(),
    description: string().default("No description"),
};
// This resolves to:
// type User = {
//   id: string;
//   email: string;
//   name: string;
//   age: number;
//   bio: string | null;
//   tags: string[];
//   scores: number[] | null;
//   description: string;
// }
// Test the inferred type
function createUser() {
    return {
        id: "user-123",
        email: "user@example.com",
        name: "Alice",
        age: 25,
        bio: null,
        tags: ["developer", "typescript"],
        scores: [95.5, 87.2],
        description: "A TypeScript developer",
    };
}
export { demonstrateWorkingTypes, userSchema, createUser };
