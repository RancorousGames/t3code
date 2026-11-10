import { describe, expect, it } from "vite-plus/test";
import { scheduleCaffyBegin } from "./chatGPTCaffyPauseResume";

describe("Caffy pause and delayed resume", () => {
  it("stops a working guest before arming the future wake", async () => {
    const events: string[] = [];
    const interrupted = await scheduleCaffyBegin(
      123456, true,
      async () => { events.push("clicked-stop"); },
      async (at) => { events.push(`schedule:${at}`); },
    );
    expect(interrupted).toBe(true);
    expect(events).toEqual(["clicked-stop", "schedule:123456"]);
  });

  it("holds any existing Caffy wake while stopping generation", async () => {
    const events: string[] = [];
    await scheduleCaffyBegin(
      123456, true,
      async () => { events.push("stop"); },
      async () => { events.push("save-future-deadline"); },
      {
        suspendWake: async () => { events.push("pause-caffy"); },
        resumeWake: async () => { events.push("resume-caffy"); },
      },
    );
    expect(events).toEqual(["pause-caffy", "stop", "save-future-deadline"]);
  });

  it("does not depend on a second IPC resume after saving the delayed wake", async () => {
    const events: string[] = [];
    await scheduleCaffyBegin(
      123456, true,
      async () => { events.push("stop"); },
      async () => { events.push("save-and-activate"); },
      {
        suspendWake: async () => { events.push("pause"); },
        resumeWake: async () => {
          events.push("legacy-resume");
          throw new Error("IPC disconnected after save");
        },
      },
    );
    expect(events).toEqual(["pause", "stop", "save-and-activate"]);
  });

  it("schedules even when the working guest has no active Stop control", async () => {
    const events: string[] = [];
    const interrupted = await scheduleCaffyBegin(
      123456, true,
      async () => { events.push("no-stop"); throw new Error("No active Stop generation control was found."); },
      async () => { events.push("schedule"); },
      {
        suspendWake: async () => { events.push("suspend"); },
        resumeWake: async () => { events.push("restore"); },
      },
    );
    expect(interrupted).toBe(false);
    expect(events).toEqual(["suspend", "no-stop", "schedule"]);
  });

  it("restores the original Caffy monitor if scheduling fails after Stop is unavailable", async () => {
    const events: string[] = [];
    await expect(scheduleCaffyBegin(
      123456, true,
      async () => { events.push("no-stop"); throw new Error("Unavailable"); },
      async () => { events.push("schedule-failed"); throw new Error("Persistence failed"); },
      {
        suspendWake: async () => { events.push("suspend"); },
        resumeWake: async () => { events.push("restore"); },
      },
    )).rejects.toThrow("Persistence failed");
    expect(events).toEqual(["suspend", "no-stop", "schedule-failed", "restore"]);
  });

  it("schedules idle sessions and clears delays without interrupting", async () => {
    const events: Array<number | null> = [];
    const stop = async () => { throw new Error("Must not stop idle work"); };
    expect(await scheduleCaffyBegin(123456, false, stop, async (at) => { events.push(at); })).toBe(false);
    expect(await scheduleCaffyBegin(null, true, stop, async (at) => { events.push(at); })).toBe(false);
    expect(events).toEqual([123456, null]);
  });
});
