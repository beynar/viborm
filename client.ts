import { createClient } from "./src/client/client.ts";
import { createClient as PGliteCreateClient } from "./src/drivers/pglite";
import { push } from "./src/migrations/push";
import { s } from "./src/schema/index.ts";

const user = s.model({
  id: s.string().id(),
  name: s.string(),
  email: s.string(),
  posts: s.oneToMany(() => post, { references: ["id"] }),
});

const post = s.model({
  id: s.string().id(),
  title: s.string(),
  content: s.string(),
  authorId: s.string(),
  author: s.manyToOne(() => user, { fields: ["authorId"], references: ["id"] }),
});

const schema = { user, post };

// Create client with PGlite
const client = await PGliteCreateClient({ schema });
const client2 = createClient({ driver: client.$driver, schema });
const t = await client2.user.create();
// Push schema (will be no-op if already in sync)
const pushResult = await push(client.$driver, schema, { force: true });
console.log("Push result:", {
  applied: pushResult.applied,
  operationsCount: pushResult.operations.length,
});

// Clean up any existing test data
await client.post.deleteMany({});
await client.user.deleteMany({});

// Test CRUD operations
console.log("\n--- Testing CRUD operations ---\n");

// Create a user
const newUser = await client.user.create({
  data: {
    id: crypto.randomUUID(),
    name: "John Doe",
    email: "john@example.com",
  },
});
console.log("Created user:", newUser);

// Create a post for this user
const newPost = await client.post.create({
  data: {
    id: crypto.randomUUID(),
    title: "Hello World",
    content: "This is my first post!",
    authorId: newUser.id,
  },
});
console.log("Created post:", newPost);

// Find all users
const allUsers = await client.user.findMany({});
console.log("All users:", allUsers);

// Find user by id
const foundUser = await client.user.findFirst({
  where: { id: newUser.id },
});
console.log("Found user:", foundUser);

// Find user with posts (include)

const userWithPosts = await client.user.findFirst({
  where: { id: newUser.id },
  include: {
    posts: {
      include: {
        author: true,
      },
    },
  },
});
console.log("User with posts:", userWithPosts);

// Update the user
const updatedUser = await client.user.update({
  where: { id: newUser.id },
  data: { name: "Jane Doe" },
});
console.log("Updated user:", updatedUser);

// Count users
const userCount = await client.user.count({});
console.log("User count:", userCount);

// Clean up - delete the post first (foreign key constraint)
await client.post.delete({ where: { id: newPost.id } });
console.log("Deleted post");

// Delete the user
await client.user.delete({ where: { id: newUser.id } });
console.log("Deleted user");

// Disconnect
await client.$disconnect();
console.log("\nDone!");

type Arg = { id?: string } | undefined;

type Operation<T> = undefined extends T
  ? (args?: Exclude<T, undefined>) => Promise<void>
  : (args: T) => Promise<void>;

const x = {} as unknown as Operation<Arg>;

x({ id: "ses" });
