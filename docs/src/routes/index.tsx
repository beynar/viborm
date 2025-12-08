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
        <section className="relative overflow-hidden border-b border-fd-border">
          <div className="absolute inset-0 bg-gradient-to-br from-fd-primary/5 via-transparent to-fd-primary/10" />
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-fd-primary/10 via-transparent to-transparent" />

          <div className="relative container mx-auto px-6 py-24 md:py-32 lg:py-40">
            <div className="max-w-4xl mx-auto text-center">
              <div className="inline-flex items-center gap-2 px-3 py-1 mb-6 text-sm font-medium rounded-full bg-fd-primary/10 text-fd-primary border border-fd-primary/20">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-fd-primary opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-fd-primary"></span>
                </span>
                The Convergence Point
              </div>

              <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight mb-6">
                The ORM We're All{" "}
                <span className="bg-gradient-to-r from-fd-primary to-fd-primary/60 bg-clip-text text-transparent">
                  Trying to Build
                </span>
              </h1>

              <p className="text-lg md:text-xl text-fd-muted-foreground mb-8 max-w-3xl mx-auto leading-relaxed">
                Prisma pioneered elegant APIs but requires code generation and
                WASM. Drizzle went lightweight but sacrificed elegance. VibORM
                combines both:{" "}
                <span className="text-fd-foreground font-medium">
                  Prisma's elegant API, zero code generation, no WASM — pure
                  TypeScript.
                </span>
              </p>

              <div className="flex flex-col sm:flex-row gap-4 justify-center">
                <Link
                  to="/docs/$"
                  params={{ _splat: "getting-started/quick-start" }}
                  className="inline-flex items-center justify-center px-6 py-3 text-base font-medium rounded-lg bg-fd-primary text-fd-primary-foreground hover:bg-fd-primary/90 transition-colors"
                >
                  Get Started
                  <svg
                    className="ml-2 w-4 h-4"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M13 7l5 5m0 0l-5 5m5-5H6"
                    />
                  </svg>
                </Link>
                <Link
                  to="/docs/$"
                  params={{ _splat: "" }}
                  className="inline-flex items-center justify-center px-6 py-3 text-base font-medium rounded-lg border border-fd-border bg-fd-background hover:bg-fd-accent transition-colors"
                >
                  Read the Docs
                </Link>
              </div>
            </div>
          </div>
        </section>

        {/* The Convergence Story */}
        <section className="py-16 md:py-24 border-b border-fd-border">
          <div className="container mx-auto px-6">
            <div className="max-w-4xl mx-auto">
              <div className="text-center mb-12">
                <h2 className="text-2xl md:text-3xl font-bold mb-4">
                  The Great ORM Convergence
                </h2>
                <p className="text-fd-muted-foreground max-w-3xl mx-auto leading-relaxed">
                  In 2020, Prisma pioneered object-based queries and relational
                  APIs. Drizzle launched as the "anti-Prisma" — lightweight,
                  SQL-first, no abstractions. Now in 2025, Drizzle's v2 adopts
                  the exact patterns they once dismissed.
                  <span className="block mt-2 text-fd-foreground font-medium">
                    This isn't copying. It's convergence. Production demands
                    these patterns.
                  </span>
                </p>
              </div>

              <div className="grid md:grid-cols-3 gap-6">
                <ConvergenceCard
                  title="Prisma's Path"
                  items={[
                    "Elegant, readable schemas",
                    "Intuitive query API",
                    "Code generation required",
                    "WASM engine overhead",
                  ]}
                  highlight="Beautiful DX, but heavy toolchain"
                />
                <ConvergenceCard
                  title="Drizzle's Path"
                  items={[
                    "Verbose, SQL-like schemas",
                    "Relations defined separately",
                    "Callback-based → object-based",
                    "Zero code generation",
                  ]}
                  highlight="Lightweight, but sacrificed elegance"
                />
                <ConvergenceCard
                  title="VibORM"
                  items={[
                    "Prisma's elegant API ✓",
                    "Zero code generation ✓",
                    "No WASM, pure TypeScript ✓",
                    "Database-agnostic features ✓",
                  ]}
                  highlight="The best of both worlds"
                  primary
                />
              </div>
            </div>
          </div>
        </section>

        {/* What Production Demands */}
        <section className="py-16 md:py-24 border-b border-fd-border bg-fd-card/30">
          <div className="container mx-auto px-6">
            <div className="max-w-4xl mx-auto">
              <div className="text-center mb-12">
                <h2 className="text-2xl md:text-3xl font-bold mb-4">
                  What Production Actually Demands
                </h2>
                <p className="text-fd-muted-foreground max-w-2xl mx-auto">
                  These patterns aren't arbitrary preferences — they're optimal
                  solutions that emerge when you tackle production-scale
                  problems.
                </p>
              </div>

              <div className="grid sm:grid-cols-2 gap-6">
                <DemandCard
                  title="Complete object-based queries"
                  description="Drizzle v2 adopted object-based patterns but only partially — missing nested selects on relations and other features. VibORM implements the full Prisma-like API."
                  quote="where is now object. orderBy is now object."
                  source="Drizzle v2 Migration Docs"
                />
                <DemandCard
                  title="Schema elegance isn't optional"
                  description="Drizzle forces you to define relations separately from models. That's not just inconvenient — it's harder to understand and maintain. VibORM keeps relations inline, like Prisma."
                  quote="Your schema should be readable at a glance, not scattered across files."
                  source="Developer Experience"
                />
                <DemandCard
                  title="Typed JSON columns"
                  description="Other ORMs treat JSON as 'any'. VibORM lets you define JSON schemas with Zod or Valibot — full type inference and runtime validation on your JSON data."
                  quote="JSON columns shouldn't be a type safety escape hatch."
                  source="Type Safety"
                />
                <DemandCard
                  title="No WASM, no complexity"
                  description="Prisma bundles a Rust engine compiled to WASM — extra binaries, platform issues, slower cold starts. VibORM is pure TypeScript. Nothing to download, nothing to compile."
                  quote="The simplest architecture is the best architecture."
                  source="Engineering Wisdom"
                />
              </div>
            </div>
          </div>
        </section>

        {/* Elegance Comparison */}
        <section className="py-16 md:py-24 border-b border-fd-border">
          <div className="container mx-auto px-6">
            <div className="max-w-5xl mx-auto">
              <div className="text-center mb-12">
                <h2 className="text-2xl md:text-3xl font-bold mb-4">
                  Elegance Matters
                </h2>
                <p className="text-fd-muted-foreground max-w-2xl mx-auto">
                  Drizzle requires relations to be defined separately from your
                  models. VibORM keeps everything together — like Prisma, but in
                  pure TypeScript.
                </p>
              </div>

              <div className="grid md:grid-cols-2 gap-6 mb-8">
                <CodeBlock
                  title="drizzle-schema.ts"
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
                />

                <CodeBlock
                  title="viborm-schema.ts"
                  badge="VibORM"
                  code={`// Everything in one place — clean & elegant ✨
const user = s.model({
  id: s.string().id().ulid(),
  email: s.string().unique(),
  name: s.string().nullable(),
  posts: s.relation.oneToMany(() => post),
}).map("users");

const post = s.model({
  id: s.string().id().ulid(),
  title: s.string(),
  authorId: s.string(),
  author: s.relation
    .fields("authorId")
    .references("id")
    .manyToOne(() => user),
}).map("posts");

// That's it. Relations are part of the model.
// Chainable. Readable. Elegant.`}
                />
              </div>

              <div className="grid md:grid-cols-2 gap-6">
                <div className="p-5 rounded-lg border border-fd-border bg-fd-card">
                  <h3 className="font-semibold mb-2 flex items-center gap-2">
                    <span className="text-red-500">✗</span> Drizzle's Approach
                  </h3>
                  <ul className="text-sm text-fd-muted-foreground space-y-1">
                    <li>
                      • Relations defined in separate{" "}
                      <code className="text-xs bg-fd-muted px-1 rounded">
                        relations()
                      </code>{" "}
                      calls
                    </li>
                    <li>• Schema scattered across multiple declarations</li>
                    <li>• Harder to understand model structure at a glance</li>
                    <li>• More boilerplate, less readable</li>
                  </ul>
                </div>
                <div className="p-5 rounded-lg border border-fd-primary/30 bg-fd-primary/5">
                  <h3 className="font-semibold mb-2 flex items-center gap-2 text-fd-primary">
                    <span>✓</span> VibORM's Approach
                  </h3>
                  <ul className="text-sm text-fd-muted-foreground space-y-1">
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
        <section className="py-16 md:py-24 border-b border-fd-border bg-fd-card/30">
          <div className="container mx-auto px-6">
            <div className="max-w-5xl mx-auto">
              <div className="text-center mb-12">
                <h2 className="text-2xl md:text-3xl font-bold mb-4">
                  Your Schema Library, Native Support
                </h2>
                <p className="text-fd-muted-foreground max-w-2xl mx-auto">
                  Use Zod, Valibot, or ArkType to narrow field validation.
                  Define typed JSON columns with full inference. No other ORM
                  does this.
                </p>
              </div>

              <div className="grid md:grid-cols-2 gap-6 mb-8">
                <CodeBlock
                  title="typed-json.ts"
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
                />

                <CodeBlock
                  title="narrowed-validation.ts"
                  badge="Standard Schema"
                  code={`import { s } from "viborm";
import { z } from "zod";
import * as v from "valibot";

// Use Zod for email validation
const user = s.model({
  id: s.string().id().ulid(),
  email: s.string().validator(
    z.string().email()
  ),
  // Or use Valibot
  phone: s.string().validator(
    v.pipe(v.string(), v.regex(/^\\+[0-9]{10,15}$/))
  ),
  // Or ArkType
  age: s.int().validator(type("number > 0 & < 150")),
}).map("users");

// Works with any Standard Schema compliant library
// Same API, your choice of validator`}
                />
              </div>

              <div className="grid sm:grid-cols-3 gap-4">
                <div className="p-4 rounded-lg border border-fd-border bg-fd-card text-center">
                  <div className="font-semibold mb-1">Zod</div>
                  <p className="text-xs text-fd-muted-foreground">
                    Most popular schema library
                  </p>
                </div>
                <div className="p-4 rounded-lg border border-fd-border bg-fd-card text-center">
                  <div className="font-semibold mb-1">Valibot</div>
                  <p className="text-xs text-fd-muted-foreground">
                    Lightweight alternative
                  </p>
                </div>
                <div className="p-4 rounded-lg border border-fd-border bg-fd-card text-center">
                  <div className="font-semibold mb-1">ArkType</div>
                  <p className="text-xs text-fd-muted-foreground">
                    Fastest runtime validation
                  </p>
                </div>
              </div>

              <div className="mt-8 p-6 rounded-lg border border-fd-primary/30 bg-fd-primary/5">
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 rounded-lg bg-fd-primary text-fd-primary-foreground flex items-center justify-center flex-shrink-0">
                    <JsonIcon />
                  </div>
                  <div>
                    <h3 className="font-semibold mb-1">
                      JSON Columns, Finally Type-Safe
                    </h3>
                    <p className="text-sm text-fd-muted-foreground">
                      Other ORMs treat JSON as{" "}
                      <code className="text-xs bg-fd-muted px-1 rounded">
                        any
                      </code>{" "}
                      or{" "}
                      <code className="text-xs bg-fd-muted px-1 rounded">
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
        <section className="py-16 md:py-24 border-b border-fd-border bg-fd-card/30">
          <div className="container mx-auto px-6">
            <div className="max-w-5xl mx-auto">
              <div className="text-center mb-12">
                <h2 className="text-2xl md:text-3xl font-bold mb-4">
                  Queries That Read Like English
                </h2>
                <p className="text-fd-muted-foreground max-w-2xl mx-auto">
                  Prisma's query API is beloved for a reason — it's intuitive.
                  VibORM brings that same elegance without the code generation.
                </p>
              </div>

              <div className="max-w-3xl mx-auto">
                <CodeBlock
                  title="queries.ts"
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
                />
              </div>

              <div className="mt-8 p-6 rounded-lg border border-fd-border bg-fd-background">
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 rounded-lg bg-fd-primary/10 text-fd-primary flex items-center justify-center flex-shrink-0">
                    <ZapIcon />
                  </div>
                  <div>
                    <h3 className="font-semibold mb-1">
                      Simpler Stack, Better Performance
                    </h3>
                    <p className="text-sm text-fd-muted-foreground">
                      No{" "}
                      <code className="text-xs bg-fd-muted px-1.5 py-0.5 rounded">
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
        <section className="py-16 md:py-24 border-b border-fd-border">
          <div className="container mx-auto px-6">
            <div className="text-center mb-12">
              <h2 className="text-2xl md:text-3xl font-bold mb-4">
                The Full Picture
              </h2>
              <p className="text-fd-muted-foreground max-w-2xl mx-auto">
                Prisma's elegance. Drizzle's zero-generation. VibORM combines
                both — without the compromises.
              </p>
            </div>

            <div className="max-w-4xl mx-auto overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-fd-border">
                    <th className="text-left py-4 px-4 font-semibold">
                      Feature
                    </th>
                    <th className="text-center py-4 px-4 font-semibold text-fd-muted-foreground">
                      Prisma
                    </th>
                    <th className="text-center py-4 px-4 font-semibold text-fd-muted-foreground">
                      Drizzle v1
                    </th>
                    <th className="text-center py-4 px-4 font-semibold text-fd-muted-foreground">
                      Drizzle v2
                    </th>
                    <th className="text-center py-4 px-4 font-semibold text-fd-primary">
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

            <p className="text-center text-sm text-fd-muted-foreground mt-6 max-w-2xl mx-auto">
              Prisma has elegance but requires generation and WASM. Drizzle is
              lightweight but sacrificed elegance. VibORM gives you both —
              beautiful queries, pure TypeScript, no build step.
            </p>
          </div>
        </section>

        {/* Database Abstraction Section */}
        <section className="py-16 md:py-24 border-b border-fd-border">
          <div className="container mx-auto px-6">
            <div className="max-w-4xl mx-auto">
              <div className="text-center mb-12">
                <h2 className="text-2xl md:text-3xl font-bold mb-4">
                  One API. Every Database. Every Feature.
                </h2>
                <p className="text-fd-muted-foreground max-w-3xl mx-auto leading-relaxed">
                  Other ORMs give you different features depending on your
                  database. VibORM abstracts the limitations away — your code
                  works the same whether you're on PostgreSQL, MySQL, or SQLite.
                </p>
              </div>

              <div className="grid md:grid-cols-3 gap-6 mb-8">
                <div className="p-5 rounded-lg border border-fd-border bg-fd-card text-center">
                  <div className="w-12 h-12 rounded-full bg-fd-primary/10 text-fd-primary flex items-center justify-center mx-auto mb-3">
                    <ArrayIcon />
                  </div>
                  <h3 className="font-semibold mb-2">Scalar Arrays</h3>
                  <p className="text-sm text-fd-muted-foreground">
                    MySQL doesn't support array columns natively. VibORM
                    emulates them with JSON — same API, same types, any
                    database.
                  </p>
                </div>
                <div className="p-5 rounded-lg border border-fd-border bg-fd-card text-center">
                  <div className="w-12 h-12 rounded-full bg-fd-primary/10 text-fd-primary flex items-center justify-center mx-auto mb-3">
                    <FilterIcon />
                  </div>
                  <h3 className="font-semibold mb-2">DISTINCT Queries</h3>
                  <p className="text-sm text-fd-muted-foreground">
                    DISTINCT ON isn't available everywhere. VibORM provides
                    consistent distinct behavior across all supported databases.
                  </p>
                </div>
                <div className="p-5 rounded-lg border border-fd-border bg-fd-card text-center">
                  <div className="w-12 h-12 rounded-full bg-fd-primary/10 text-fd-primary flex items-center justify-center mx-auto mb-3">
                    <SwitchIcon />
                  </div>
                  <h3 className="font-semibold mb-2">Switch Anytime</h3>
                  <p className="text-sm text-fd-muted-foreground">
                    Start with SQLite for development, deploy to PostgreSQL.
                    Your queries don't change — the ORM handles the translation.
                  </p>
                </div>
              </div>

              <div className="p-6 rounded-lg border border-fd-primary/30 bg-fd-primary/5">
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 rounded-lg bg-fd-primary text-fd-primary-foreground flex items-center justify-center flex-shrink-0">
                    <DatabaseIcon />
                  </div>
                  <div>
                    <h3 className="font-semibold mb-1">The Real Abstraction</h3>
                    <p className="text-sm text-fd-muted-foreground">
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
        <section className="py-16 md:py-24 border-b border-fd-border bg-fd-card/30">
          <div className="container mx-auto px-6">
            <div className="text-center mb-12">
              <h2 className="text-2xl md:text-3xl font-bold mb-4">
                Features That Survived Convergence
              </h2>
              <p className="text-fd-muted-foreground max-w-2xl mx-auto">
                These aren't arbitrary preferences. They're the patterns that
                every production ORM eventually implements.
              </p>
            </div>

            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6 max-w-5xl mx-auto">
              <FeatureCard
                icon={<SparklesIcon />}
                title="Prisma's Elegance"
                description="Chainable schemas. Relations defined inline. Queries that read like English. The beautiful DX Prisma pioneered — in pure TypeScript."
              />
              <FeatureCard
                icon={<LinkIcon />}
                title="Relations Done Right"
                description="Defined inline, not scattered. include, nested select, relation filters — Prisma's complete relational API without the separate relations() boilerplate."
              />
              <FeatureCard
                icon={<ShieldIcon />}
                title="Full Type Safety"
                description="Every query, filter, and result is typed. No any, no guessing, no runtime surprises."
              />
              <FeatureCard
                icon={<ZapIcon />}
                title="Pure TypeScript"
                description="No code generation, no WASM engine, no binary downloads. Just TypeScript — simpler workflow, faster cold starts, works everywhere."
              />
              <FeatureCard
                icon={<CheckCircleIcon />}
                title="Exported Model Schemas"
                description="ArkType schemas auto-generated from your models. Use them for API validation, form validation — anywhere you need runtime checks outside the ORM."
              />
              <FeatureCard
                icon={<PlugIcon />}
                title="Standard Schema Integration"
                description="Use Zod, Valibot, or ArkType to narrow field validation and type JSON columns. Your favorite schema library, native support."
              />
              <FeatureCard
                icon={<DatabaseIcon />}
                title="True Database Abstraction"
                description="Scalar arrays on MySQL. DISTINCT on SQLite. Every feature works everywhere — the ORM abstracts database limitations, not just syntax."
              />
            </div>
          </div>
        </section>

        {/* CTA Section */}
        <section className="py-16 md:py-24 border-b border-fd-border bg-fd-card/30">
          <div className="container mx-auto px-6">
            <div className="max-w-2xl mx-auto text-center">
              <h2 className="text-2xl md:text-3xl font-bold mb-4">
                Skip the Convergence. Start at the Destination.
              </h2>
              <p className="text-fd-muted-foreground mb-8">
                Why wait for other ORMs to implement what you need? VibORM has
                the patterns that production demands — today.
              </p>

              <div className="bg-fd-card border border-fd-border rounded-lg p-4 font-mono text-sm text-left mb-8">
                <div className="flex items-center gap-2 text-fd-muted-foreground">
                  <span className="text-fd-primary">$</span>
                  <span>npm install viborm</span>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row gap-4 justify-center">
                <Link
                  to="/docs/$"
                  params={{ _splat: "getting-started/quick-start" }}
                  className="inline-flex items-center justify-center px-6 py-3 text-base font-medium rounded-lg bg-fd-primary text-fd-primary-foreground hover:bg-fd-primary/90 transition-colors"
                >
                  Get Started
                  <svg
                    className="ml-2 w-4 h-4"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M13 7l5 5m0 0l-5 5m5-5H6"
                    />
                  </svg>
                </Link>
                <a
                  href="https://github.com/your-org/viborm"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center px-6 py-3 text-base font-medium rounded-lg border border-fd-border bg-fd-background hover:bg-fd-accent transition-colors"
                >
                  <GithubIcon />
                  <span className="ml-2">View on GitHub</span>
                </a>
              </div>
            </div>
          </div>
        </section>

        {/* Footer */}
        <footer className="py-8 text-center text-sm text-fd-muted-foreground">
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
    <div className="bg-fd-card border border-fd-border rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-fd-border bg-fd-muted/30">
        <span className="text-sm font-medium text-fd-foreground">{title}</span>
        <span className="text-xs px-2 py-0.5 rounded bg-fd-primary/10 text-fd-primary font-medium">
          {badge}
        </span>
      </div>
      <pre className="p-4 text-sm overflow-x-auto">
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
      className={`p-6 rounded-lg border ${
        primary
          ? "border-fd-primary bg-fd-primary/5"
          : "border-fd-border bg-fd-card"
      }`}
    >
      <h3 className={`font-semibold mb-4 ${primary ? "text-fd-primary" : ""}`}>
        {title}
      </h3>
      <ul className="space-y-2 mb-4">
        {items.map((item, i) => (
          <li
            key={i}
            className="text-sm text-fd-muted-foreground flex items-start gap-2"
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
        className={`text-xs font-medium pt-4 border-t ${
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
    <div className="p-6 rounded-lg border border-fd-border bg-fd-card">
      <h3 className="font-semibold mb-2">{title}</h3>
      <p className="text-sm text-fd-muted-foreground mb-4">{description}</p>
      <blockquote className="text-sm italic border-l-2 border-fd-primary pl-3 text-fd-muted-foreground">
        "{quote}"
        <cite className="block text-xs mt-1 not-italic text-fd-muted-foreground/70">
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
    <div className="group p-6 rounded-lg border border-fd-border bg-fd-card hover:border-fd-primary/50 hover:bg-fd-accent/50 transition-all">
      <div className="w-10 h-10 rounded-lg bg-fd-primary/10 text-fd-primary flex items-center justify-center mb-4 group-hover:bg-fd-primary group-hover:text-fd-primary-foreground transition-colors">
        {icon}
      </div>
      <h3 className="font-semibold mb-2">{title}</h3>
      <p className="text-sm text-fd-muted-foreground leading-relaxed">
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
      <td className="py-4 px-4 font-medium">{feature}</td>
      <td className="py-4 px-4 text-center text-fd-muted-foreground">
        {values[0]}
      </td>
      <td className="py-4 px-4 text-center text-fd-muted-foreground">
        {values[1]}
      </td>
      <td className="py-4 px-4 text-center text-fd-muted-foreground">
        {values[2]}
      </td>
      <td
        className={`py-4 px-4 text-center ${
          vibormHighlight ? "text-fd-primary font-medium" : ""
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
      className="w-5 h-5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M13 10V3L4 14h7v7l9-11h-7z"
      />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg
      className="w-5 h-5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
      />
    </svg>
  );
}

function CodeIcon() {
  return (
    <svg
      className="w-5 h-5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"
      />
    </svg>
  );
}

function CheckCircleIcon() {
  return (
    <svg
      className="w-5 h-5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg
      className="w-5 h-5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
      />
    </svg>
  );
}

function DatabaseIcon() {
  return (
    <svg
      className="w-5 h-5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4"
      />
    </svg>
  );
}

function GithubIcon() {
  return (
    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
      />
    </svg>
  );
}

function ArrayIcon() {
  return (
    <svg
      className="w-5 h-5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M4 6h4v12H4zM10 6h4v12h-4zM16 6h4v12h-4z"
      />
    </svg>
  );
}

function FilterIcon() {
  return (
    <svg
      className="w-5 h-5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"
      />
    </svg>
  );
}

function SwitchIcon() {
  return (
    <svg
      className="w-5 h-5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"
      />
    </svg>
  );
}

function SparklesIcon() {
  return (
    <svg
      className="w-5 h-5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z"
      />
    </svg>
  );
}

function JsonIcon() {
  return (
    <svg
      className="w-5 h-5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"
      />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M9 13h2m-1-1v4m4-3h.01M15 15h.01"
      />
    </svg>
  );
}

function PlugIcon() {
  return (
    <svg
      className="w-5 h-5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
      />
    </svg>
  );
}
