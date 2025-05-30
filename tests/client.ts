import { PrismaClient } from "../generated/prisma";

const prisma = new PrismaClient();

import { createClient } from "../src/client";
import { schema } from "./schema";

const client = createClient({ schema, adapter: {} as any });

const res = await client.user.findFirst({
  where: {
    id: "01J9000000000000000000000",
  },
  select: {
    age: true,

    _count: {
      select: {
        posts: {
          where: {},
        },
      },
    },
  },
});
const update = await client.user.update({
  where: {
    id: "01J9000000000000000000000",
  },
  data: {
    // profile
  },
});

const res2 = await prisma.user.update({
  where: {
    id: "",
  },
  data: {
    metadata: {
      some: "json value",
    },
    comments: {
      connect: {
        id: "re",
      },
    },
    tags: {
      push: ["123"],
    },
  },
});
const res3 = await prisma.post.findFirstOrThrow({
  where: {
    published: {},
  },
  select: {
    _count: {
      select: {
        comments: {
          where: {
            id: "re",
          },
        },
      },
    },
  },
});
