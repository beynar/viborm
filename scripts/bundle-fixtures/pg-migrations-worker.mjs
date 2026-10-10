// Fixture (h) — a Worker that migrates a Postgres estate: `viborm/pg` plus
// `viborm/migrations` with createMigrationClient over shared object storage,
// bundled with the Worker options like (g).

import {
  createMigrationClient,
  ObjectStoreEstateStorage,
} from "../../dist/migrations.mjs";
import { createClient } from "../../dist/pg.mjs";
import { s } from "../../dist/schema.mjs";

const user = s.model({
  id: s.string().id(),
  email: s.string().unique(),
  createdAt: s.dateTime().now(),
  posts: s.toMany(() => post),
});

const post = s.model({
  id: s.string().id(),
  title: s.string(),
  authorId: s.string(),
  author: s
    .toOne(() => user)
    .fields("authorId")
    .references("id"),
});

export default {
  async fetch(_request, env) {
    const db = createClient({
      schema: { user, post },
      databaseUrl: env.DATABASE_URL,
    });
    // env.MIGRATION_STORE: the application's conditional-put object store.
    const migrations = createMigrationClient(db, {
      storage: new ObjectStoreEstateStorage(env.MIGRATION_STORE),
    });
    const status = await migrations.status();
    if (status.pending.length === 0) return Response.json(status);
    return Response.json(await migrations.apply());
  },
};
