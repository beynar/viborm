# Prisma Subset Priorities

## Purpose

This note ranks the README Prisma compatibility rows marked `Subset`.

`Subset` does not automatically mean "bug". Some rows are real Prisma-parity
gaps worth closing; others are provider-specific Prisma features or intentionally
rejected shapes.

## Priority 1: Worth Working On

| Area | Why it matters | Target direction |
|------|----------------|------------------|
| Nested writes | Core documented nested `update`, `updateMany`, `upsert`, and `deleteMany` shapes are implemented for callback-transaction and atomic-batch driver paths, including generated and updated primary-key dataflow where the shape is safe. The remaining risk is hosted-provider proof. | Keep local conformance coverage green, track hosted-provider gaps explicitly, and reject only driver paths that provide no atomic strategy or cannot prove a specific unsafe shape before mutation. |
| `distinct` semantics | `distinct` interacts with `select`, `orderBy`, pagination, and dialect SQL. A weak subset can surprise users. | Either harden the documented SQL-backed subset or reject risky combinations before SQL generation. |

## Priority 2: Maybe Later

| Area | Why not first | Target direction |
|------|---------------|------------------|
| Query-level `omit` | Real Prisma ergonomics gap, but `select` already covers explicit projection. | Keep unsupported until there is a concrete product reason to add it. |

## Priority 3: Do Not Chase for Core Parity

| Area | Reason |
|------|--------|
| Arbitrary to-many scalar-field ordering | Correct to reject. Ordering a parent row by an unaggregated child scalar field is ambiguous unless the query defines which child row wins. Prisma's useful core shape is relation aggregate ordering such as `{ posts: { _count: "desc" } }`, which VibORM supports. |
| `_relevance` ordering | Search/provider feature, not core ORM CRUD/query parity. It should be a dedicated search feature if added. |

## Recommended Order

1. Nested-write conformance and final audit.
2. `distinct` semantics.
3. Query-level `omit`, only if projection ergonomics become a real product need.

## Guardrails

- Query engine decides WHAT; adapters decide dialect-specific SQL.
- Accepted inputs must work correctly or reject before query generation.
- Runtime behavior and TypeScript behavior should agree where practical.
- No Prisma `XOR` / `Exact` / heavy type-algebra clone just to close a subset row.
- Do not implement provider-specific features as fake cross-dialect defaults.
- Do not add arbitrary to-many scalar-field ordering to core parity.
