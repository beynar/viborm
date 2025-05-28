import { createClient } from "../src/types/client/client";
import { schema } from "./schema";

const client = createClient(schema);

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
