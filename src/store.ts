import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The only state the plugin persists (requirement R12): per session, what happened for
 * which target version. Everything else is read live.
 */
export type MarkResult = "done" | "failed" | "declined" | "dry-run";

export interface Mark {
  version: string;
  result: MarkResult;
  reason?: string;
  at: number;
}

export type Marks = Record<string, Mark>;

const MARKS_FILE = "marks.json";
const LOG_FILE = "plugin.log";
const LOG_MAX_BYTES = 1024 * 1024;
const MARK_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export class Store {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    // The log can hold draft text: keep the directory private to the user (R17).
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      try {
        chmodSync(dir, 0o700);
      } catch {
        // not ours to change; files below are still created private
      }
    }
  }

  get logPath(): string {
    return join(this.dir, LOG_FILE);
  }

  readMarks(): Marks {
    try {
      const raw = JSON.parse(readFileSync(join(this.dir, MARKS_FILE), "utf8")) as unknown;
      return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Marks) : {};
    } catch {
      return {};
    }
  }

  writeMarks(marks: Marks): void {
    writeAtomic(join(this.dir, MARKS_FILE), `${JSON.stringify(marks, null, 2)}\n`);
  }

  setMark(sessionId: string, mark: Mark): void {
    const marks = this.readMarks();
    marks[sessionId] = mark;
    this.writeMarks(marks);
  }

  /** Drops marks of sessions that no longer exist once they are old enough. */
  pruneMarks(liveSessionIds: ReadonlySet<string>, now: number): void {
    const marks = this.readMarks();
    let changed = false;
    for (const [id, mark] of Object.entries(marks)) {
      if (!liveSessionIds.has(id) && now - mark.at > MARK_TTL_MS) {
        delete marks[id];
        changed = true;
      }
    }
    if (changed) this.writeMarks(marks);
  }

  log(message: string, now: Date = new Date()): void {
    try {
      if (statSync(this.logPath).size > LOG_MAX_BYTES) renameSync(this.logPath, `${this.logPath}.1`);
    } catch {
      // no log yet
    }
    try {
      appendFileSync(this.logPath, `${now.toISOString()} ${message}\n`, { mode: 0o600 });
    } catch {
      // logging must never break the clock
    }
  }

  tailLog(lines: number): string[] {
    try {
      const text = readFileSync(this.logPath, "utf8").trimEnd();
      return text === "" ? [] : text.split("\n").slice(-lines);
    } catch {
      return [];
    }
  }
}

export function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  try {
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // nothing left to clean up
    }
    throw error;
  }
}
