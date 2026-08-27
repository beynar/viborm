/**
 * What the relation package publishes.
 *
 * The four terminal implementations are private factory machinery: a caller
 * sees only the capabilities `s.toOne` and `s.toMany` return, so no terminal
 * class name, constructor, or retired factory may appear in either surface.
 * Both lists are frozen literals rather than filters, because "no NEW terminal
 * name" is only checkable against an exhaustive one.
 *
 * Plan §3.3, §4.1, falsifier §11.1.11.
 */

import * as relationModule from "@schema/relation";
import { s } from "@src/schema";
import { describe, expect, it } from "vitest";

const RELATION_PACKAGE_EXPORTS = [
  "clearableMembership",
  "generateJunctionFieldName",
  "generateJunctionTableName",
  // The TARGET-DOMAIN predicate: one declared property read, published because
  // both halves of a target-kind partition must ask it the same way.
  "isVariantRelationState",
  "membershipCanBeCleared",
  "slotMayBeEmpty",
  "toMany",
  "toOne",
] as const;

const SCHEMA_BUILDER_KEYS = [
  "bigInt",
  "blob",
  "boolean",
  "date",
  "dateTime",
  "decimal",
  "enum",
  "int",
  "json",
  "model",
  "number",
  "point",
  "string",
  "time",
  "toMany",
  "toOne",
  "vector",
] as const;

/**
 * Every name the unified relation language retired, in one place.
 *
 * The inverse SCANNERS are here too: pairing is a full-schema fact now, so a
 * relation-package export that answers "who is my inverse" would be a second
 * topology authority beside the resolver's index.
 */
const RETIRED_NAMES = [
  "canBindPolymorphicInverse",
  "collectInverseCandidates",
  "getCompatiblePolymorphicInverseBinding",
  "getJunctionFieldNames",
  "getJunctionTableName",
  "getPolymorphicInverseBinding",
  "resolveInverseRelation",
  "resolveOrdinaryInverse",
  "ManyToManyRelation",
  "ModelToMany",
  "ModelToOne",
  "PolymorphicToManyRelation",
  "PolymorphicToOneRelation",
  "ReferencesStage",
  "ToManyRelation",
  "ToOneRelation",
  "VariantToMany",
  "VariantToOne",
  "manyToMany",
  "manyToOne",
  "oneToMany",
  "oneToOne",
  "polymorphicToMany",
  "polymorphicToOne",
] as const;

describe("relation package exports", () => {
  it("publishes exactly the frozen export set", () => {
    expect(Object.keys(relationModule).sort()).toEqual([
      ...RELATION_PACKAGE_EXPORTS,
    ]);
  });

  it("names no terminal implementation and no retired factory", () => {
    const exported = new Set(Object.keys(relationModule));
    for (const retired of RETIRED_NAMES) {
      expect(exported.has(retired)).toBe(false);
    }
  });
});

describe("the schema builder surface", () => {
  it("offers exactly two relation factories", () => {
    expect(Object.keys(s).sort()).toEqual([...SCHEMA_BUILDER_KEYS]);
    expect(typeof s.toOne).toBe("function");
    expect(typeof s.toMany).toBe("function");
  });

  it("names no retired factory", () => {
    const builderKeys = new Set(Object.keys(s));
    for (const retired of RETIRED_NAMES) {
      expect(builderKeys.has(retired)).toBe(false);
    }
  });
});
