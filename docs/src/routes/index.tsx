import { createFileRoute, Link } from "@tanstack/react-router";
import { HomeLayout } from "fumadocs-ui/layouts/home";
import { baseOptions } from "@/lib/layout.shared";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return (
    <HomeLayout {...baseOptions()}>
      <main className="flex flex-col">
        {/* Hero Section */}
        <section className="relative overflow-hidden border-fd-border border-b">
          <div className="absolute inset-0 bg-gradient-to-br from-fd-primary/5 via-transparent to-fd-primary/10" />
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-fd-primary/10 via-transparent to-transparent" />

          <div className="container relative mx-auto px-6 py-24 md:py-32 lg:py-40">
            <div className="mx-auto max-w-4xl text-center">
              <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-fd-primary/20 bg-fd-primary/10 px-3 py-1 font-medium text-fd-primary text-sm">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-fd-primary opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-fd-primary" />
                </span>
                The Convergence Point
              </div>

              <h1 className="mb-6 font-bold text-4xl tracking-tight md:text-5xl lg:text-6xl">
                The ORM We're All{" "}
                <span className="bg-gradient-to-r from-fd-primary to-fd-primary/60 bg-clip-text text-transparent">
                  Trying to Build
                </span>
              </h1>

              <p className="mx-auto mb-8 max-w-3xl text-fd-muted-foreground text-lg leading-relaxed md:text-xl">
                Prisma pioneered elegant APIs but requires code generation and
                WASM. Drizzle went lightweight but sacrificed elegance. VibORM
                combines both:{" "}
                <span className="font-medium text-fd-foreground">
                  Prisma's elegant API, zero code generation, no WASM — pure
                  TypeScript.
                </span>
              </p>

              <div className="flex flex-col justify-center gap-4 sm:flex-row">
                <Link
                  className="inline-flex items-center justify-center rounded-lg bg-fd-primary px-6 py-3 font-medium text-base text-fd-primary-foreground transition-colors hover:bg-fd-primary/90"
                  params={{ _splat: "getting-started/quick-start" }}
                  to="/docs/$"
                >
                  Get Started
                  <svg
                    className="ml-2 h-4 w-4"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      d="M13 7l5 5m0 0l-5 5m5-5H6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                    />
                  </svg>
                </Link>
                <Link
                  className="inline-flex items-center justify-center rounded-lg border border-fd-border bg-fd-background px-6 py-3 font-medium text-base transition-colors hover:bg-fd-accent"
                  params={{ _splat: "" }}
                  to="/docs/$"
                >
                  Read the Docs
                </Link>
              </div>
            </div>
          </div>
        </section>

        {/* The Convergence Story */}
        <section className="border-fd-border border-b py-16 md:py-24">
          <div className="container mx-auto px-6">
            <div className="mx-auto max-w-4xl">
              <div className="mb-12 text-center">
                <h2 className="mb-4 font-bold text-2xl md:text-3xl">
                  The Great ORM Convergence
                </h2>
                <p className="mx-auto max-w-3xl text-fd-muted-foreground leading-relaxed">
                  In 2020, Prisma pioneered object-based queries and relational
                  APIs. Drizzle launched as the "anti-Prisma" — lightweight,
                  SQL-first, no abstractions. Now in 2025, Drizzle's v2 adopts
                  the exact patterns they once dismissed.
                  <span className="mt-2 block font-medium text-fd-foreground">
                    This isn't copying. It's convergence. Production demands
                    these patterns.
                  </span>
                </p>
              </div>

              <div className="grid gap-6 md:grid-cols-3">
                <ConvergenceCard
                  highlight="Beautiful DX, but heavy toolchain"
                  items={[
                    "Elegant, readable schemas",
                    "Intuitive query API",
                    "Code generation required",
                    "WASM engine overhead",
                  ]}
                  title="Prisma's Path"
                />
                <ConvergenceCard
                  highlight="Lightweight, but sacrificed elegance"
                  items={[
                    "Verbose, SQL-like schemas",
                    "Relations defined separately",
                    "Callback-based → object-based",
                    "Zero code generation",
                  ]}
                  title="Drizzle's Path"
                />
                <ConvergenceCard
                  highlight="The best of both worlds"
                  items={[
                    "Prisma's elegant API ✓",
                    "Zero code generation ✓",
                    "No WASM, pure TypeScript ✓",
                    "Database-agnostic features ✓",
                  ]}
                  primary
                  title="VibORM"
                />
              </div>
            </div>
          </div>
        </section>

        {/* What Production Demands */}
        <section className="border-fd-border border-b bg-fd-card/30 py-16 md:py-24">
          <div className="container mx-auto px-6">
            <div className="mx-auto max-w-4xl">
              <div className="mb-12 text-center">
                <h2 className="mb-4 font-bold text-2xl md:text-3xl">
                  What Production Actually Demands
                </h2>
                <p className="mx-auto max-w-2xl text-fd-muted-foreground">
                  These patterns aren't arbitrary preferences — they're optimal
                  solutions that emerge when you tackle production-scale
                  problems.
                </p>
              </div>

              <div className="grid gap-6 sm:grid-cols-2">
                <DemandCard
                  description="Drizzle v2 adopted object-based patterns but only partially — missing nested selects on relations and other features. VibORM implements the full Prisma-like API."
                  quote="where is now object. orderBy is now object."
                  source="Drizzle v2 Migration Docs"
                  title="Complete object-based queries"
                />
                <DemandCard
                  description="Drizzle forces you to define relations separately from models. That's not just inconvenient — it's harder to understand and maintain. VibORM keeps relations inline, like Prisma."
                  quote="Your schema should be readable at a glance, not scattered across files."
                  source="Developer Experience"
                  title="Schema elegance isn't optional"
                />
                <DemandCard
                  description="Other ORMs treat JSON as 'any'. VibORM lets you define JSON schemas with Zod or Valibot — full type inference and runtime validation on your JSON data."
                  quote="JSON columns shouldn't be a type safety escape hatch."
                  source="Type Safety"
                  title="Typed JSON columns"
                />
                <DemandCard
                  description="Prisma bundles a Rust engine compiled to WASM — extra binaries, platform issues, slower cold starts. VibORM is pure TypeScript. Nothing to download, nothing to compile."
                  quote="The simplest architecture is the best architecture."
                  source="Engineering Wisdom"
                  title="No WASM, no complexity"
                />
              </div>
            </div>
          </div>
        </section>

        {/* Elegance Comparison */}
        <section className="border-fd-border border-b py-16 md:py-24">
          <div className="container mx-auto px-6">
            <div className="mx-auto max-w-5xl">
              <div className="mb-12 text-center">
                <h2 className="mb-4 font-bold text-2xl md:text-3xl">
                  Elegance Matters
                </h2>
                <p className="mx-auto max-w-2xl text-fd-muted-foreground">
                  Drizzle requires relations to be defined separately from your
                  models. VibORM keeps everything together — like Prisma, but in
                  pure TypeScript.
                </p>
              </div>

              <div className="mb-8 grid gap-6 md:grid-cols-2">
                <CodeBlock
                  badge="Drizzle"
                  code={`// Tables defined here...
const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
});

const posts = pgTable("posts", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  authorId: text("author_id").references(() => users.id),
});

// ...but relations defined separately 😕
const usersRelations = relations(users, ({ many }) => ({
  posts: many(posts),
}));

const postsRelations = relations(posts, ({ one }) => ({
  author: one(users, {
    fields: [posts.authorId],
    references: [users.id],
  }),
}));`}
                  title="drizzle-schema.ts"
                />

                <CodeBlock
                  badge="VibORM"
                  code={`// Everything in one place — clean & elegant ✨
const user = s.model({
  id: s.string().id().ulid(),
  email: s.string().unique(),
  name: s.string().nullable(),
  posts: s.oneToMany(() => post),
}).map("users");

const post = s.model({
  id: s.string().id().ulid(),
  title: s.string(),
  authorId: s.string(),
  author: s.manyToOne(() => user)
    .fields("authorId")
    .references("id"),
}).map("posts");

// That's it. Relations are part of the model.
// Chainable. Readable. Elegant.`}
                  title="viborm-schema.ts"
                />
              </div>

              <div className="grid gap-6 md:grid-cols-2">
                <div className="rounded-lg border border-fd-border bg-fd-card p-5">
                  <h3 className="mb-2 flex items-center gap-2 font-semibold">
                    <span className="text-red-500">✗</span> Drizzle's Approach
                  </h3>
                  <ul className="space-y-1 text-fd-muted-foreground text-sm">
                    <li>
                      • Relations defined in separate{" "}
                      <code className="rounded bg-fd-muted px-1 text-xs">
                        relations()
                      </code>{" "}
                      calls
                    </li>
                    <li>• Schema scattered across multiple declarations</li>
                    <li>• Harder to understand model structure at a glance</li>
                    <li>• More boilerplate, less readable</li>
                  </ul>
                </div>
                <div className="rounded-lg border border-fd-primary/30 bg-fd-primary/5 p-5">
                  <h3 className="mb-2 flex items-center gap-2 font-semibold text-fd-primary">
                    <span>✓</span> VibORM's Approach
                  </h3>
                  <ul className="space-y-1 text-fd-muted-foreground text-sm">
                    <li>• Relations defined inline with the model</li>
                    <li>• One model = one complete definition</li>
                    <li>• Immediately see the full picture</li>
                    <li>• Chainable, fluent, Prisma-like elegance</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Standard Schema & Typed JSON */}
        <section className="border-fd-border border-b bg-fd-card/30 py-16 md:py-24">
          <div className="container mx-auto px-6">
            <div className="mx-auto max-w-5xl">
              <div className="mb-12 text-center">
                <h2 className="mb-4 font-bold text-2xl md:text-3xl">
                  Your Schema Library, Native Support
                </h2>
                <p className="mx-auto max-w-2xl text-fd-muted-foreground">
                  Use Zod, Valibot, or ArkType to narrow field validation.
                  Define typed JSON columns with full inference. No other ORM
                  does this.
                </p>
              </div>

              <div className="mb-8 grid gap-6 md:grid-cols-2">
                <CodeBlock
                  badge="Typed JSON"
                  code={`import { s } from "viborm";
import { z } from "zod";

// Define your JSON structure with Zod
const addressSchema = z.object({
  street: z.string(),
  city: z.string(),
  zip: z.string(),
  country: z.string(),
});

const user = s.model({
  id: s.string().id().ulid(),
  email: s.string().unique(),
  // Typed JSON column with full inference ✨
  address: s.json(addressSchema),
  // Nullable typed JSON
  preferences: s.json(prefsSchema).nullable(),
}).map("users");

// TypeScript knows address is { street, city, zip, country }
// Runtime validation included — invalid JSON throws`}
                  title="typed-json.ts"
                />

                <CodeBlock
                  badge="Standard Schema"
                  code={`import { s } from "viborm";
import { z } from "zod";
import * as v from "valibot";

// Use Zod for email validation
const user = s.model({
  id: s.string().id().ulid(),
  email: s.string().schema(
    z.string().email()
  ),
  // Or use Valibot
  phone: s.string().schema(
    v.pipe(v.string(), v.regex(/^\\+[0-9]{10,15}$/))
  ),
  // Or ArkType
  age: s.int().schema(type("number > 0 & < 150")),
}).map("users");

// Works with any Standard Schema compliant library
// Same API, your choice of validator`}
                  title="narrowed-validation.ts"
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-3">
                <div className="rounded-lg border border-fd-border bg-fd-card p-4 text-center">
                  <div className="mb-1 font-semibold">Zod</div>
                  <p className="text-fd-muted-foreground text-xs">
                    Most popular schema library
                  </p>
                </div>
                <div className="rounded-lg border border-fd-border bg-fd-card p-4 text-center">
                  <div className="mb-1 font-semibold">Valibot</div>
                  <p className="text-fd-muted-foreground text-xs">
                    Lightweight alternative
                  </p>
                </div>
                <div className="rounded-lg border border-fd-border bg-fd-card p-4 text-center">
                  <div className="mb-1 font-semibold">ArkType</div>
                  <p className="text-fd-muted-foreground text-xs">
                    Fastest runtime validation
                  </p>
                </div>
              </div>

              <div className="mt-8 rounded-lg border border-fd-primary/30 bg-fd-primary/5 p-6">
                <div className="flex items-start gap-4">
                  <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-fd-primary text-fd-primary-foreground">
                    <JsonIcon />
                  </div>
                  <div>
                    <h3 className="mb-1 font-semibold">
                      JSON Columns, Finally Type-Safe
                    </h3>
                    <p className="text-fd-muted-foreground text-sm">
                      Other ORMs treat JSON as{" "}
                      <code className="rounded bg-fd-muted px-1 text-xs">
                        any
                      </code>{" "}
                      or{" "}
                      <code className="rounded bg-fd-muted px-1 text-xs">
                        unknown
                      </code>
                      . VibORM lets you define the exact shape with your
                      favorite schema library — full type inference in queries,
                      runtime validation on writes. No more JSON escape hatches.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Query Comparison */}
        <section className="border-fd-border border-b bg-fd-card/30 py-16 md:py-24">
          <div className="container mx-auto px-6">
            <div className="mx-auto max-w-5xl">
              <div className="mb-12 text-center">
                <h2 className="mb-4 font-bold text-2xl md:text-3xl">
                  Queries That Read Like English
                </h2>
                <p className="mx-auto max-w-2xl text-fd-muted-foreground">
                  Prisma's query API is beloved for a reason — it's intuitive.
                  VibORM brings that same elegance without the code generation.
                </p>
              </div>

              <div className="mx-auto max-w-3xl">
                <CodeBlock
                  badge="Prisma-like API"
                  code={`// Find admins with their published posts
const admins = await client.user.findMany({
  where: { role: "ADMIN" },
  include: {
    posts: {
      where: { published: true },
      orderBy: { createdAt: "desc" },
    },
  },
});

// Create a user with posts in one call
const newUser = await client.user.create({
  data: {
    email: "alice@example.com",
    name: "Alice",
    posts: {
      create: [
        { title: "Hello World" },
        { title: "Second Post" },
      ],
    },
  },
  include: { posts: true },
});

// TypeScript knows the exact return type
// No generation. No guessing. Just inference.`}
                  title="queries.ts"
                />
              </div>

              <div className="mt-8 rounded-lg border border-fd-border bg-fd-background p-6">
                <div className="flex items-start gap-4">
                  <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-fd-primary/10 text-fd-primary">
                    <ZapIcon />
                  </div>
                  <div>
                    <h3 className="mb-1 font-semibold">
                      Simpler Stack, Better Performance
                    </h3>
                    <p className="text-fd-muted-foreground text-sm">
                      No{" "}
                      <code className="rounded bg-fd-muted px-1.5 py-0.5 text-xs">
                        prisma generate
                      </code>
                      . No WASM engine. No binary downloads. Just pure
                      TypeScript that runs anywhere Node.js runs — faster cold
                      starts, simpler deployments, and the complete Prisma-like
                      query API.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Comparison Table */}
        <section className="border-fd-border border-b py-16 md:py-24">
          <div className="container mx-auto px-6">
            <div className="mb-12 text-center">
              <h2 className="mb-4 font-bold text-2xl md:text-3xl">
                The Full Picture
              </h2>
              <p className="mx-auto max-w-2xl text-fd-muted-foreground">
                Prisma's elegance. Drizzle's zero-generation. VibORM combines
                both — without the compromises.
              </p>
            </div>

            <div className="mx-auto max-w-4xl overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-fd-border border-b">
                    <th className="px-4 py-4 text-left font-semibold">
                      Feature
                    </th>
                    <th className="px-4 py-4 text-center font-semibold text-fd-muted-foreground">
                      Prisma
                    </th>
                    <th className="px-4 py-4 text-center font-semibold text-fd-muted-foreground">
                      Drizzle v1
                    </th>
                    <th className="px-4 py-4 text-center font-semibold text-fd-muted-foreground">
                      Drizzle v2
                    </th>
                    <th className="px-4 py-4 text-center font-semibold text-fd-primary">
                      VibORM
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-fd-border">
                  <ComparisonRow
                    feature="Object-based queries"
                    values={["✓", "✗", "Partial", "Complete"]}
                    vibormHighlight
                  />
                  <ComparisonRow
                    feature="Zero code generation"
                    values={["✗", "✓", "✓", "✓"]}
                    vibormHighlight
                  />
                  <ComparisonRow
                    feature="Pure TypeScript (no WASM)"
                    values={["✗", "✓", "✓", "✓"]}
                    vibormHighlight
                  />
                  <ComparisonRow
                    feature="Full type inference"
                    values={["Generated", "Partial", "Partial", "Full"]}
                    vibormHighlight
                  />
                  <ComparisonRow
                    feature="Relational queries"
                    values={["✓", "Limited", "✓", "✓"]}
                    vibormHighlight
                  />
                  <ComparisonRow
                    feature="Typed JSON columns"
                    values={["✗", "✗", "✗", "✓"]}
                    vibormHighlight
                  />
                  <ComparisonRow
                    feature="Standard Schema integration"
                    values={["✗", "✗", "✗", "Zod/Valibot/ArkType"]}
                    vibormHighlight
                  />
                  <ComparisonRow
                    feature="Exported model schemas"
                    values={["✗", "✗", "✗", "ArkType"]}
                    vibormHighlight
                  />
                  <ComparisonRow
                    feature="TypeScript schema"
                    values={["PSL file", "✓", "✓", "✓"]}
                    vibormHighlight
                  />
                  <ComparisonRow
                    feature="Relations inline"
                    values={["✓", "✗", "✗", "✓"]}
                    vibormHighlight
                  />
                  <ComparisonRow
                    feature="Filtering by relations"
                    values={["✓", "✗", "✓", "✓"]}
                    vibormHighlight
                  />
                  <ComparisonRow
                    feature="Nested select on relations"
                    values={["✓", "✗", "Partial", "✓"]}
                    vibormHighlight
                  />
                  <ComparisonRow
                    feature="Scalar arrays on MySQL"
                    values={["✗", "✗", "✗", "✓"]}
                    vibormHighlight
                  />
                  <ComparisonRow
                    feature="DISTINCT on all databases"
                    values={["Partial", "DB-dependent", "DB-dependent", "✓"]}
                    vibormHighlight
                  />
                  <ComparisonRow
                    feature="Consistent feature set"
                    values={[
                      "DB-dependent",
                      "DB-dependent",
                      "DB-dependent",
                      "Always",
                    ]}
                    vibormHighlight
                  />
                </tbody>
              </table>
            </div>

            <p className="mx-auto mt-6 max-w-2xl text-center text-fd-muted-foreground text-sm">
              Prisma has elegance but requires generation and WASM. Drizzle is
              lightweight but sacrificed elegance. VibORM gives you both —
              beautiful queries, pure TypeScript, no build step.
            </p>
          </div>
        </section>

        {/* Database Abstraction Section */}
        <section className="border-fd-border border-b py-16 md:py-24">
          <div className="container mx-auto px-6">
            <div className="mx-auto max-w-4xl">
              <div className="mb-12 text-center">
                <h2 className="mb-4 font-bold text-2xl md:text-3xl">
                  One API. Every Database. Every Feature.
                </h2>
                <p className="mx-auto max-w-3xl text-fd-muted-foreground leading-relaxed">
                  Other ORMs give you different features depending on your
                  database. VibORM abstracts the limitations away — your code
                  works the same whether you're on PostgreSQL, MySQL, or SQLite.
                </p>
              </div>

              <div className="mb-8 grid gap-6 md:grid-cols-3">
                <div className="rounded-lg border border-fd-border bg-fd-card p-5 text-center">
                  <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-fd-primary/10 text-fd-primary">
                    <ArrayIcon />
                  </div>
                  <h3 className="mb-2 font-semibold">Scalar Arrays</h3>
                  <p className="text-fd-muted-foreground text-sm">
                    MySQL doesn't support array columns natively. VibORM
                    emulates them with JSON — same API, same types, any
                    database.
                  </p>
                </div>
                <div className="rounded-lg border border-fd-border bg-fd-card p-5 text-center">
                  <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-fd-primary/10 text-fd-primary">
                    <FilterIcon />
                  </div>
                  <h3 className="mb-2 font-semibold">DISTINCT Queries</h3>
                  <p className="text-fd-muted-foreground text-sm">
                    DISTINCT ON isn't available everywhere. VibORM provides
                    consistent distinct behavior across all supported databases.
                  </p>
                </div>
                <div className="rounded-lg border border-fd-border bg-fd-card p-5 text-center">
                  <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-fd-primary/10 text-fd-primary">
                    <SwitchIcon />
                  </div>
                  <h3 className="mb-2 font-semibold">Switch Anytime</h3>
                  <p className="text-fd-muted-foreground text-sm">
                    Start with SQLite for development, deploy to PostgreSQL.
                    Your queries don't change — the ORM handles the translation.
                  </p>
                </div>
              </div>

              <div className="rounded-lg border border-fd-primary/30 bg-fd-primary/5 p-6">
                <div className="flex items-start gap-4">
                  <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-fd-primary text-fd-primary-foreground">
                    <DatabaseIcon />
                  </div>
                  <div>
                    <h3 className="mb-1 font-semibold">The Real Abstraction</h3>
                    <p className="text-fd-muted-foreground text-sm">
                      Most ORMs abstract SQL <em>syntax</em> — you still hit
                      database limitations. VibORM abstracts database{" "}
                      <em>capabilities</em>. Features that don't exist natively
                      are emulated transparently. You get the same powerful API
                      everywhere.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Features that matter */}
        <section className="border-fd-border border-b bg-fd-card/30 py-16 md:py-24">
          <div className="container mx-auto px-6">
            <div className="mb-12 text-center">
              <h2 className="mb-4 font-bold text-2xl md:text-3xl">
                Features That Survived Convergence
              </h2>
              <p className="mx-auto max-w-2xl text-fd-muted-foreground">
                These aren't arbitrary preferences. They're the patterns that
                every production ORM eventually implements.
              </p>
            </div>

            <div className="mx-auto grid max-w-5xl gap-6 sm:grid-cols-2 lg:grid-cols-3">
              <FeatureCard
                description="Chainable schemas. Relations defined inline. Queries that read like English. The beautiful DX Prisma pioneered — in pure TypeScript."
                icon={<SparklesIcon />}
                title="Prisma's Elegance"
              />
              <FeatureCard
                description="Defined inline, not scattered. include, nested select, relation filters — Prisma's complete relational API without the separate relations() boilerplate."
                icon={<LinkIcon />}
                title="Relations Done Right"
              />
              <FeatureCard
                description="Every query, filter, and result is typed. No any, no guessing, no runtime surprises."
                icon={<ShieldIcon />}
                title="Full Type Safety"
              />
              <FeatureCard
                description="No code generation, no WASM engine, no binary downloads. Just TypeScript — simpler workflow, faster cold starts, works everywhere."
                icon={<ZapIcon />}
                title="Pure TypeScript"
              />
              <FeatureCard
                description="ArkType schemas auto-generated from your models. Use them for API validation, form validation — anywhere you need runtime checks outside the ORM."
                icon={<CheckCircleIcon />}
                title="Exported Model Schemas"
              />
              <FeatureCard
                description="Use Zod, Valibot, or ArkType to narrow field validation and type JSON columns. Your favorite schema library, native support."
                icon={<PlugIcon />}
                title="Standard Schema Integration"
              />
              <FeatureCard
                description="Scalar arrays on MySQL. DISTINCT on SQLite. Every feature works everywhere — the ORM abstracts database limitations, not just syntax."
                icon={<DatabaseIcon />}
                title="True Database Abstraction"
              />
            </div>
          </div>
        </section>

        {/* CTA Section */}
        <section className="border-fd-border border-b bg-fd-card/30 py-16 md:py-24">
          <div className="container mx-auto px-6">
            <div className="mx-auto max-w-2xl text-center">
              <h2 className="mb-4 font-bold text-2xl md:text-3xl">
                Skip the Convergence. Start at the Destination.
              </h2>
              <p className="mb-8 text-fd-muted-foreground">
                Why wait for other ORMs to implement what you need? VibORM has
                the patterns that production demands — today.
              </p>

              <div className="mb-8 rounded-lg border border-fd-border bg-fd-card p-4 text-left font-mono text-sm">
                <div className="flex items-center gap-2 text-fd-muted-foreground">
                  <span className="text-fd-primary">$</span>
                  <span>npm install viborm</span>
                </div>
              </div>

              <div className="flex flex-col justify-center gap-4 sm:flex-row">
                <Link
                  className="inline-flex items-center justify-center rounded-lg bg-fd-primary px-6 py-3 font-medium text-base text-fd-primary-foreground transition-colors hover:bg-fd-primary/90"
                  params={{ _splat: "getting-started/quick-start" }}
                  to="/docs/$"
                >
                  Get Started
                  <svg
                    className="ml-2 h-4 w-4"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      d="M13 7l5 5m0 0l-5 5m5-5H6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                    />
                  </svg>
                </Link>
                <a
                  className="inline-flex items-center justify-center rounded-lg border border-fd-border bg-fd-background px-6 py-3 font-medium text-base transition-colors hover:bg-fd-accent"
                  href="https://github.com/your-org/viborm"
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  <GithubIcon />
                  <span className="ml-2">View on GitHub</span>
                </a>
              </div>
            </div>
          </div>
        </section>

        {/* Footer */}
        <footer className="py-8 text-center text-fd-muted-foreground text-sm">
          <p>The ORM we're all trying to build. Now available.</p>
        </footer>
      </main>
    </HomeLayout>
  );
}

