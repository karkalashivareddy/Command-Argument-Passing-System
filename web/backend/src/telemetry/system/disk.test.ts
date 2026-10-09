import { describe, expect, it } from "vitest";
import { parseDiskstats, parseDiskstatsLine } from "./disk.js";

describe("/proc/diskstats parsing", () => {
  it("maps the named device and kernel counter positions exactly", () => {
    const line = "8 0 sda 11 2 33 44 55 6 77 88 1 99 123";

    expect(parseDiskstatsLine(line)).toEqual({
      major: 8,
      minor: 0,
      name: "sda",
      readsCompleted: 11,
      sectorsRead: 33,
      ioMillis: 99,
      writesCompleted: 55,
      sectorsWritten: 77,
      inFlight: 1,
    });
  });

  it("parses multiple rows and ignores malformed lines", () => {
    const rows = parseDiskstats([
      "8 0 sda 11 2 33 44 55 6 77 88 1 99 123",
      "malformed row",
      "259 0 nvme0n1 1 0 2 3 4 0 5 6 0 7 8",
    ].join("\n"));

    expect(rows.map((row) => row.name)).toEqual(["sda", "nvme0n1"]);
    expect(rows[1]?.sectorsWritten).toBe(5);
  });

  it("rejects incomplete, nonnumeric, and unsafe-integer rows", () => {
    expect(parseDiskstatsLine("8 0 sda 11 2 33 44")).toBeNull();
    expect(parseDiskstatsLine("8 0 sda 11x 2 33 44 55 6 77 88 1 99")).toBeNull();
    expect(parseDiskstatsLine("8 0 sda 9007199254740992 2 33 44 55 6 77 88 1 99")).toBeNull();
  });
});
