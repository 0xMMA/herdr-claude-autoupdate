import type { PermissionMode } from "./args.ts";

/**
 * Reads Claude Code's prompt box from an ANSI screen capture (`herdr pane read --format ansi`).
 *
 * The box is the bottom-most block that sits between two horizontal rules and starts
 * with `❯`. Text Claude renders dim or grey there (placeholders, prompt suggestions) is
 * not something the user typed and is ignored.
 */

export type PromptState = "empty" | "draft" | "absent";

export interface ScreenInfo {
  prompt: PromptState;
  /** Typed text, lines joined with `\n`. Empty unless `prompt === "draft"`. */
  draft: string;
  /** The draft references pasted content or images that may not survive a restart. */
  hasAttachment: boolean;
  /** Live permission mode from the footer; `null` = default mode, `undefined` = no prompt box found. */
  permissionMode: PermissionMode | null | undefined;
}

interface Cell {
  ch: string;
  faint: boolean;
}

const ESC = "\u001b";
const RULE = "─"; // ─
const PROMPT = "❯"; // ❯

/** Splits a line into characters with a "faint" flag (dim, or an explicit grey foreground). */
export function cells(line: string): Cell[] {
  const out: Cell[] = [];
  let dim = false;
  let grey = false;
  for (let i = 0; i < line.length; ) {
    if (line[i] === ESC && line[i + 1] === "[") {
      let j = i + 2;
      while (j < line.length && !/[\x40-\x7e]/.test(line[j]!)) j++;
      if (line[j] === "m") ({ dim, grey } = applySgr(line.slice(i + 2, j), dim, grey));
      i = j + 1;
      continue;
    }
    if (line[i] === ESC) {
      // other escape sequences (OSC etc.) are not expected in a capture; skip the ESC
      i++;
      continue;
    }
    const cp = line.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    out.push({ ch, faint: dim || grey });
    i += ch.length;
  }
  return out;
}

function applySgr(params: string, dim: boolean, grey: boolean): { dim: boolean; grey: boolean } {
  const codes = params === "" ? [0] : params.split(";").map((p) => Number(p));
  for (let k = 0; k < codes.length; k++) {
    const code = codes[k]!;
    if (code === 0) {
      dim = false;
      grey = false;
    } else if (code === 2) dim = true;
    else if (code === 22) dim = false;
    else if (code === 39) grey = false;
    else if (code === 90) grey = true;
    else if ((code >= 30 && code <= 37) || (code >= 91 && code <= 97)) grey = false;
    else if (code === 38) {
      if (codes[k + 1] === 5) {
        const n = codes[k + 2] ?? -1;
        grey = n === 8 || (n >= 238 && n <= 250);
        k += 2;
      } else if (codes[k + 1] === 2) {
        const [r, g, b] = [codes[k + 2], codes[k + 3], codes[k + 4]];
        grey = r === g && g === b && r !== undefined && r >= 96 && r <= 200;
        k += 4;
      }
    } else if (code === 48) {
      // background colour: skip its parameters
      if (codes[k + 1] === 5) k += 2;
      else if (codes[k + 1] === 2) k += 4;
    }
  }
  return { dim, grey };
}

export function plain(line: string): string {
  return cells(line)
    .map((c) => c.ch)
    .join("");
}

function isRule(text: string): boolean {
  const t = text.trim();
  if (!t.startsWith(RULE) || !t.endsWith(RULE)) return false;
  let count = 0;
  for (const ch of t) if (ch === RULE) count++;
  return count >= 8;
}

const ATTACHMENT_RE = /\[(Image|Pasted text|Pasted image|File) #\d+/;
const OPTION_RE = /^\s*❯\s*\d+[.)]\s/;
const DIALOG_HINT_RE = /\b(Esc to (cancel|exit|go back)|Enter to (select|confirm|submit))\b/i;

const MODES: ReadonlyArray<[RegExp, PermissionMode]> = [
  [/\bbypass permissions on\b/i, "bypassPermissions"],
  [/\baccept edits on\b/i, "acceptEdits"],
  [/\bplan mode on\b/i, "plan"],
  [/\bauto mode on\b/i, "auto"],
  [/\bdon'?t ask (mode )?on\b/i, "dontAsk"],
];

export function parseScreen(capture: string): ScreenInfo {
  const lines = capture.replace(/\r/g, "").split("\n");
  const texts = lines.map(plain);

  let top = -1;
  for (let i = texts.length - 2; i >= 0; i--) {
    if (isRule(texts[i]!) && texts[i + 1]!.trimStart().startsWith(PROMPT)) {
      top = i;
      break;
    }
  }
  let bottom = -1;
  if (top >= 0) {
    for (let i = top + 2; i < texts.length; i++) {
      if (isRule(texts[i]!)) {
        bottom = i;
        break;
      }
    }
  }
  const absent: ScreenInfo = { prompt: "absent", draft: "", hasAttachment: false, permissionMode: undefined };
  if (top < 0 || bottom < 0) return absent;
  // Selection dialogs (AskUserQuestion, permission prompts) can also draw rules and a `❯`
  // cursor. Treat anything that looks like one as "not the prompt box": waiting is safe,
  // sending Esc into a dialog is not.
  if (OPTION_RE.test(texts[top + 1]!)) return absent;
  if (texts.slice(top).some((t) => DIALOG_HINT_RE.test(t))) return absent;

  const typed: string[] = [];
  for (let i = top + 1; i < bottom; i++) {
    let row = cells(lines[i]!);
    if (i === top + 1) {
      const at = row.findIndex((c) => c.ch === PROMPT);
      row = row.slice(at + 1);
    }
    typed.push(
      row
        .map((c) => (c.faint ? " " : c.ch))
        .join("")
        .replace(/\s+$/u, "")
        .replace(/^\s{1,2}/u, ""),
    );
  }
  while (typed.length > 0 && typed[typed.length - 1]!.trim() === "") typed.pop();
  const draft = typed.join("\n");
  const hasText = draft.trim() !== "";

  const footer = texts.slice(bottom + 1).join("\n");
  const mode = MODES.find(([re]) => re.test(footer));

  return {
    prompt: hasText ? "draft" : "empty",
    draft: hasText ? draft : "",
    hasAttachment: hasText && ATTACHMENT_RE.test(draft),
    permissionMode: mode ? mode[1] : null,
  };
}
