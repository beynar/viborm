// Test file to verify generic type system works correctly
import { SchemaBuilder } from "./schema/index.js";
const s = new SchemaBuilder();
// Test field type inference with explicit types to avoid circular reference issues
const userModel = s.model("user", {
    id: s.string().id().auto.uuid(),
    name: s.string(),
    email: s.string().nullable(),
    age: s.int(),
    isActive: s.boolean(),
    createdAt: s.dateTime().auto.now(),
    posts: s.relation.many(() => postModel),
});
const postModel = s.model("post", {
    id: s.string().id().auto.uuid(),
    title: s.string(),
    content: s.string().nullable(),
    author: s.relation.one(() => userModel).on("authorId"),
    authorId: s.string(),
});
// These should be properly typed:
// UserType should have:
// - id: string
// - name: string
// - email: string | null
// - age: number
// - isActive: boolean
// - createdAt: Date
// - posts: any[]
// PostType should have:
// - id: string
// - title: string
// - content: string | null
// - author: any
// - authorId: string
console.log("Type system test completed successfully!");
//# sourceMappingURL=test-generics.js.map