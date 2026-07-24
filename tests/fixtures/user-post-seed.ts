export interface UserPostUserSeed {
  id: string;
  name: string;
  email: string;
  age: number | null;
}

export interface UserPostPostSeed {
  id: string;
  title: string;
  content: string | null;
  published: boolean;
  views: number;
  authorId: string;
}

interface UserPostCreateClient {
  user: {
    create(args: { data: UserPostUserSeed }): PromiseLike<UserPostUserSeed>;
  };
  post: {
    create(args: { data: UserPostPostSeed }): PromiseLike<UserPostPostSeed>;
  };
}

interface UserPostCreateManyClient {
  user: {
    createMany(args: { data: UserPostUserSeed[] }): PromiseLike<unknown>;
  };
  post: {
    createMany(args: { data: UserPostPostSeed[] }): PromiseLike<unknown>;
  };
}

export const standardUserRows: Record<
  "alice" | "bob" | "charlie",
  UserPostUserSeed
> = {
  alice: {
    id: "user-1",
    name: "Alice",
    email: "alice@test.com",
    age: 30,
  },
  bob: {
    id: "user-2",
    name: "Bob",
    email: "bob@test.com",
    age: 25,
  },
  charlie: {
    id: "user-3",
    name: "Charlie",
    email: "charlie@test.com",
    age: null,
  },
};

export const standardPostRows: Record<
  "post1" | "post2" | "post3",
  Omit<UserPostPostSeed, "authorId">
> = {
  post1: {
    id: "post-1",
    title: "First Post",
    content: "Content 1",
    published: true,
    views: 100,
  },
  post2: {
    id: "post-2",
    title: "Second Post",
    content: "Content 2",
    published: false,
    views: 50,
  },
  post3: {
    id: "post-3",
    title: "Third Post",
    content: null,
    published: true,
    views: 200,
  },
};

export const windowUserRows: UserPostUserSeed[] = [
  { id: "u1", email: "alice@test.com", name: "Alice", age: 25 },
  { id: "u2", email: "bob@test.com", name: "Bob", age: 30 },
  { id: "u3", email: "charlie@test.com", name: "Charlie", age: 35 },
];

export const windowPostRows: UserPostPostSeed[] = [
  {
    id: "p1",
    title: "Post 1",
    content: "Content 1",
    published: true,
    views: 100,
    authorId: "u1",
  },
  {
    id: "p2",
    title: "Post 2",
    content: "Content 2",
    published: false,
    views: 50,
    authorId: "u1",
  },
  {
    id: "p3",
    title: "Post 3",
    content: "Content 3",
    published: true,
    views: 200,
    authorId: "u2",
  },
];

export async function createStandardUserPostUsers(
  client: UserPostCreateClient
) {
  const alice = await client.user.create({
    data: { ...standardUserRows.alice },
  });
  const bob = await client.user.create({ data: { ...standardUserRows.bob } });
  const charlie = await client.user.create({
    data: { ...standardUserRows.charlie },
  });

  return { alice, bob, charlie };
}

export async function createStandardUserPostPosts(
  client: UserPostCreateClient,
  authorId: string
) {
  const post1 = await client.post.create({
    data: { ...standardPostRows.post1, authorId },
  });
  const post2 = await client.post.create({
    data: { ...standardPostRows.post2, authorId },
  });
  const post3 = await client.post.create({
    data: { ...standardPostRows.post3, authorId },
  });

  return { post1, post2, post3 };
}

export async function seedWindowUserPosts(client: UserPostCreateManyClient) {
  await client.user.createMany({
    data: windowUserRows.map((user) => ({ ...user })),
  });

  await client.post.createMany({
    data: windowPostRows.map((post) => ({ ...post })),
  });
}
