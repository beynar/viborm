import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { REPOSITORY_ROOT } from "@tests/fixtures/repo-paths";
import ts from "typescript";
import { describe, expect, test } from "vitest";

type Finding =
  | "cartesian point value"
  | "configurable SRID"
  | "duplicate GeoArea validator"
  | "duplicate GeoPoint distance owner"
  | "duplicate GeoPoint validator"
  | "generic geospatial protocol"
  | "lat/lng point alias"
  | "ORM point array"
  | "point native override"
  | "retired PG.POINT";

const POINT_DISTANCE_OWNERS = new Set([
  "src/client/result-types.ts",
  "src/query-engine/builders/distance-builder.ts",
  "src/validation/model/core/orderby.ts",
  "src/validation/model/core/select.ts",
  "src/validation/scalars/point.ts",
]);
const POINT_RELATED_FILE = /(?:^|\/)(?:geo-)?point(?:\.|-|\/)/i;
const PUBLIC_DECLARATION_AREA = /^src\/(?:client|schema|validation)\//;
const POINT_NAME = /point/i;
const GENERIC_GEOSPATIAL_NAME = /^(?:supportsGeospatial|geospatial)$/i;
const NATIVE_OVERRIDE_NAME = /^(?:native|nativeType)$/;
const POINT_DISTANCE_NAME = /pointdistance/i;

function shippedTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...shippedTypeScriptFiles(path));
    else if (entry.isFile() && path.endsWith(".ts")) files.push(path);
  }
  return files;
}

const SHIPPED_SOURCE = shippedTypeScriptFiles(join(REPOSITORY_ROOT, "src"));

function nodeName(node: ts.Node & { name?: ts.Node }): string | undefined {
  const name = node.name;
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

function memberNames(members: ts.NodeArray<ts.TypeElement>): Set<string> {
  const names = new Set<string>();
  for (const member of members) {
    const name = nodeName(member);
    if (name) names.add(name);
  }
  return names;
}

function objectNames(node: ts.ObjectLiteralExpression): Set<string> {
  const names = new Set<string>();
  for (const property of node.properties) {
    const name = nodeName(property);
    if (name) names.add(name);
  }
  return names;
}

function isPointFactoryCall(node: ts.Node): boolean {
  return (
    ts.isCallExpression(node) &&
    ((ts.isIdentifier(node.expression) && node.expression.text === "point") ||
      (ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "point"))
  );
}

function declarationsNamed(source: ts.SourceFile, name: string): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) &&
      nodeName(node) === name
    ) {
      count += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return count;
}

