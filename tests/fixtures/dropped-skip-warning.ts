import { afterAll, beforeAll, type MockInstance, vi } from "vitest";

/** Capture legacy warning spelling only to prove unsupported shapes no longer warn. */
export function captureDroppedSkipWarnings(): (model: string) => string[] {
  let warn: MockInstance<typeof console.warn> | undefined;
  beforeAll(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterAll(() => {
    warn?.mockRestore();
  });
  return (model) =>
    (warn?.mock.calls ?? [])
      .map(([message]) => message)
      .filter(
        (message): message is string =>
          typeof message === "string" &&
          message.startsWith("[viborm] createMany skipDuplicates") &&
          message.includes(` in ${model}.`)
      );
}
