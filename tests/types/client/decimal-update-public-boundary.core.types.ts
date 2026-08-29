/** Public decimal-update type probes. Nothing in this file is called. */

import { PGliteDriver } from "@drivers/pglite";
import { s } from "@schema";
import { createClient, Decimal } from "@src/index";
import { describe, expectTypeOf, test } from "vitest";

const invoice = s.model({
  id: s.string().id(),
  amount: s.decimal({ precision: 10, scale: 2 }),
  adjustments: s.decimal({ precision: 10, scale: 2 }).array(),
  optionalAmount: s.decimal({ precision: 10, scale: 2 }).nullable(),
  optionalAdjustments: s
    .decimal({ precision: 10, scale: 2 })
    .array()
    .nullable(),
  sequence: s.int(),
});

const client = createClient({
  schema: { invoice },
  driver: new PGliteDriver(),
});
const decimalValue = new Decimal("1");

describe("public decimal update payload", () => {
  const twoRecognizedHeld = { set: "1", increment: "2" };
  const unknownBesideRealHeld = { increment: "1", incremnt: "2" };
  const listUnknownBesideRealHeld = { push: ["1"], puh: ["2"] };
  const nonDecimalUnknownBesideRealHeld = { increment: 1, incremnt: 2 };

  const _twoRecognizedFresh = () =>
    client.invoice.update({
      where: { id: "i" },
      // @ts-expect-error - a decimal update names exactly one operation
      data: { amount: { set: "1", increment: "2" } },
    });

  const _twoRecognizedHeld = () =>
    client.invoice.update({
      where: { id: "i" },
      // @ts-expect-error - structural exact-one arms also refuse a held payload
      data: { amount: twoRecognizedHeld },
    });

  const _unknownBesideRealFresh = () =>
    client.invoice.update({
      where: { id: "i" },
      // @ts-expect-error - the direct decimal leaf refuses unknown keys
      data: { amount: { increment: "1", incremnt: "2" } },
    });

  const _unknownBesideRealHeld = () =>
    client.invoice.update({
      where: { id: "i" },
      // @ts-expect-error - the same structural refusal applies to held payloads
      data: { amount: unknownBesideRealHeld },
    });

  const _listUnknownBesideRealFresh = () =>
    client.invoice.update({
      where: { id: "i" },
      // @ts-expect-error - decimal-list updates have the same sealed leaf
      data: { adjustments: { push: ["1"], puh: ["2"] } },
    });

  const _listUnknownBesideRealHeld = () =>
    client.invoice.update({
      where: { id: "i" },
      // @ts-expect-error - held decimal-list updates remain sealed
      data: { adjustments: listUnknownBesideRealHeld },
    });

  const _updateManyUnknownBesideReal = () =>
    client.invoice.updateMany({
      // @ts-expect-error - updateMany uses the same direct decimal leaf
      data: { amount: unknownBesideRealHeld },
    });

  const _upsertUnknownBesideReal = () =>
    client.invoice.upsert({
      where: { id: "i" },
      create: {
        id: "i",
        amount: "1",
        adjustments: [],
        sequence: 1,
      },
      // @ts-expect-error - upsert.update uses the same direct decimal leaf
      update: { amount: unknownBesideRealHeld },
    });

  const _nullableScalarUnionCannotHideUnknown = (
    payload: typeof unknownBesideRealHeld | null
  ) =>
    client.invoice.update({
      where: { id: "i" },
      // @ts-expect-error - the legal null arm cannot erase the bad object arm
      data: { optionalAmount: payload },
    });

  const _nullableListUnionCannotHideUnknown = (
    payload: typeof listUnknownBesideRealHeld | null
  ) =>
    client.invoice.update({
      where: { id: "i" },
      // @ts-expect-error - the legal null arm cannot erase the bad object arm
      data: { optionalAdjustments: payload },
    });

  const _dataUnionCannotHideUnknown = (
    data:
      | { amount: typeof unknownBesideRealHeld }
      | { sequence: { increment: number } }
  ) =>
    client.invoice.update({
      where: { id: "i" },
      // @ts-expect-error - a branch without decimals cannot erase the bad one
      data,
    });

  const _legalConditionalDecimalUpdate = (
    payload: Decimal | { multiply: string }
  ) =>
    client.invoice.update({
      where: { id: "i" },
      data: { amount: payload },
    });

  const _legalDecimalSpellings = () => {
    client.invoice.update({
      where: { id: "i" },
      data: { amount: decimalValue, adjustments: [decimalValue, "2"] },
    });
    client.invoice.update({
      where: { id: "i" },
      data: {
        amount: { multiply: "2" },
        adjustments: { push: ["3"] },
      },
    });
  };

  // The new guard is decimal-specific. It does not reopen the measured
  // recursive write-clause expansion for another scalar family.
  const _nonDecimalUnknownBesideRealStillCompiles = () =>
    client.invoice.update({
      where: { id: "i" },
      data: { sequence: nonDecimalUnknownBesideRealHeld },
    });

  test("the probes enter through the public client", () => {
    expectTypeOf(_twoRecognizedFresh).toBeFunction();
    expectTypeOf(_twoRecognizedHeld).toBeFunction();
    expectTypeOf(_unknownBesideRealFresh).toBeFunction();
    expectTypeOf(_unknownBesideRealHeld).toBeFunction();
    expectTypeOf(_listUnknownBesideRealFresh).toBeFunction();
    expectTypeOf(_listUnknownBesideRealHeld).toBeFunction();
    expectTypeOf(_updateManyUnknownBesideReal).toBeFunction();
    expectTypeOf(_upsertUnknownBesideReal).toBeFunction();
    expectTypeOf(_nullableScalarUnionCannotHideUnknown).toBeFunction();
    expectTypeOf(_nullableListUnionCannotHideUnknown).toBeFunction();
    expectTypeOf(_dataUnionCannotHideUnknown).toBeFunction();
    expectTypeOf(_legalConditionalDecimalUpdate).toBeFunction();
    expectTypeOf(_legalDecimalSpellings).toBeFunction();
    expectTypeOf(_nonDecimalUnknownBesideRealStillCompiles).toBeFunction();
  });
});
