import { afterEach, expect, test, vi } from "vitest";

const main = vi.hoisted(() => vi.fn());
vi.mock("../src/cli", () => ({ main }));

const exitCode = process.exitCode;
afterEach(() => {
  process.exitCode = exitCode;
  vi.resetModules();
  vi.restoreAllMocks();
});

test("the executable runs main with the process's arguments", async () => {
  main.mockResolvedValue(0);
  await import("../src/bin");
  await vi.waitFor(() => expect(process.exitCode).toBe(0));
  expect(main).toHaveBeenCalledWith(process.argv.slice(2));
});

test.each([
  [new Error("No VibORM config found"), "No VibORM config found\n"],
  ["text", "text\n"],
])("a failure is written to stderr with exit code 1 (%s)", async (failure, message) => {
  const written: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  main.mockRejectedValue(failure);
  await import("../src/bin");
  await vi.waitFor(() => expect(process.exitCode).toBe(1));
  expect(written.join("")).toBe(message);
});
