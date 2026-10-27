import { describe, expect, it, vi } from "vitest";

const runStudio = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@src/studio/run", () => ({ runStudio }));

const { studioCommand } = await import("@src/cli/commands/studio");
const { DEFAULT_STUDIO_PORT } = await import("@src/studio/port");
const { default: html } = await import("viborm:studio-ui");

const parse = (args: string[]) =>
  studioCommand.parseAsync(args, { from: "user" });

describe("viborm studio", () => {
  // One Command instance keeps its parsed values: the defaults are read first.
  it("hands the runner the app, the config and the port", async () => {
    runStudio.mockClear();
    await parse([]);
    expect(runStudio).toHaveBeenCalledWith(
      expect.objectContaining({ port: undefined, open: true })
    );
    runStudio.mockClear();
    await parse(["--config", "db.config.ts", "--port", "0", "--no-open"]);
    expect(runStudio).toHaveBeenCalledWith({
      config: "db.config.ts",
      html,
      port: 0,
      defaultPort: DEFAULT_STUDIO_PORT,
      open: false,
    });
  });

  it.each([
    "-1",
    "65536",
    "1.5",
    "port",
  ])("refuses the port %s", async (port) => {
    studioCommand.exitOverride();
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      await expect(parse(["--port", port])).rejects.toMatchObject({
        code: "commander.invalidArgument",
      });
    } finally {
      write.mockRestore();
    }
  });
});
