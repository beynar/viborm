import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

class ProcessExitError extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

describe("CLI entrypoint", () => {
  it.each([
    new Error("entry failure"),
    42,
    undefined,
  ])("contains parse failures without hiding successful parsing (%s)", async (failure) => {
    vi.resetModules();
    const previousCode = process.exitCode;
    const stderr: string[] = [];
    const parse = vi.spyOn(Command.prototype, "parseAsync");
    if (failure === undefined) parse.mockResolvedValue(new Command());
    else parse.mockRejectedValue(failure);
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        stderr.push(String(chunk));
        return true;
      });
    try {
      process.exitCode = undefined;
      await import("@src/cli/index");
      expect(stderr.join("")).toBe(
        failure instanceof Error
          ? "entry failure\n"
          : failure === undefined
            ? ""
            : "CLI failed\n"
      );
      expect(process.exitCode).toBe(failure === undefined ? undefined : 1);
    } finally {
      parse.mockRestore();
      write.mockRestore();
      process.exitCode = previousCode;
      vi.resetModules();
    }
  });
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
    let exitedCode: number | undefined;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      exitedCode = Number(code ?? 0);
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

    expect(thrown).toBeUndefined();
    expect(exitedCode).toBe(0);
    process.exitCode = undefined;
    const output = stdout.join("");
    expect(output).toContain(
      "VibORM - Type-safe ORM for PostgreSQL, MySQL and SQLite"
    );
    expect(output).toContain("push");
    expect(output).toContain("migrate");
  });
});
