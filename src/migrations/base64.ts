/** Runtime-neutral canonical Base64 for persisted migration parameters. */

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const CANONICAL_SHAPE =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function encodeBase64(bytes: Uint8Array): string {
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const hasSecond = index + 1 < bytes.length;
    const hasThird = index + 2 < bytes.length;
    const second = hasSecond ? bytes[index + 1]! : 0;
    const third = hasThird ? bytes[index + 2]! : 0;
    encoded += ALPHABET[Math.floor(first / 4)];
    encoded += ALPHABET[(first % 4) * 16 + Math.floor(second / 16)];
    encoded += hasSecond
      ? ALPHABET[(second % 16) * 4 + Math.floor(third / 64)]
      : "=";
    encoded += hasThird ? ALPHABET[third % 64] : "=";
  }
  return encoded;
}

export function decodeCanonicalBase64(text: string): Uint8Array | undefined {
  if (!CANONICAL_SHAPE.test(text)) return;
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const decoded = new Uint8Array((text.length / 4) * 3 - padding);
  let offset = 0;
  for (let index = 0; index < text.length; index += 4) {
    const first = ALPHABET.indexOf(text.charAt(index));
    const second = ALPHABET.indexOf(text.charAt(index + 1));
    const thirdCharacter = text.charAt(index + 2);
    const fourthCharacter = text.charAt(index + 3);
    const third = thirdCharacter === "=" ? 0 : ALPHABET.indexOf(thirdCharacter);
    const fourth =
      fourthCharacter === "=" ? 0 : ALPHABET.indexOf(fourthCharacter);
    decoded[offset] = first * 4 + Math.floor(second / 16);
    offset += 1;
    if (thirdCharacter !== "=") {
      decoded[offset] = (second % 16) * 16 + Math.floor(third / 4);
      offset += 1;
    }
    if (fourthCharacter !== "=") {
      decoded[offset] = (third % 4) * 64 + fourth;
      offset += 1;
    }
  }
  return encodeBase64(decoded) === text ? decoded : undefined;
}
