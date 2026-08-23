import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { s } from "@schema/index";

/**
 * PACKAGE H — **the composition lattice as the EDITOR sees it.**
 *
 * The runtime half is pinned in
 * `tests/unit/operation-schemas/relations/to-one-composition-lattice.core.test.ts`.
 * This file is the other half of "never ship runtime-only support": every composition
 * the schema accepts is written here the way a caller writes it — through
 * `createClient`, into `data`, with no internal alias named — and every composition the
 * TYPE refuses carries a `@ts-expect-error` that turns this file red the day it stops
 * refusing it (TS2578).
 *
 * Each refused row below spells TWO REAL KEYS. That matters: a to-one payload is a weak
 * type, so an object sharing no property with it is refused by a rule that has nothing
 * to do with this lattice. Two real keys defeat that rule, so what refuses these rows
 * is the lattice itself.
 *
 * What the type does NOT refuse is recorded further down, as pins rather than as
 * silence: an unknown key beside a real one reaches the runtime, on this surface and on
 * the create root, and that was measured against the pre-H schema too.
 */
const hub = s.model({
  id: s.string().id(),
  label: s.string(),
  /** Child-held: `badge.hubId` carries the foreign key. */
  badge: s.toOne(() => badge),
  ownerId: s.string().nullable(),
  /** Parent-held: this row carries the foreign key. */
  owner: s
    .toOne(() => owner)
    .fields("ownerId")
    .references("id"),
});

const badge = s.model({
  id: s.string().id(),
  tag: s.string(),
  hubId: s.string().unique().nullable(),
  hub: s
    .toOne(() => hub)
    .fields("hubId")
    .references("id"),
});

const owner = s.model({
  id: s.string().id(),
  name: s.string(),
  hubs: s.toMany(() => hub),
});

const client = createClient({
  schema: { badge, hub, owner },
  driver: new PGliteDriver(),
});

// =============================================================================
// THE SIX NEW LATTICE MEMBERS — these must COMPILE
// =============================================================================

const _childHeldConnectThenModify = () =>
  client.hub.update({
    where: { id: "h1" },
    data: { badge: { connect: { id: "b-alt" }, update: { tag: "t" } } },
  });

const _childHeldConnectOrCreateThenModify = () =>
  client.hub.update({
    where: { id: "h1" },
    data: {
      badge: {
        connectOrCreate: {
          where: { id: "b-alt" },
          create: { id: "b-alt", tag: "n" },
        },
        update: { tag: "t" },
      },
    },
  });

const _childHeldCreateThenModify = () =>
  client.hub.update({
    where: { id: "h1" },
    data: {
      badge: { create: { id: "b9", tag: "fresh" }, update: { tag: "t" } },
    },
  });

const _childHeldReplaceThenModify = () =>
  client.hub.update({
    where: { id: "h1" },
    data: {
      badge: {
        disconnect: true,
        connect: { id: "b-alt" },
        update: { tag: "t" },
      },
    },
  });

const _childHeldDeleteCreateThenModify = () =>
  client.hub.update({
    where: { id: "h1" },
    data: {
      badge: {
        delete: true,
        create: { id: "b9", tag: "fresh" },
        update: { tag: "t" },
      },
    },
  });

const _parentHeldReplacement = () =>
  client.hub.update({
    where: { id: "h1" },
    data: { owner: { disconnect: true, connect: { id: "o1" } } },
  });

const _parentHeldDeleteThenCreate = () =>
  client.hub.update({
    where: { id: "h1" },
    data: { owner: { delete: true, create: { id: "o9", name: "fresh" } } },
  });

const _parentHeldConnectThenModify = () =>
  client.hub.update({
    where: { id: "h1" },
    data: { owner: { connect: { id: "o1" }, update: { name: "n" } } },
  });

// =============================================================================
// THE ROWS THAT STAY REFUSED
// =============================================================================

const _twoSuppliers = () =>
  client.hub.update({
    where: { id: "h1" },
    data: {
      // @ts-expect-error - two suppliers name two identities for one slot
      badge: { connect: { id: "b-alt" }, create: { id: "b9", tag: "f" } },
    },
  });

const _upsertBesideAnIntent = () =>
  client.hub.update({
    where: { id: "h1" },
    data: {
      badge: {
        upsert: { update: { tag: "u" }, create: { id: "b9", tag: "c" } },
        // @ts-expect-error - `upsert` already decides the target with its own two arms
        connect: { id: "b-alt" },
      },
    },
  });

const _vacateThenModifyWithNoSupplier = () =>
  client.hub.update({
    where: { id: "h1" },
    data: {
      // @ts-expect-error - nothing is left in the slot for the modify to address
      badge: { disconnect: true, update: { tag: "t" } },
    },
  });

