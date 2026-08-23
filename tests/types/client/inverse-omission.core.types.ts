/**
 * THE OMITTED-KEY SURFACE, seen from a client call.
 *
 * The nested-data projection decides which TARGET keys a nested payload may not
 * spell, because the enclosing step derives them (plan §8.1). This file makes
 * that decision falsifiable through the public client, where a caller meets it:
 * the runtime witnesses in `nested-update-owned-fk.test.ts` cast their payloads
 * `as never`, which proves nothing about the surface a caller types against.
 *
 * RE-FOUNDED (ruling D17). The old file's whole subject was two degenerate
 * zero-argument `.fields()` schemas, a spelling §3.4 deletes; there is no
 * "degenerate" reading of a foreign key any more, because a slot either
 * completed `.fields(...).references(...)` or it did not. What survives is the
 * DIRECTION the old file was really measuring — an inverse omits the owner's
 * columns, the owner omits nothing — and it is measured on the ordinary
 * spelling now.
 *
 * Probes follow the contextual-typing gate's rules: public API entry, a refused
 * key BESIDE a real key. Nothing here is called; only the types matter.
 */

import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { s } from "@schema";

const splitUser = s.model({
  id: s.string().id(),
  name: s.string(),
  // The NON-owner of a one-to-one: `splitProfile.userId` records the edge.
  profile: s.toOne(() => splitProfile),
});
const splitProfile = s.model({
  id: s.string().id(),
  bio: s.string(),
  userId: s.string().unique().nullable(),
  user: s
    .toOne(() => splitUser)
    .fields("userId")
    .references("id"),
});

const splitAuthor = s.model({
  id: s.string().id(),
  name: s.string(),
  posts: s.toMany(() => splitPost),
});
const splitPost = s.model({
  id: s.string().id(),
  title: s.string(),
  userId: s.string(),
  author: s
    .toOne(() => splitAuthor)
    .fields("userId")
    .references("id"),
});

const client = createClient({
  schema: { splitUser, splitProfile, splitAuthor, splitPost },
  driver: new PGliteDriver(),
});

// ---------------------------------------------------------------------------
// Measured compile-SUCCESS pins. The omission removes `userId` from the keys
// these nested data types OFFER (completion follows the type twins in
// `nested-data-projection.ts`), but a SPELLED extra key still compiles: `data`
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
// The two derived facts, from the SAME edge, on the surface a caller sees.
// ---------------------------------------------------------------------------

/**
 * `splitProfile.userId` is nullable, so the membership clears and the NON-owner
 * offers `disconnect`. This is derived from the column now, never from a
 * `.optional()` flag a schema author had to remember to write.
 */
const _disconnectIsOfferedWhenTheColumnIsNullable = () =>
  client.splitUser.update({
    where: { id: "owner" },
    data: { profile: { disconnect: true } },
  });

/**
 * `splitPost.userId` is NOT nullable, so the same edge's inverse cannot be cut.
 * Its impossible input member makes the refusal structural even below generic
 * operation data; the runtime still refuses it as `Unknown key`.
 */
const _disconnectIsRefusedOnARequiredMembership = () =>
  client.splitAuthor.update({
    where: { id: "owner" },
    data: {
      posts: {
        connect: { id: "p1" },
        // @ts-expect-error - this membership cannot be disconnected
        disconnect: { id: "p1" },
      },
    },
  });

/**
 * The OWNER's own slot: `splitPost.author` completes the foreign key, so
 * `splitPost.userId` is not a key its nested `author` payload could spell
 * anyway — the omission is scoped to the target row, never to the source's.
 * The typo sits beside `name`, a real key of the target.
 */
const _theOwnersNestedPayloadKeepsTheTargetsOwnKeys = () =>
  client.splitPost.update({
    where: { id: "p1" },
    data: {
      author: {
        update: { name: "renamed" },
      },
    },
  });