function findings(file: string, sourceText: string): Finding[] {
  const found = new Set<Finding>();
  const source = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const pointRelated = POINT_RELATED_FILE.test(file);
  const publicDeclarationArea = PUBLIC_DECLARATION_AREA.test(file);

  const inspectPointMembers = (names: ReadonlySet<string>): void => {
    if (names.has("x") && names.has("y")) {
      found.add("cartesian point value");
    }
    if (names.has("lat") || names.has("lng")) {
      found.add("lat/lng point alias");
    }
  };

  const visit = (node: ts.Node): void => {
    const name = nodeName(node);
    if (
      (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
      POINT_NAME.test(node.name.text)
    ) {
      if (ts.isInterfaceDeclaration(node)) {
        inspectPointMembers(memberNames(node.members));
      } else if (ts.isTypeLiteralNode(node.type)) {
        inspectPointMembers(memberNames(node.type.members));
      }
    }
    if (pointRelated && ts.isObjectLiteralExpression(node)) {
      inspectPointMembers(objectNames(node));
    }
    if (
      (ts.isIdentifier(node) && GENERIC_GEOSPATIAL_NAME.test(node.text)) ||
      (name !== undefined && GENERIC_GEOSPATIAL_NAME.test(name))
    ) {
      found.add("generic geospatial protocol");
    }
    if (name === "POINT") found.add("retired PG.POINT");

    if (publicDeclarationArea && name?.toLowerCase() === "srid") {
      found.add("configurable SRID");
    }
    if (ts.isCallExpression(node) && isPointFactoryCall(node)) {
      for (const argument of node.arguments) {
        if (
          ts.isObjectLiteralExpression(argument) &&
          objectNames(argument).has("srid")
        ) {
          found.add("configurable SRID");
        }
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "array" &&
      isPointFactoryCall(node.expression.expression)
    ) {
      found.add("ORM point array");
    }
    if (
      file.endsWith("/schema/scalars/point/scalar.ts") &&
      (name === "array" ||
        name === "native" ||
        (name === "nativeType" &&
          !(
            ts.isPropertySignature(node) &&
            node.type?.kind === ts.SyntaxKind.UndefinedKeyword
          )))
    ) {
      found.add(name === "array" ? "ORM point array" : "point native override");
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      NATIVE_OVERRIDE_NAME.test(node.expression.name.text) &&
      isPointFactoryCall(node.expression.expression)
    ) {
      found.add("point native override");
    }

    if (
      name === "validateGeoPoint" &&
      (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) &&
      file !== "src/validation/primitives/geo-point-codec.ts"
    ) {
      found.add("duplicate GeoPoint validator");
    }
    if (
      name === "validateGeoArea" &&
      (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) &&
      file !== "src/validation/primitives/geo-area-codec.ts"
    ) {
      found.add("duplicate GeoArea validator");
    }
    if (
      name !== undefined &&
      POINT_DISTANCE_NAME.test(name) &&
      (ts.isFunctionDeclaration(node) ||
        ts.isVariableDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isInterfaceDeclaration(node)) &&
      !POINT_DISTANCE_OWNERS.has(file)
    ) {
      found.add("duplicate GeoPoint distance owner");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...found].sort();
}

describe("GeoPoint shipped-language census", () => {
  test("every detector is falsified by its retired executable shape", () => {
    expect(
      findings("src/point.ts", "type Point = { x: number; y: number }")
    ).toContain("cartesian point value");
    expect(
      findings("src/point.ts", "type Point = { lat: number; lng: number }")
    ).toContain("lat/lng point alias");
    expect(findings("src/schema/point.ts", "point({ srid: 3857 })")).toContain(
      "configurable SRID"
    );
    expect(findings("src/model.ts", "s.point().array() ")).toContain(
      "ORM point array"
    );
    expect(
      findings(
        "src/schema/scalars/point/scalar.ts",
        "class PointScalar { nativeType() {} }"
      )
    ).toContain("point native override");
    expect(
      findings("src/schema/native.ts", "const PG = { POINT: {} }")
    ).toContain("retired PG.POINT");
    expect(
      findings("src/adapter.ts", "const supportsGeospatial = true")
    ).toContain("generic geospatial protocol");
    expect(
      findings("src/other.ts", "function validateGeoPoint() {}")
    ).toContain("duplicate GeoPoint validator");
    expect(findings("src/other.ts", "function validateGeoArea() {}")).toContain(
      "duplicate GeoArea validator"
    );
    expect(
      findings("src/other.ts", "function buildPointDistance() {}")
    ).toContain("duplicate GeoPoint distance owner");
  });

  test("valid internal and unrelated shapes stay outside blanket bans", () => {
    expect(
      findings("src/validation/point.ts", "v.point({ array: true })")
    ).toEqual([]);
    expect(findings("src/cursor.ts", "const cursor = { x: 1, y: 2 }")).toEqual(
      []
    );
    expect(findings("src/migrations/catalog.ts", "const srid = 4326")).toEqual(
      []
    );
    expect(
      findings("src/adapter.ts", "const fixed = 'POINT SRID 4326'")
    ).toEqual([]);
  });

  test("the complete shipped executable source has zero retired owners", () => {
    const violations: string[] = [];
    const totals = new Map<Finding, number>();
    for (const absoluteFile of SHIPPED_SOURCE) {
      const file = relative(REPOSITORY_ROOT, absoluteFile);
      for (const finding of findings(
        file,
        readFileSync(absoluteFile, "utf8")
      )) {
        totals.set(finding, (totals.get(finding) ?? 0) + 1);
        violations.push(`${file}: ${finding}`);
      }
    }
    expect(violations).toEqual([]);
    expect([...totals.values()].reduce((sum, count) => sum + count, 0)).toBe(0);
  });

  test("the codecs and fixed radius each have one declaration owner", () => {
    const definitions = new Map<string, string[]>();
    for (const absoluteFile of SHIPPED_SOURCE) {
      const file = relative(REPOSITORY_ROOT, absoluteFile);
      const source = ts.createSourceFile(
        file,
        readFileSync(absoluteFile, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
      );
      for (const name of [
        "validateGeoPoint",
        "validateGeoArea",
        "GEO_POINT_EARTH_RADIUS_METERS",
      ]) {
        if (declarationsNamed(source, name) > 0) {
          definitions.set(name, [...(definitions.get(name) ?? []), file]);
        }
      }
    }
    expect(definitions).toEqual(
      new Map([
        ["validateGeoPoint", ["src/validation/primitives/geo-point-codec.ts"]],
        ["validateGeoArea", ["src/validation/primitives/geo-area-codec.ts"]],
        [
          "GEO_POINT_EARTH_RADIUS_METERS",
          ["src/validation/primitives/geo-area-codec.ts"],
        ],
      ])
    );
  });
});
