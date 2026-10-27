import { afterEach, describe, expect, test, vi } from "vitest";

const runStudio = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../src/run", () => ({ DEFAULT_STUDIO_PORT: 5577, runStudio }));

const { main } = await import("../src/cli");
const app = () => "<!doctype html>";

afterEach(() => {
  runStudio.mockClear();
  vi.restoreAllMocks();
});

describe("viborm-studio's arguments", () => {
  test("by default it searches, opens the browser and watches", async () => {
    expect(await main([], app)).toBe(0);
    expect(runStudio).toHaveBeenCalledWith({
      cwd: process.cwd(),
      config: undefined,
      html: "<!doctype html>",
      port: undefined,
      open: true,
      watch: true,
      readonly: false,
    });
  });

  test("takes a config, a port, and turns opening and watching off", async () => {
    await main(
      ["-c", "db.config.ts", "--port", "0", "--no-open", "--no-watch", "--readonly"],
      app
    );
    expect(runStudio).toHaveBeenCalledWith(
      expect.objectContaining({
        config: "db.config.ts",
        port: 0,
        open: false,
        watch: false,
        readonly: true,
      })
    );
  });

  test.each([
    "-1",
    "65536",
    "1.5",
    "port",
  ])("refuses the port %s", async (port) => {
    await expect(main([`--port=${port}`], app)).rejects.toThrow(
      `--port must be a port between 0 and 65535, not "${port}"`
    );
    expect(runStudio).not.toHaveBeenCalled();
  });

  test("--help prints the usage and runs nothing", async () => {
    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    expect(await main(["--help"], app)).toBe(0);
    expect(written.join("")).toContain("Usage: viborm-studio [options]");
    expect(runStudio).not.toHaveBeenCalled();
  });

  test("an unknown option is refused", async () => {
    await expect(main(["--nope"], app)).rejects.toThrow("nope");
  });

  test("reads the app the package build put beside it", async () => {
    await expect(main([])).rejects.toMatchObject({ code: "ENOENT" });
  });
});
