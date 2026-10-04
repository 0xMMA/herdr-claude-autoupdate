import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Config {
  /** Log what would happen without touching any pane. */
  dryRun: boolean;
  /** Seconds between checks, in both idle and update mode. */
  intervalSeconds: number;
  /** Minimum time a session must have been idle before it is restarted. */
  quietSeconds: number;
  /** Length of the countdown popup shown for the focused pane. */
  countdownSeconds: number;
  /** When the countdown popup cannot be shown, restart the focused pane only after this much idle time. */
  focusedUnattendedMinutes: number;
  /** Move an unsent prompt draft through Claude's input history across the restart. */
  rescueDrafts: boolean;
  /** Show a herdr notification after each restart. */
  toast: boolean;
  /** Pretend this Claude Code version is installed. For testing only. */
  fakeInstalledVersion: string | undefined;
}

export const DEFAULT_CONFIG: Config = {
  dryRun: true,
  intervalSeconds: 60,
  quietSeconds: 120,
  countdownSeconds: 5,
  focusedUnattendedMinutes: 30,
  rescueDrafts: true,
  toast: false,
  fakeInstalledVersion: undefined,
};

export const CONFIG_FILE = "config.json";

const NUMBER_KEYS = {
  interval_seconds: { key: "intervalSeconds", min: 10 },
  quiet_seconds: { key: "quietSeconds", min: 0 },
  countdown_seconds: { key: "countdownSeconds", min: 1 },
  focused_unattended_minutes: { key: "focusedUnattendedMinutes", min: 0 },
} as const;

const BOOLEAN_KEYS = {
  dry_run: "dryRun",
  rescue_drafts: "rescueDrafts",
  toast: "toast",
} as const;

export interface LoadedConfig {
  config: Config;
  warnings: string[];
}

/** Parses the user's `config.json` (snake_case keys). Invalid values fall back to defaults with a warning. */
export function parseConfig(raw: unknown): LoadedConfig {
  const config: Config = { ...DEFAULT_CONFIG };
  const warnings: string[] = [];
  if (raw === undefined) return { config, warnings };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { config, warnings: ["config.json must contain a JSON object; using defaults"] };
  }

  for (const [name, value] of Object.entries(raw)) {
    if (name in NUMBER_KEYS) {
      const spec = NUMBER_KEYS[name as keyof typeof NUMBER_KEYS];
      if (typeof value === "number" && Number.isFinite(value) && value >= spec.min) {
        config[spec.key] = value;
      } else {
        warnings.push(`${name} must be a number >= ${spec.min}; using ${config[spec.key]}`);
      }
    } else if (name in BOOLEAN_KEYS) {
      const key = BOOLEAN_KEYS[name as keyof typeof BOOLEAN_KEYS];
      if (typeof value === "boolean") config[key] = value;
      else warnings.push(`${name} must be true or false; using ${config[key]}`);
    } else if (name === "fake_installed_version") {
      if (typeof value === "string" || value === null) config.fakeInstalledVersion = value ?? undefined;
      else warnings.push("fake_installed_version must be a string");
    } else {
      warnings.push(`unknown setting ${name} ignored`);
    }
  }
  return { config, warnings };
}

export function loadConfig(configDir: string): LoadedConfig {
  let text: string;
  try {
    text = readFileSync(join(configDir, CONFIG_FILE), "utf8");
  } catch {
    return parseConfig(undefined);
  }
  try {
    return parseConfig(JSON.parse(text));
  } catch (error) {
    return { config: { ...DEFAULT_CONFIG }, warnings: [`config.json is not valid JSON (${(error as Error).message}); using defaults`] };
  }
}
