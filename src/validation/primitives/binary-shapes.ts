/**
 * The ONE normalization of every shape a driver spells binary bytes in.
 *
 * Nine drivers return the same column nine ways — a Node `Buffer`, a
 * `Uint8Array`, an `ArrayBuffer`, a plain array of byte numbers, PostgreSQL's
 * `\x…` hex inside a JSON carrier, MySQL's `base64:typeNNN:…` inside one, and
 * the lowercase hex our own `blobToHex` cast emits — and every one of them
 * names the same bytes. Deciding which is which is a pure question about a
 * VALUE, not about a dialect or an operation, so it lives here as a leaf where
 * both readers of physical binary can share one answer: the blob scalar's
 * result parser and the identifier storage codec.
 *
 * It REPORTS rather than throws. The two callers are at different boundaries
 * and owe different messages — a blob column names the driver and the
 * operation, an identifier names the field and its declared format — so the
 * refusal's wording belongs to them and only the classification belongs here.
 */

const HEX_BYTES = /^(?:[0-9a-fA-F]{2})*$/;
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64_PROVIDER = /^base64:type\d+:(.*)$/;

/**
 * The bytes a driver value names, or the REPRESENTATION that could not be read.
 *
 * `unsupported` is the phrase a message says after "an unsupported": the shape
 * that was recognized but malformed (`"hex string"`, `"base64 string"`,
 * `"byte array"`), or the `typeof` of a value that is no binary shape at all.
 */
export type BinaryShape =
  | { readonly bytes: Uint8Array; readonly unsupported?: undefined }
  | { readonly bytes?: undefined; readonly unsupported: string };

function hexBytes(hex: string): BinaryShape {
  if (!HEX_BYTES.test(hex)) return { unsupported: "hex string" };
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index++) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return { bytes: out };
}

function base64Bytes(base64: string): BinaryShape {
  if (!BASE64.test(base64)) return { unsupported: "base64 string" };
  // The pattern admitted canonical, padded base64 only, so `atob` decodes it
  // and cannot throw.
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < out.length; index++) {
    out[index] = binary.charCodeAt(index);
  }
  return { bytes: out };
}

/** Normalize any driver binary representation to plain bytes, or say why not. */
export function normalizeBinaryValue(value: unknown): BinaryShape {
  if (value instanceof ArrayBuffer) {
    return { bytes: new Uint8Array(value.slice(0)) };
  }
  if (ArrayBuffer.isView(value)) {
    const view = new Uint8Array(
      value.buffer,
      value.byteOffset,
      value.byteLength
    );
    return { bytes: new Uint8Array(view) };
  }
  if (Array.isArray(value)) {
    for (const byte of value) {
      if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
        return { unsupported: "byte array" };
      }
    }
    return { bytes: Uint8Array.from(value) };
  }
  if (typeof value === "string") {
    if (value.startsWith("\\x")) return hexBytes(value.slice(2));
    if (value.startsWith("base64:type")) {
      const match = BASE64_PROVIDER.exec(value);
      if (!match) return { unsupported: "base64 string" };
      const payloadStart = value.indexOf(":", "base64:type".length) + 1;
      return base64Bytes(value.slice(payloadStart));
    }
    return hexBytes(value);
  }
  return { unsupported: typeof value };
}
