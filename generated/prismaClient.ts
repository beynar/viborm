import { PrismaClient } from "./prisma";

const client = new PrismaClient();

const res = await client.user.findFirstOrThrow({
  where: {
    metadata: {
      path: ["eza"],
      equals: {
        tags: ["test"],
      },
    },
  },
});
