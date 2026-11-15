// biome-ignore-all lint/correctness/noUnusedImports: a preamble's imports serve the page's blocks.
// biome-ignore-all lint/correctness/noUnusedVariables: a preamble's names serve the page's blocks.
import { client as base } from "docs-examples/shared";
import { defaultOmit } from "viborm/client";
import { createClient } from "viborm/pglite";
import { s } from "viborm/schema";

const user = s.model({
  id: s.string().id().ulid(),
  passwordHash: s.string(),
});
const note = s.model({
  id: s.string().id().ulid(),
  draftBody: s.string(),
});
const client = createClient({ schema: { user, note } });
const publicClient = client.$extends(
  defaultOmit({ user: { passwordHash: true } })
);
