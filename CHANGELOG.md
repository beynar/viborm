# Changelog

All notable changes to VibORM are recorded here. Releases follow Semantic
Versioning.

## Unreleased

- Prepare the V1 release and publication system.
- Generate every string identifier natively: `@paralleldrive/cuid2`, `nanoid`
  and `ulidx` leave the dependency graph and `@noble/hashes` joins it for
  SHA3-512. CUID2 output is byte-identical to the package it replaces.
- Add `s.string().uuidv7()` and `s.string().ksuid()`, and the matching
  `generate` kinds in the JSON schema document.
- `s.string().id()` now sets `hasDefault`, so a generated primary key is
  optional in the create type as it already was at runtime. `.id()` no longer
  overrides a generator declared before it, and `.id(prefix)` after a generator
  is refused (`.id("")` names no prefix, so it stays a plain key declaration).
- A nanoid length outside the range a nanoid can have — not a whole number, or
  outside 1 to 65536, the entropy source's own per-call quota — is refused at
  declaration instead of silently producing empty identifiers or throwing a
  platform error on every row.
- PostgreSQL emits `DEFAULT gen_random_uuid()` only for an unprefixed `.uuid()`
  field.

## 0.1.0 - 2026-01-24

- Published the initial development package.
