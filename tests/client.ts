import { createClient } from "../src/client";
import { schema } from "./schema";

const client = createClient({ schema, adapter: {} as any });

const [res] = await client.user.findMany({
  where: {
    posts: {
      none: {
        authorId: "eze",
      },
    },
    age: {
      equals: 20,
    },
    email: {
      contains: "test",
      mode: "default",
      not: {
        not: {
          equals: "test",
        },
      },
    },
  },
});
