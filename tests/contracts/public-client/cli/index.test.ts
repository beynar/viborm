import { describe, expect, it, vi } from "vitest";

class ProcessExitError extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

describe("CLI entrypoint", () => {
  it("registers the shipped commands in --help", async () => {
    const originalArgv = process.argv;
    const stdout: string[] = [];
    process.argv = ["node", "viborm", "--help"];
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk) => {
        stdout.push(String(chunk));
        return true;
      });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new ProcessExitError(Number(code ?? 0));
    });

    let thrown: unknown;
    try {
      await import("@src/cli/index");
    } catch (error) {
      thrown = error;
    } finally {
      stdoutSpy.mockRestore();
      exitSpy.mockRestore();
      process.argv = originalArgv;
    }

    expect(thrown).toBeInstanceOf(ProcessExitError);
    if (!(thrown instanceof ProcessExitError)) {
      throw new Error("expected the CLI help path to exit cleanly");
    }
    expect(thrown.code).toBe(0);
    const output = stdout.join("");
    expect(output).toContain(
      "VibORM - Type-safe ORM for PostgreSQL, MySQL and SQLite"
    );
    expect(output).toContain("push");
    expect(output).toContain("migrate");
  });
});
