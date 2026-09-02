import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { D1Driver } from "@drivers/d1";
import { parseResult } from "@query-engine/result/ResultParser";
import { s } from "@schema";
import { parserFor, prepareSchema } from "@tests/fixtures/query-scope";
import { afterEach, describe, expect, test, vi } from "vitest";

const models = {
  binary: s.model({
    id: s.string().id(),
    payload: s.blob(),
  }),
};

prepareSchema(models);

const UNSUPPORTED_D1_BLOB_REGEX =
  /Driver "d1" returned an unsupported .* blob representation/i;

function parseBlob(raw: unknown): Uint8Array {
  const driver = new D1Driver({ database: Object.create(null) });
  const ctx = parserFor(new SQLiteAdapter(), models.binary, driver);
  const [row] = parseResult<Array<{ id: string; payload: Uint8Array }>>(
    ctx,
    "findMany",
    [{ id: "binary-1", payload: raw }],
    { select: { id: true, payload: true } }
  );
  if (!row) {
    throw new Error("Blob parser fixture returned no row.");
  }
  return row.payload;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("portable blob result parsing", () => {
  test.each([
    ["empty ArrayBuffer", new ArrayBuffer(0), []],
    ["Uint8Array", new Uint8Array([0, 1, 128, 255]), [0, 1, 128, 255]],
    ["ArrayBuffer", new Uint8Array([0, 1, 128, 255]).buffer, [0, 1, 128, 255]],
    [
      "offset DataView",
      new DataView(new Uint8Array([91, 0, 255, 128, 92]).buffer, 1, 3),
      [0, 255, 128],
    ],
    ["D1 byte array", [0, 255, 128], [0, 255, 128]],
    ["empty D1 byte array", [], []],
    ["PostgreSQL hex", "\\x00ff80", [0, 255, 128]],
    ["adapter hex", "00ff80", [0, 255, 128]],
    ["empty adapter hex", "", []],
    ["MySQL base64", "base64:type15:AP+A", [0, 255, 128]],
    ["MySQL base64 with one padding byte", "base64:type15:AAA=", [0, 0]],
    ["MySQL base64 with two padding bytes", "base64:type15:AA==", [0]],
    ["empty MySQL base64", "base64:type15:", []],
  ])("decodes %s without Buffer", (_label, raw, expected) => {
    vi.stubGlobal("Buffer", undefined);

    const parsed = parseBlob(raw);

    expect(parsed.constructor).toBe(Uint8Array);
    expect(Array.from(parsed)).toEqual(expected);
  });

  test.each([
    ["negative byte", [0, -1]],
    ["oversized byte", [256]],
    ["fractional byte", [1.5]],
    ["NaN byte", [Number.NaN]],
    ["string byte", ["1"]],
    ["odd hex", "0"],
    ["non-hex", "0g"],
    ["odd PostgreSQL hex", "\\x0"],
    ["malformed base64", "base64:type15:@@=="],
    ["malformed base64 padding", "base64:type15:A==="],
    ["malformed provider prefix", "base64:typex:AA=="],
    ["object", { data: [1, 2, 3] }],
    ["number", 7],
  ])("rejects %s with provider context", (_label, raw) => {
    expect(() => parseBlob(raw)).toThrow(UNSUPPORTED_D1_BLOB_REGEX);
  });
});
