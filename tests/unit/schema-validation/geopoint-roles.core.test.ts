import { s } from "@schema";
import { validateSchema } from "@src/schema/validation";
import { describe, expect, test } from "vitest";

const codes = (model: ReturnType<typeof s.model>): string[] =>
  validateSchema({ place: model }).errors.map((issue) => issue.code);

describe("GeoPoint schema roles", () => {
  test("admits exactly one non-null point in a non-unique total spatial index", () => {
    const place = s
      .model({ id: s.string().id(), location: s.point() })
      .index(["location"], { type: "spatial", name: "place_location" });

    expect(codes(place)).not.toContain("I005");
  });

  test.each([
    [["location"]],
    [[], { type: "spatial" }],
    [["location", "name"], { type: "spatial" }],
    [["location"], { type: "spatial", unique: true }],
    [["location"], { type: "spatial", unique: false }],
    [["location"], { type: "spatial", where: "active" }],
    [["name"], { type: "spatial" }],
  ])("refuses an invalid index shape %#", (...args) => {
    const model = s.model({
      id: s.string().id(),
      name: s.string(),
      location: s.point(),
    });
    const declared = Reflect.apply(model.index, model, args);
    expect(codes(declared)).toContain("I005");
  });

  test("refuses a nullable spatial-index member", () => {
    const model = s.model({
      id: s.string().id(),
      location: s.point().nullable(),
    });
    const declared = Reflect.apply(model.index, model, [
      ["location"],
      { type: "spatial" },
    ]);
    expect(codes(declared)).toContain("I005");
  });

  test("refuses point members in compound identity", () => {
    const model = s.model({ name: s.string(), location: s.point() });
    const compoundId = Reflect.apply(model.id, model, [["name", "location"]]);
    const compoundUnique = Reflect.apply(model.unique, model, [
      ["name", "location"],
    ]);
    expect(codes(compoundId)).toContain("I005");
    expect(codes(compoundUnique)).toContain("I005");
  });

  test("refuses a borrowed ID or unique modifier on a point", () => {
    const point = s.point();
    const pointId = Reflect.apply(s.int().id, point, []);
    const pointUnique = Reflect.apply(s.int().unique, point, []);

    expect(codes(s.model({ location: pointId }))).toContain("I005");
    expect(codes(s.model({ location: pointUnique }))).toContain("I005");
  });

  test("refuses a GeoPoint used as the local member of a stored relation", () => {
    const owner = s.model({
      id: s.string().id(),
      places: s.toMany(() => place),
    });
    const place = s.model({
      id: s.string().id(),
      location: s.point(),
      owner: s
        .toOne(() => owner)
        .fields("location")
        .references("id"),
    });

    expect(
      validateSchema({ owner, place }).errors.map((issue) => issue.code)
    ).toContain("FK011");
  });
});
