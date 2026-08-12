/**
 * Phase 2 (distinct-truth compression) — the TYPE half of the inverse-scanner
 * alignment, pinned on the two degenerate zero-argument-`.fields()` schemas.
 *
 * The runtime half is witnessed in `nested-update-owned-fk.test.ts`; this file
 * makes the type-level twins falsifiable (the runtime witnesses cast their
 * payloads `as never`, which proves nothing about the surface a caller types
 * against). Probes follow the contextual-typing gate's rules: public API entry,
 * the refused key BESIDE a real key.
 *
 * Nothing here is called; only the types matter.
 */

import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { s } from "@schema";

// The degenerate to-one: user.profile spells `.fields()` with ZERO arguments;
// the real back-reference lives on profile.user. Before the alignment the
// omission view read the empty tuple as fields-bearing and omitted nothing.
const splitUser = s.model({
  id: s.string().id(),
  name: s.string(),
  profile: s
    .oneToOne(() => splitProfile)
    .fields()
    .optional(),
});
const splitProfile = s.model({
  id: s.string().id(),
  bio: s.string(),
  userId: s.string().unique().nullable(),
  user: s
    .oneToOne(() => splitUser)
    .fields("userId")
    .references("id")
    .optional(),
});

// The degenerate to-many: post.ghost is a zero-argument-`.fields()` manyToOne
// declared FIRST, beside the real post.author.
const splitAuthor = s.model({
  id: s.string().id(),
  name: s.string(),
  posts: s.oneToMany(() => splitPost),
});
const splitPost = s.model({
  id: s.string().id(),
  title: s.string(),
  ghost: s.manyToOne(() => splitAuthor).fields(),
  userId: s.string(),
  author: s
    .manyToOne(() => splitAuthor)
    .fields("userId")
    .references("id"),
});

const client = createClient({
  schema: { splitUser, splitProfile, splitAuthor, splitPost },
  driver: new PGliteDriver(),
});

// ---------------------------------------------------------------------------
// Measured compile-SUCCESS pins. The aligned omission removes `userId` from the
// keys these nested data types OFFER (completion follows the type twins in
// `create.ts`/`types.ts`), but a SPELLED extra key still compiles: `data`
// clauses are the estate's documented exactness ceiling — keying them was
// measured at TS2589 on six sites and a 34s -> 172s type check
// (`contextual-typing-gate.core.types.ts`, "pin what you cannot key"). The
// RUNTIME owner refuses both spellings as `Unknown key`
// (`nested-update-owned-fk.test.ts`). No directive, so the day the ceiling
// lifts these lines go red and the pin converts to a refusal probe.
// ---------------------------------------------------------------------------

const _toOneUpdateSpelledFkCompilesToday = () =>
  client.splitUser.update({
    where: { id: "owner" },
    data: {
      profile: {
        update: { bio: "x", userId: "thief" },
      },
    },
  });

const _toManyUpdateManySpelledFkCompilesToday = () =>
  client.splitAuthor.update({
    where: { id: "owner" },
    data: {
      posts: {
        updateMany: {
          where: { title: "t" },
          data: { title: "x", userId: "thief" },
        },
      },
    },
  });

// ---------------------------------------------------------------------------
// The ratified widening, type side: `disconnect` is OFFERED on the degenerate
// to-one (nullable FK), exactly as on the ordinary spelling.
// ---------------------------------------------------------------------------

const _disconnectIsOffered = () =>
  client.splitUser.update({
    where: { id: "owner" },
    data: { profile: { disconnect: true } },
  });
