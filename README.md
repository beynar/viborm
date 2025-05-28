# VibORM

**A Vibe Coding Experiment: Building the Perfect TypeScript ORM**

## 🚀 What is VibORM?

VibORM is an experimental TypeScript ORM born from a simple question: _"Can we vibe code a perfect ORM?"_

This project represents my attempt to combine the beautiful developer experience of Prisma with the pure TypeScript philosophy of Drizzle, creating something that feels magical to use while remaining 100% TypeScript under the hood.

## 💭 The Motivation

I love Prisma's syntax and developer experience, but I have issues with:

- **The binary dependency** - I want pure TypeScript, no external binaries
- **Code generation** - I prefer type inference over generated code
- **Not being "full TypeScript"** like Drizzle

So VibORM is my attempt to create an ORM that:

- ✨ **Feels like Prisma** - Familiar, intuitive API that developers already know and love
- 🔧 **Pure TypeScript** - Zero binaries, zero code generation, just beautiful type inference
- 🎯 **Perfect DX** - Chainable schema builder, type-safe queries, intelligent autocomplete
- 🗄️ **Database Agnostic and Interoperable** - Works with any SQL database through a unified query interface with the same schema syntax and features.

## 🏗️ Project Status & Architecture

VibORM is structured around several key components, each at different stages of completion:

### ✅ **Schema Builder** (Complete)

The chainable API for defining models, fields, and relations.

```typescript
import { s } from "baseorm";

const user = s.model("user", {
  id: s.string().id().ulid(),
  name: s.string(),
  email: s.string().unique(),
  posts: s.relation.oneToMany(() => post),
  profile: s.relation.oneToOne(() => profile),
});

const post = s.model("post", {
  id: s.string().id().ulid(),
  title: s.string(),
  content: s.string().nullable(),
  author: s.relation.manyToOne(() => user),
});
```

### ✅ **Type System** (Complete)

Fully type-safe client types inferred from schema definitions - no code generation needed.

```typescript
// Types are automatically inferred from your schema
const users = await orm.user.findMany({
  where: { name: "Alice" },
  include: { posts: true },
});
// users is fully typed based on your schema definition
```

### ✅ **Validation System** (Complete)

Built-in validation system with support for Standard Schema V1 interface (Zod, Valibot, Arktype).

```typescript
// Custom field validation
const user = s.model("user", {
  email: s.string().validator(z.string().email()),
  age: s.int().validator(z.number().min(0).max(120)),
  username: s.string().validator(usernameSchema),
});

// Schema-based JSON fields with automatic validation
const userProfile = s.json(profileSchema); // Strongly typed + validated
const settings = s.json(settingsSchema).nullable();
const metadata = s.json(); // Flexible untyped JSON
```

### 🚧 **Components In Progress**

- **AST Compiler** - Transforms TypeScript schema definitions into executable query logic
- **Database Adapters** - Support for PostgreSQL, MySQL, and other databases
- **Provider System** - Pluggable database connection and query execution
- **Migration System** - Schema evolution and database migration tools
- **Query Optimizer** - Smart query planning and execution optimization

### 📋 **Planned Features**

- **Transactions** - Full ACID transaction support
- **Multiple Database Support** - PostgreSQL, MySQL, SQLite, and more

## 🎯 Design Philosophy

VibORM follows these core principles:

- **🔒 Type Safety First** - Everything is fully type-safe using TypeScript's type inference
- **⛓️ Chainable API** - Fluent, readable schema definitions with method chaining
- **🚫 No Decorators** - Clean, functional approach without decorator magic
- **🏃‍♂️ Zero Generation** - Types are inferred at compile time, not generated
- **🔗 Prisma-Compatible** - Familiar query API that Prisma users already know
- **🏗️ Modular Design** - Loosely coupled components that can be independently tested
- **✅ Validation Built-in** - Schema-level validation with Standard Schema V1 support

## 📖 Documentation & Development History

This project is being developed as a "vibe coding" experiment, where we explore what's possible when we prioritize developer experience and type safety above all else.

**Every change, discussion, and breakthrough is meticulously documented in [AI-CHANGELOG.md](./AI-CHANGELOG.md)**

The changelog contains:

- Detailed implementation discussions
- Technical breakthrough explanations
- Problem-solving approaches
- Architecture decision rationale
- Complete development timeline

## 🚀 Current Example

Here's what VibORM looks like today:

```typescript
import { s } from "baseorm";
import { z } from "zod";

// Schema Definition with Validation (✅ Working)
const user = s.model("user", {
  id: s.string().id().ulid(),
  name: s.string().validator(z.string().min(1).max(100)),
  email: s.string().unique().validator(z.string().email()),
  age: s.int().nullable().validator(z.number().min(0).max(120)),
  posts: s.relation.oneToMany(() => post),
  profile: s.json(profileSchema), // Strongly typed JSON with validation
  createdAt: s.dateTime().now(),
});

const post = s.model("post", {
  id: s.string().id().ulid(),
  title: s.string().validator(z.string().min(1).max(200)),
  content: s.string().nullable(),
  author: s.relation.manyToOne(() => user),
  metadata: s.json(postMetadataSchema).nullable(),
  publishedAt: s.dateTime().nullable(),
});

// Client Usage (🚧 In Progress)
const orm = createClient({
  provider: "postgresql",
  url: process.env.DATABASE_URL,
});

// This will work once the AST compiler and adapters are complete
const users = await orm.user.findMany({
  where: {
    posts: {
      some: {
        publishedAt: { not: null },
      },
    },
  },
  include: { posts: true },
});
```

## 🧪 Experiment Status

This is very much an **active experiment**. The goal is to push the boundaries of what's possible with TypeScript's type system while maintaining excellent developer experience.

- **Schema System**: ✅ Production-ready
- **Type Inference**: ✅ Production-ready
- **Validation System**: ✅ Production-ready
- **Query System**: 🚧 In active development
- **Database Layer**: 📋 Planned
- **Migration Tools**: 📋 Planned

## 🤝 Contributing

This is primarily a learning and experimentation project, but if you're interested in exploring advanced TypeScript patterns and ORM design, feel free to check out the codebase and [AI-CHANGELOG.md](./AI-CHANGELOG.md) to understand the development journey.

## 📄 License

MIT - Feel free to learn from, fork, or experiment with this code.

---

_VibORM: Where TypeScript meets database perfection_ ✨
