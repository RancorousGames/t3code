import * as Crypto from "node:crypto";
import * as Fs from "node:fs";
import * as Path from "node:path";

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

/** One writer at a time, with cautious recovery after the owning process dies. */
export async function withArchiveWriteLock(directory, work) {
  Fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = Path.join(directory, ".writer.lock");
  const contents = JSON.stringify({
    pid: process.pid,
    id: Crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  });
  const acquire = () => {
    const fd = Fs.openSync(file, "wx", 0o600);
    try {
      Fs.writeFileSync(fd, contents);
    } finally {
      Fs.closeSync(fd);
    }
  };
  try {
    acquire();
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    let previous;
    try {
      previous = Fs.readFileSync(file, "utf8");
    } catch {
      throw new Error("Archive writer lock cannot be read");
    }
    let owner;
    try {
      owner = JSON.parse(previous);
    } catch {
      throw new Error("Archive writer lock is corrupt; refusing unsafe removal");
    }
    if (!Number.isSafeInteger(owner?.pid) || owner.pid < 1)
      throw new Error("Archive writer lock has an invalid owner");
    if (isPidAlive(owner.pid))
      throw new Error("ChatGPT archive writer is already active (PID " + owner.pid + ")");
    if (Date.now() - Fs.statSync(file).mtimeMs < 2_000)
      throw new Error("Crashed archive writer lock is too new to reclaim");
    if (Fs.readFileSync(file, "utf8") !== previous)
      throw new Error("Archive writer lock changed during recovery");
    Fs.unlinkSync(file);
    acquire();
  }
  try {
    return await work();
  } finally {
    try {
      if (Fs.readFileSync(file, "utf8") === contents) Fs.unlinkSync(file);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}
