/**
 * Phase 1 (distinct-truth compression) — public-client probes for scalar and
 * GROUPED compound unique selectors, unit 1.3 item 6.
 *
 * The model-key catalog centralizes ordered key facts; this file proves the
 * PUBLIC selector surface those facts feed did not move: a grouped compound
 * selector accepts its members (fresh and non-fresh), refuses an unknown
 * member spelled BESIDE a real one, and refuses an incomplete member set.
 * Probes follow the contextual-typing gate's rules — public API entry only,
 * typo beside a real key, fresh and non-fresh both probed.
 *
 * Nothing here is called; only the types matter.
 */

import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { s } from "@schema";

const org = s
  .model({
    id: s.int().id(),
    region: s.string(),
    code: s.string(),
    label: s.string(),
  })
  .unique(["region", "code"], { name: "regionCode" });

const cell = s
  .model({
    slot: s.string(),
    tenantId: s.string(),
    note: s.string(),
  })
  .id(["slot", "tenantId"]);

const account = s.model({
  id: s.int().id(),
  email: s.string().unique(),
  name: s.string(),
});

const schema = { org, cell, account };
const client = createClient({ schema, driver: new PGliteDriver() });

// ---------------------------------------------------------------------------
// Accepted spellings, fresh literals.
// ---------------------------------------------------------------------------

const _namedCompoundFresh = () =>
  client.org.findUnique({
    where: { regionCode: { region: "eu", code: "1" } },
  });

const _compoundIdFresh = () =>
  client.cell.findUnique({
    where: { slot_tenantId: { slot: "a", tenantId: "t1" } },
  });

const _scalarUniqueFresh = () =>
  client.account.findUnique({ where: { email: "a@b.c" } });

// ---------------------------------------------------------------------------
// Accepted spellings, non-fresh (excess-property checking does not apply, so
// acceptance must come from the surface's own keys).
// ---------------------------------------------------------------------------

const heldCompound = { regionCode: { region: "eu", code: "1" } };
const _namedCompoundHeld = () => client.org.findUnique({ where: heldCompound });

const heldCompoundId = { slot_tenantId: { slot: "a", tenantId: "t1" } };
const _compoundIdHeld = () => client.cell.findUnique({ where: heldCompoundId });

// ---------------------------------------------------------------------------
// Refused spellings — the typo sits BESIDE a real key, per the gate's rule 3.
// ---------------------------------------------------------------------------

const _unknownSelectorBesideReal = () =>
  client.org.findUnique({
    where: {
      regionCode: { region: "eu", code: "1" },
      // @ts-expect-error - "regionCod" names no unique constraint or scalar filter
      regionCod: { code: "1" },
    },
  });

// ---------------------------------------------------------------------------
// Measured compile-SUCCESS pins — misspelled or partial calls that COMPILE at
// HEAD, kept without directives so the day the surface gains keys these lines
// go red and someone deletes the pin (the gate's "pin what you cannot key"
// rule). Each carries the obstacle or owner that answers today.
// ---------------------------------------------------------------------------

// An unknown MEMBER beside the real ones inside a grouped selector compiles.
// The runtime owner refuses it: `where-unique-builder` throws
// `Unknown field 'coed' in compound whereUnique field 'regionCode'.`
const _unknownCompoundMemberCompilesToday = () =>
  client.org.findUnique({
    where: { regionCode: { region: "eu", code: "1", coed: "1" } },
  });

// An INCOMPLETE grouped member set compiles. Completeness is runtime-owned:
// `where-unique-builder` throws `Compound whereUnique field 'slot_tenantId'
// requires 'tenantId'.` — half a compound key names no row.
const _incompleteCompoundCompilesToday = () =>
  client.cell.findUnique({
    where: { slot_tenantId: { slot: "a" } },
  });

// NOT a gap: a grouped key's member as a SIBLING key is a legal extended
// where-unique scalar FILTER (Prisma >= 4.5), narrowing the addressed row.
const _memberAsSiblingIsAnExtendedFilter = () =>
  client.cell.findUnique({
    where: { slot_tenantId: { slot: "a", tenantId: "t1" }, slot: "a" },
  });