// Components

function CodeBlock({
  title,
  badge,
  code,
}: {
  title: string;
  badge: string;
  code: string;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
      <div className="flex items-center justify-between border-fd-border border-b bg-fd-muted/30 px-4 py-2">
        <span className="font-medium text-fd-foreground text-sm">{title}</span>
        <span className="rounded bg-fd-primary/10 px-2 py-0.5 font-medium text-fd-primary text-xs">
          {badge}
        </span>
      </div>
      <pre className="overflow-x-auto p-4 text-sm">
        <code className="text-fd-muted-foreground">{code}</code>
      </pre>
    </div>
  );
}

function ConvergenceCard({
  title,
  items,
  highlight,
  primary = false,
}: {
  title: string;
  items: string[];
  highlight: string;
  primary?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border p-6 ${
        primary
          ? "border-fd-primary bg-fd-primary/5"
          : "border-fd-border bg-fd-card"
      }`}
    >
      <h3 className={`mb-4 font-semibold ${primary ? "text-fd-primary" : ""}`}>
        {title}
      </h3>
      <ul className="mb-4 space-y-2">
        {items.map((item, i) => (
          <li
            className="flex items-start gap-2 text-fd-muted-foreground text-sm"
            key={i}
          >
            <span
              className={
                primary ? "text-fd-primary" : "text-fd-muted-foreground"
              }
            >
              {primary ? "✓" : "→"}
            </span>
            {item}
          </li>
        ))}
      </ul>
      <p
        className={`border-t pt-4 font-medium text-xs ${
          primary
            ? "border-fd-primary/20 text-fd-primary"
            : "border-fd-border text-fd-muted-foreground"
        }`}
      >
        {highlight}
      </p>
    </div>
  );
}

function DemandCard({
  title,
  description,
  quote,
  source,
}: {
  title: string;
  description: string;
  quote: string;
  source: string;
}) {
  return (
    <div className="rounded-lg border border-fd-border bg-fd-card p-6">
      <h3 className="mb-2 font-semibold">{title}</h3>
      <p className="mb-4 text-fd-muted-foreground text-sm">{description}</p>
      <blockquote className="border-fd-primary border-l-2 pl-3 text-fd-muted-foreground text-sm italic">
        "{quote}"
        <cite className="mt-1 block text-fd-muted-foreground/70 text-xs not-italic">
          — {source}
        </cite>
      </blockquote>
    </div>
  );
}

function FeatureCard({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="group rounded-lg border border-fd-border bg-fd-card p-6 transition-all hover:border-fd-primary/50 hover:bg-fd-accent/50">
      <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-fd-primary/10 text-fd-primary transition-colors group-hover:bg-fd-primary group-hover:text-fd-primary-foreground">
        {icon}
      </div>
      <h3 className="mb-2 font-semibold">{title}</h3>
      <p className="text-fd-muted-foreground text-sm leading-relaxed">
        {description}
      </p>
    </div>
  );
}

function ComparisonRow({
  feature,
  values,
  vibormHighlight = false,
}: {
  feature: string;
  values: [string, string, string, string];
  vibormHighlight?: boolean;
}) {
  return (
    <tr>
      <td className="px-4 py-4 font-medium">{feature}</td>
      <td className="px-4 py-4 text-center text-fd-muted-foreground">
        {values[0]}
      </td>
      <td className="px-4 py-4 text-center text-fd-muted-foreground">
        {values[1]}
      </td>
      <td className="px-4 py-4 text-center text-fd-muted-foreground">
        {values[2]}
      </td>
      <td
        className={`px-4 py-4 text-center ${
          vibormHighlight ? "font-medium text-fd-primary" : ""
        }`}
      >
        {values[3]}
      </td>
    </tr>
  );
}

// Icons

function ZapIcon() {
  return (
    <svg
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        d="M13 10V3L4 14h7v7l9-11h-7z"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
      />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
      />
    </svg>
  );
}

function CodeIcon() {
  return (
    <svg
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
      />
    </svg>
  );
}

function CheckCircleIcon() {
  return (
    <svg
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
      />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
      />
    </svg>
  );
}

function DatabaseIcon() {
  return (
    <svg
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
      />
    </svg>
  );
}

function GithubIcon() {
  return (
    <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
      <path
        clipRule="evenodd"
        d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
        fillRule="evenodd"
      />
    </svg>
  );
}

function ArrayIcon() {
  return (
    <svg
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        d="M4 6h4v12H4zM10 6h4v12h-4zM16 6h4v12h-4z"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
      />
    </svg>
  );
}

function FilterIcon() {
  return (
    <svg
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
      />
    </svg>
  );
}

function SwitchIcon() {
  return (
    <svg
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
      />
    </svg>
  );
}

function SparklesIcon() {
  return (
    <svg
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
      />
    </svg>
  );
}

function JsonIcon() {
  return (
    <svg
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
      />
      <path
        d="M9 13h2m-1-1v4m4-3h.01M15 15h.01"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
      />
    </svg>
  );
}

function PlugIcon() {
  return (
    <svg
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
      />
    </svg>
  );
}
