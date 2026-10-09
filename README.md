# VibORM

A TypeScript ORM for PostgreSQL, MySQL and SQLite. Define models in TypeScript;
query inputs and results are inferred without a code generation step.

V1 requires Node.js 22+ and TypeScript 5.9+. Bun support depends on the selected
driver. Read the [upgrade guide](docs/content/docs/getting-started/upgrading-to-v1.mdx)
before moving from 0.1 or a release candidate.

## Quick start

PGlite runs PostgreSQL in your process. This example persists its database locally.

```sh
pnpm add viborm @electric-sql/pglite
```

```ts
import { s } from "viborm";
import { createClient } from "viborm/pglite";
import { createMigrationClient } from "viborm/migrations";

const user = s.model({
  id: s.string().id().ulid(),
  email: s.string().unique(),
  posts: s.toMany(() => post),
});
const post = s.model({
  id: s.string().id().ulid(),
  title: s.string(),
  authorId: s.string().ulid(),
  author: s.toOne(() => user).fields("authorId").references("id"),
});

const db = createClient({ schema: { user, post }, dataDir: ".pglite" });
await createMigrationClient(db).push();

const alice = await db.user.create({
  data: {
    email: "alice@example.com",
    posts: { create: { title: "Hello" } },
  },
  include: { posts: true },
});

const posts = await db.post.findMany({
  where: { authorId: alice.id },
  select: { id: true, title: true },
  orderBy: { title: "asc" },
});
await db.$disconnect();
```

A format such as `.ulid()` defines the value domain. ID fields generate values by
default; a non-ID field does not generate a missing foreign key. Supplied clients
remain owned by their caller.

For application projects, keep the client and schema in separate modules and use
[the CLI](docs/content/docs/getting-started/configuration.mdx):

```ts
// viborm.config.ts
import { defineConfig } from "viborm/config";
import { db } from "./src/db";
export default defineConfig({ client: db });
```

```sh
pnpm exec viborm check
pnpm exec viborm push
```

The CLI loads a project `.env` and TypeScript configuration using its bundled
loader. Choose a persistent database path or explicit connection URL in the
client. `push` synchronizes the live schema; versioned migration files use the
separate [migration workflow](docs/content/docs/migration/index.mdx).

## What it provides

- Inferred CRUD, filters, relations, aggregates, pagination and nested writes.
- Immutable scalar declarations and Standard Schema validation.
- PostgreSQL, MySQL and SQLite adapters with eleven transport drivers.
- Callback transactions where the provider supports them, and atomic array
  transactions on the supported batch transports.
- Ten extension capabilities: `request`, `query`, `statement`, `observe`, `client`,
  `model`, `controls`, `rows`, `deletion` and `data`; official cache,
  instrumentation, omit and soft-delete tools.
- Fixed-decimal values, millisecond DateTime values, GeoPoint and PostgreSQL vector
  operations with explicit provider requirements.

See the [driver matrix](docs/content/docs/drivers/index.mdx) for actual provider
qualification and hosted limitations. SQL Server, a database browser, read-replica
routing and cross-schema relations are not implemented.

## Contracts to know

VibORM has a Prisma-inspired API, with differences documented in the
[compatibility guide](docs/content/docs/client/compatibility.mdx).

- Operations are lazy: awaiting an operation executes it. Reusing that same
  operation reuses its completion; create a new operation for another execution.
- `createMany`, `updateMany` and `deleteMany` return `{ count }`, or rows when a
  supported `select` is supplied. `exist()` returns a boolean.
- Use one of `select` or `include` at each projection level.
- `omit` controls row presentation. Filters, aggregates and raw SQL can still
  address omitted columns; it is not an authorization boundary.
- Safe raw SQL parameterizes values; it does not apply model codecs. Compact IDs,
  SQLite decimals and temporal columns have physical representations described in
  the [raw SQL guide](docs/content/docs/client/raw-sql.mdx).
- `undefined` omits a filter. Validate external input before building mutation
  filters. Empty logical filters and provider collation differences are explicit
  in the filtering and compatibility guides.
- Shared database access and native indexes can require an explicit migration
  decision. Unsupported storage is refused before typed writes rather than
  silently rewritten.

## Documentation and development

Start with [installation](docs/content/docs/getting-started/index.mdx),
[queries](docs/content/docs/client/index.mdx),
[schemas](docs/content/docs/schema/index.mdx) and
[extensions](docs/content/docs/extensions/index.mdx).

Development commands and test lanes are in [CONTRIBUTING.md](CONTRIBUTING.md).
Release provenance and publishing are governed by [RELEASING.md](RELEASING.md).
See [SECURITY.md](SECURITY.md) for private vulnerability reporting.

[MIT](LICENSE).
