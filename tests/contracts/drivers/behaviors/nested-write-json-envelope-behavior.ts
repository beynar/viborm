import { defineContract } from "@tests/contracts/contract";
import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";

import { DbNull, JsonNull, s } from "@schema";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

// ---------------------------------------------------------------------------
// A to-one chain deep enough to force the DELEGATED update path at every level:
// org → head(person) → pet → collar, plus a to-many `members` arm whose targets
// hold the same `pet`. A located update target delegates its WHOLE update to the
// update root (X1c) as soon as its own data carries a parent-held to-one write —
// which is exactly what `pet: { update: … }` is for `person`/`member`, and what
// `collar: { update: … }` is for `pet`.
//
// Every level owns a JSON column, because JSON is the one write whose validated
// form is INDISTINGUISHABLE from its own input: `{ set: <doc> }` is itself a
// perfectly ordinary JSON document. `doc` additionally owns a column literally
// named `data`, the collision the to-one update form refuses (see
// docs/content/docs/client/nested-writes.mdx) and whose documented escape —
// `update: { where: {}, data: { data: … } }` — must store the document itself.
// ---------------------------------------------------------------------------
const collar = s
  .model({
    id: s.string().id(),
    color: s.string(),
    spec: s.json().nullable(),
    pets: s.toMany(() => pet),
  })
  .map("json_envelope_collar");

const pet = s
  .model({
    id: s.string().id(),
    tag: s.string(),
    meta: s.json().nullable(),
    collarId: s.string().nullable(),
    collar: s
      .toOne(() => collar)
      .fields("collarId")
      .references("id"),
    people: s.toMany(() => person),
    members: s.toMany(() => member),
    docs: s.toMany(() => doc),
  })
  .map("json_envelope_pet");

const person = s
  .model({
    id: s.string().id(),
    note: s.string(),
    score: s.int(),
    payload: s.json().nullable(),
    petId: s.string().nullable(),
    pet: s
      .toOne(() => pet)
      .fields("petId")
      .references("id"),
    orgs: s.toMany(() => org),
  })
  .map("json_envelope_person");

const member = s
  .model({
    id: s.string().id(),
    blob: s.json().nullable(),
    orgId: s.string().nullable(),
    org: s
      .toOne(() => org)
      .fields("orgId")
      .references("id"),
    petId: s.string().nullable(),
    pet: s
      .toOne(() => pet)
      .fields("petId")
      .references("id"),
  })
  .map("json_envelope_member");

const org = s
  .model({
    id: s.string().id(),
    headId: s.string().nullable(),
    head: s
      .toOne(() => person)
      .fields("headId")
      .references("id"),
    members: s.toMany(() => member),
  })
  .map("json_envelope_org");

const doc = s
  .model({
    id: s.string().id(),
    label: s.string(),
    data: s.json().nullable(),
    petId: s.string().nullable(),
    pet: s
      .toOne(() => pet)
      .fields("petId")
      .references("id"),
    folders: s.toMany(() => folder),
  })
  .map("json_envelope_doc");

const folder = s
  .model({
    id: s.string().id(),
    docId: s.string().nullable(),
    doc: s
      .toOne(() => doc)
      .fields("docId")
      .references("id"),
  })
  .map("json_envelope_folder");

const schema = { collar, pet, person, member, org, doc, folder };

type EnvelopeClientConfig = VibORMConfig<typeof schema>;

type EnvelopeClient = VibORMClient<EnvelopeClientConfig>;

export interface NestedWriteJsonEnvelopeBehaviorOptions {
  driverName: string;
  createDriver: () => AnyDriver;
}

/**
 * The DELEGATED update target consumes its data EXACTLY ONCE.
 *
 * A nested UPDATE target whose own data carries a parent-held to-one write
 * delegates its whole update to the update root (X1c). The subtree it receives is
 * the enclosing parse's OUTPUT — already validated, already transformed. Applying
 * the schema to it a SECOND time is not a no-op for any transform that is not
 * idempotent, and the JSON write is precisely that: `update: { payload: { z: 1 } }`
 * validates to the envelope `{ payload: { set: { z: 1 } } }`, and `{ set: { z: 1 } }`
 * is itself a legal JSON document — so a second pass wrapped it AGAIN and the ORM's
 * own envelope was written into the user's column (`{"set":{"z":1}}`). The same
 * second pass rejected the JSON null sentinels outright: `{ set: JsonNull }` is
 * neither a sentinel (the brand is on the inner value) nor a JSON-compatible
 * document (a class instance inside it), so a legal write died as
 * "Expected JSON-compatible value".
 *
 * These witnesses pin the persisted VALUE — the only thing that tells one parse
 * from two — at the delegation seam, at depth 2 and depth 3, on the to-many
 * delegated target, through the documented `data`-column escape, and for both
 * null sentinels. The non-JSON writes riding the same payloads (a string, an
 * `increment`) are the control: their update form re-parses to itself, so they were
 * correct before and must stay correct now.
 *
 * Falsified: restore the re-parse in `UpdateOperation`'s relation/scalar interpret
 * (`parseValidated(relationSchemas.update, …)` / `parseValidated(core.scalarUpdate,
 * …)` unconditionally) → every JSON witness below fails with the doubled envelope
 * or the sentinel refusal, while the string/int controls stay green.
 */
