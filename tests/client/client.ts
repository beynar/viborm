import { createClient as PGliteCreateClient } from "@drivers/pglite";
import { push } from "@migrations";
import { s } from "@schema";

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

// Push schema (will be no-op if already in sync)
const pushResult = await push(client.$driver, schema, { force: true });
console.log("Push result:", {
  applied: pushResult.applied,
  operationsCount: pushResult.operations.length,
});

// Clean up any existing test data
await client.post.deleteMany();
await client.user.deleteMany();

// Test CRUD operations
console.log("\n--- Testing CRUD operations ---\n");

// Create a user
const newUser = await client.user.create({
  data: {
    email: "eze",
    name: "eze",
  },
  include: {
    posts: true,
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
const allUsers = await client.user.findMany();
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

await client.$transaction(async (tx) => {
  const newUser = await tx.user.create({
    data: {
      email: "eze2",
      name: "eze2",
    },
  });
  console.log("Created user:", newUser);
  const newPost = await tx.post.create({
    data: {
      title: "Hello World2",
      content: "This is my second post!",
      authorId: newUser.id,
    },
  });
  console.log("Created post:", newPost);
});
console.log("Deleted user");

// Disconnect
await client.$disconnect();
console.log("\nDone!");
