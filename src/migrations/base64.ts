/** Runtime-neutral canonical Base64 for persisted migration parameters. */
const CANONICAL_SHAPE =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
export function encodeBase64(bytes: Uint8Array): string {
  // Indexed reads preserve the byte view and ignore an overridden iterator;
  // spreading a large array into fromCharCode can overflow the call stack.
  let binary = "";
  // biome-ignore lint/style/useForOf: preserve indexed reads if the caller overrides iteration.
  for (let index = 0; index < bytes.length; index++)
    binary += String.fromCharCode(bytes[index]!);
  return btoa(binary);
}
export function decodeCanonicalBase64(text: string): Uint8Array | undefined {
  if (!CANONICAL_SHAPE.test(text)) return;
  const binary = atob(text);
  const decoded = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++)
    decoded[index] = binary.charCodeAt(index);
  // atob also accepts nonzero padding bits; persisted parameters do not.
  return encodeBase64(decoded) === text ? decoded : undefined;
}