export function runNestedWriteJsonEnvelopeBehavior({
  driverName,
  createDriver,
}: NestedWriteJsonEnvelopeBehaviorOptions) {
  describe(`${driverName} delegated nested update — JSON write envelope`, () => {
    let client: EnvelopeClient | undefined;

    beforeEach(async () => {
      client = createClient({ schema, driver: createDriver() });
      await syncLiveSchema(client);
    });

    afterEach(async () => {
      if (client) {
        await client.$disconnect();
        client = undefined;
      }
    });

    function db(): EnvelopeClient {
      if (!client) throw new Error("client not initialized");
      return client;
    }

    // org "o1" → head "h1" → pet "p1" → collar "c1"; a sibling org "o2" → head
    // "h2" (never touched — the wrong-row witness), and member "m1" under o1.
    async function seed(): Promise<void> {
      const c = db();
      await c.collar.create({
        data: { id: "c1", color: "red", spec: { s: 0 } },
      });
      await c.pet.create({
        data: { id: "p1", tag: "t0", meta: { m: 0 }, collarId: "c1" },
      });
      await c.person.create({
        data: {
          id: "h1",
          note: "n0",
          score: 1,
          payload: { a: 0 },
          petId: "p1",
        },
      });
      await c.person.create({
        data: { id: "h2", note: "n0", score: 1, payload: { a: 0 } },
      });
      await c.org.create({ data: { id: "o1", headId: "h1" } });
      await c.org.create({ data: { id: "o2", headId: "h2" } });
      await c.member.create({
        data: { id: "m1", blob: { b: 0 }, orgId: "o1", petId: "p1" },
      });
      await c.member.create({
        data: { id: "m2", blob: { b: 0 }, orgId: "o1" },
      });
    }

    test("the delegation seam stores the JSON document, not the ORM's envelope", async () => {
      await seed();
      // `head` delegates: its data carries `pet: { update }`, a parent-held to-one.
      await db().org.update({
        where: { id: "o1" },
        data: {
          head: {
            update: {
              payload: { z: 1 },
              note: "n1",
              score: { increment: 2 },
              pet: { update: { tag: "t1" } },
            },
          },
        },
      });
      const head = await db().person.findUniqueOrThrow({ where: { id: "h1" } });
      expect(head.payload).toEqual({ z: 1 });
      // The controls: a plain string and a portable arithmetic on the same SET.
      expect(head.note).toBe("n1");
      expect(head.score).toBe(3);
      expect(
        (await db().pet.findUniqueOrThrow({ where: { id: "p1" } })).tag
      ).toBe("t1");
      // The untouched sibling proves the write was addressed, not broadcast.
      const other = await db().person.findUniqueOrThrow({
        where: { id: "h2" },
      });
      expect(other.payload).toEqual({ a: 0 });
      expect(other.note).toBe("n0");
    });

    test("a JSON document that LOOKS like the update envelope round-trips verbatim", async () => {
      await seed();
      // The adversarial document: the user's own data spells the ORM's envelope.
      const written = { set: { z: 1 }, increment: 4 };
      await db().org.update({
        where: { id: "o1" },
        data: {
          head: {
            update: {
              payload: written,
              pet: { update: { tag: "t1" } },
            },
          },
        },
      });
      expect(
        (await db().person.findUniqueOrThrow({ where: { id: "h1" } })).payload
      ).toEqual(written);
    });

    test("a depth-2 to-one chain writes both JSON columns exactly", async () => {
      await seed();
      // head delegates (pet is parent-held) and pet delegates (collar is too):
      // org → head → pet, with a JSON write at each level.
      await db().org.update({
        where: { id: "o1" },
        data: {
          head: {
            update: {
              payload: { z: 2 },
              pet: {
                update: { meta: { m: 2 }, tag: "t2" },
              },
            },
          },
        },
      });
      expect(
        (await db().person.findUniqueOrThrow({ where: { id: "h1" } })).payload
      ).toEqual({ z: 2 });
      const p = await db().pet.findUniqueOrThrow({ where: { id: "p1" } });
      expect(p.meta).toEqual({ m: 2 });
      expect(p.tag).toBe("t2");
    });

    test("a depth-3 to-one chain writes all three JSON columns exactly", async () => {
      await seed();
      await db().org.update({
        where: { id: "o1" },
        data: {
          head: {
            update: {
              payload: { z: 3 },
              pet: {
                update: {
                  meta: { m: 3 },
                  collar: { update: { spec: { s: 3 }, color: "blue" } },
                },
              },
            },
          },
        },
      });
      expect(
        (await db().person.findUniqueOrThrow({ where: { id: "h1" } })).payload
      ).toEqual({ z: 3 });
      expect(
        (await db().pet.findUniqueOrThrow({ where: { id: "p1" } })).meta
      ).toEqual({ m: 3 });
      const c = await db().collar.findUniqueOrThrow({ where: { id: "c1" } });
      expect(c.spec).toEqual({ s: 3 });
      expect(c.color).toBe("blue");
    });

    test("a delegated TO-MANY update target stores its JSON document exactly", async () => {
      await seed();
      await db().org.update({
        where: { id: "o1" },
        data: {
          members: {
            update: {
              where: { id: "m1" },
              data: { blob: { z: 4 }, pet: { update: { tag: "t4" } } },
            },
          },
        },
      });
      expect(
        (await db().member.findUniqueOrThrow({ where: { id: "m1" } })).blob
      ).toEqual({ z: 4 });
      expect(
        (await db().pet.findUniqueOrThrow({ where: { id: "p1" } })).tag
      ).toBe("t4");
      // The sibling member under the same parent is untouched.
      expect(
        (await db().member.findUniqueOrThrow({ where: { id: "m2" } })).blob
      ).toEqual({ b: 0 });
    });

    test("the documented `data`-column escape stores the document at the delegation seam", async () => {
      await db().collar.create({ data: { id: "c9", color: "red" } });
      await db().pet.create({ data: { id: "p9", tag: "t0", collarId: "c9" } });
      await db().doc.create({
        data: { id: "d1", label: "l0", data: { d: 0 }, petId: "p9" },
      });
      await db().folder.create({ data: { id: "f1", docId: "d1" } });
      // `update: { where: {}, data: { data: … } }` — the escape nested-writes.mdx
      // names for a target owning a field called `data`. The target delegates
      // (its `pet` is a parent-held to-one), so this is the delegated seam.
      await db().folder.update({
        where: { id: "f1" },
        data: {
          doc: {
            update: {
              where: {},
              data: {
                data: { label: "x" },
                pet: { update: { tag: "t9" } },
              },
            },
          },
        },
      });
      const d = await db().doc.findUniqueOrThrow({ where: { id: "d1" } });
      expect(d.data).toEqual({ label: "x" });
      // The OTHER escape spelling still writes the column, not the document.
      await db().folder.update({
        where: { id: "f1" },
        data: {
          doc: {
            update: {
              where: {},
              data: { label: "x", pet: { update: { tag: "t10" } } },
            },
          },
        },
      });
      const after = await db().doc.findUniqueOrThrow({ where: { id: "d1" } });
      expect(after.label).toBe("x");
      expect(after.data).toEqual({ label: "x" });
      expect(
        (await db().pet.findUniqueOrThrow({ where: { id: "p9" } })).tag
      ).toBe("t10");
    });

    test("JsonNull writes the JSON null document through the delegation seam", async () => {
      await seed();
      await db().org.update({
        where: { id: "o1" },
        data: {
          head: {
            update: { payload: JsonNull, pet: { update: { tag: "t5" } } },
          },
        },
      });
      // Read the two nulls apart through the predicates that define them.
      expect(
        await db().person.count({
          where: { id: "h1", payload: { equals: JsonNull } },
        })
      ).toBe(1);
      expect(
        await db().person.count({
          where: { id: "h1", payload: { equals: DbNull } },
        })
      ).toBe(0);
    });

    test("DbNull writes the database NULL through the delegation seam", async () => {
      await seed();
      await db().org.update({
        where: { id: "o1" },
        data: {
          head: {
            update: { payload: DbNull, pet: { update: { tag: "t6" } } },
          },
        },
      });
      expect(
        await db().person.count({
          where: { id: "h1", payload: { equals: DbNull } },
        })
      ).toBe(1);
      expect(
        await db().person.count({
          where: { id: "h1", payload: { equals: JsonNull } },
        })
      ).toBe(0);
    });

    test("a sentinel at depth 2 writes the same two nulls", async () => {
      await seed();
      await db().org.update({
        where: { id: "o1" },
        data: {
          head: {
            update: {
              payload: DbNull,
              pet: { update: { meta: JsonNull } },
            },
          },
        },
      });
      expect(
        await db().person.count({
          where: { id: "h1", payload: { equals: DbNull } },
        })
      ).toBe(1);
      expect(
        await db().pet.count({
          where: { id: "p1", meta: { equals: JsonNull } },
        })
      ).toBe(1);
      expect(
        await db().pet.count({ where: { id: "p1", meta: { equals: DbNull } } })
      ).toBe(0);
    });

    test("the non-delegated depth-1 target is unchanged by all of this", async () => {
      await seed();
      // `head`'s data carries no relation, so nothing delegates: the pre-existing
      // path. Pinned here so the fix is proven not to have moved it.
      await db().org.update({
        where: { id: "o1" },
        data: {
          head: {
            update: { payload: { z: 7 }, note: "n7", score: { multiply: 3 } },
          },
        },
      });
      const head = await db().person.findUniqueOrThrow({ where: { id: "h1" } });
      expect(head.payload).toEqual({ z: 7 });
      expect(head.note).toBe("n7");
      expect(head.score).toBe(3);
    });
  });
}

export const nestedWriteJsonEnvelopeContract = defineContract({
  id: "drivers.nested-write-json-envelope",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution"],
  register: runNestedWriteJsonEnvelopeBehavior,
});