const _twoVacates = () =>
  client.hub.update({
    where: { id: "h1" },
    data: {
      // @ts-expect-error - one slot cannot be vacated twice
      badge: { disconnect: true, delete: true },
    },
  });

const _theSixthReplacement = () =>
  client.hub.update({
    where: { id: "h1" },
    data: {
      badge: {
        delete: true,
        // @ts-expect-error - `delete` + `connectOrCreate` is not an accepted replacement
        connectOrCreate: {
          where: { id: "b-alt" },
          create: { id: "b-alt", tag: "n" },
        },
      },
    },
  });

const _createRootChildHeldTwoSuppliers = () =>
  client.hub.create({
    data: {
      id: "h1",
      label: "L",
      // @ts-expect-error - a create root accepts at most one intent
      badge: { connect: { id: "b-alt" }, create: { id: "b9", tag: "f" } },
    },
  });

const _createRootParentHeldTwoSuppliers = () =>
  client.hub.create({
    data: {
      id: "h1",
      label: "L",
      // @ts-expect-error - a create root accepts at most one intent
      owner: { connect: { id: "o1" }, create: { id: "o9", name: "fresh" } },
    },
  });

// =============================================================================
// THE DIRECTION ASYMMETRY, AND THE KEYS A SURFACE DOES NOT OWN
// =============================================================================

const _parentHeldCreateThenModify = () =>
  client.hub.update({
    where: { id: "h1" },
    data: {
      owner: {
        create: { id: "o9", name: "fresh" },
        // @ts-expect-error - the modify would address a row this statement is producing
        update: { name: "n" },
      },
    },
  });

const _parentHeldReplaceThenModify = () =>
  client.hub.update({
    where: { id: "h1" },
    data: {
      owner: {
        disconnect: true,
        connect: { id: "o1" },
        // @ts-expect-error - the parent-held direction composes no triple
        update: { name: "n" },
      },
    },
  });

// =============================================================================
// PINS — what this surface does NOT key, with the measurement that stopped us
// =============================================================================

/**
 * The four rows below are **misspelled calls that compile**. They carry no
 * `@ts-expect-error`, so the day the surface starts refusing them the call itself
 * becomes a type error, this file goes red, and someone deletes the pin.
 *
 * MEASURED at the Package H gate, on this exact schema, by running the identical
 * probes against the PRE-H `to-one-mutation-schema.ts` and against the post-H one: all
 * four compile on BOTH. The lattice types are therefore not what admits them, and
 * making them red is not H's lift. What admits them is that a to-one relation payload
 * is contextually typed by a union of arms whose non-active keys are `?: never`:
 * excess-property checking against a union accepts a literal that matches ANY member,
 * and every member here has an index-free optional shape that an unknown key does not
 * contradict. The one probe that IS red — `_typoAlone` below — is red because of
 * weak-type detection, which stops applying the moment one real key joins it. That is
 * the trap `AGENTS.md` documents, and these pins are it, measured rather than assumed.
 */
const _pinUnknownOperationKeyBesideARealOne = () =>
  client.hub.update({
    where: { id: "h1" },
    // PIN: "updte" is not a to-one operation, and this compiles.
    data: { badge: { connect: { id: "b-alt" }, updte: { tag: "t" } } },
  });

const _pinUnknownKeyInsideASupplierArm = () =>
  client.hub.update({
    where: { id: "h1" },
    // PIN: "idd" is not a field of `badge`, and this compiles.
    data: {
      badge: { connect: { id: "b-alt", idd: "b-alt" }, update: { tag: "t" } },
    },
  });

const _pinUnknownKeyInsideTheModifyArm = () =>
  client.hub.update({
    where: { id: "h1" },
    // PIN: "tagg" is not a field of `badge`, and this compiles.
    data: {
      badge: { connect: { id: "b-alt" }, update: { tag: "t", tagg: "t" } },
    },
  });

const _pinCreateRootHasNoModifyKey = () =>
  client.hub.create({
    // PIN: `update` is not a key of a create-root to-one input — the runtime refuses it
    // with "Unknown key: update" (`parity-h-to-one-lattice.test.ts`), and this compiles.
    data: {
      id: "h1",
      label: "L",
      badge: { create: { id: "b9", tag: "f" }, update: { tag: "t" } },
    },
  });

// =============================================================================
// TYPO PROBE — the one level this surface DOES key
// =============================================================================

/**
 * Alone, and red: a to-one payload is a weak type, so an object sharing no property
 * with it is refused. Kept beside the pins above precisely because it is NOT evidence
 * that the surface is keyed — the pins are what say it is not.
 */
const _typoAlone = () =>
  client.hub.update({
    where: { id: "h1" },
    data: {
      // @ts-expect-error - "connct" is not a to-one operation
      badge: { connct: { id: "b-alt" } },
    },
  });
