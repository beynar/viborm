import { createMigrateCommand } from "@src/cli/commands/migrate";
import { describe, expect, test } from "vitest";

function refuseProcessExit(command: ReturnType<typeof createMigrateCommand>) {
  command.exitOverride();
  for (const child of command.commands) child.exitOverride();
}

describe("migration v1 CLI input", () => {
  test.each([
    "nope",
    "0",
    "-1",
    "1.5",
    "Infinity",
  ])("refuses --steps %s before loading configuration", async (steps) => {
    const command = createMigrateCommand();
    refuseProcessExit(command);
    await expect(
      command.parseAsync(["node", "viborm", "down", "--steps", steps])
    ).rejects.toMatchObject({ code: "commander.invalidArgument" });
  });
});
