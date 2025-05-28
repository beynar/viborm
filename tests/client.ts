import { createClient } from "../src/client";
import { schema } from "./schema";

const client = createClient({ schema, adapter: {} as any });

const res = await client.post.findFirstOrThrow({
  where: {
    id: "01J9000000000000000000000",
    metadata: 
      path: ["tags"],
      equals: {
        tags: ["test"],
      },
    },
  },
  include: {
    author: true,
  },
});
