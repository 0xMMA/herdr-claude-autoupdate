export type Version = readonly [number, number, number];

const VERSION_RE = /(\d+)\.(\d+)\.(\d+)/;

/** Extracts the first `major.minor.patch` triple, e.g. from `2.1.289 (Claude Code)`. */
export function parseVersion(text: string): Version | undefined {
  const match = VERSION_RE.exec(text);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    const diff = a[i]! - b[i]!;
    if (diff !== 0) return diff;
  }
  return 0;
}

/** True only when both versions parse and `running` is strictly older than `installed`. */
export function isOlder(running: string, installed: string): boolean {
  const a = parseVersion(running);
  const b = parseVersion(installed);
  if (!a || !b) return false;
  return compareVersions(a, b) < 0;
}

export function formatVersion(version: Version): string {
  return version.join(".");
}
