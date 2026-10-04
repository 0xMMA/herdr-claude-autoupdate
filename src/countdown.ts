import { writeAtomic } from "./store.ts";

/**
 * The popup UI shown over the focused pane (R7). It owns the popup's terminal, so any
 * key press reaches it. When nobody is looking the timer simply runs out.
 */
export interface CountdownOptions {
  seconds: number;
  label: string;
  resultFile: string;
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
}

export function renderCountdown(label: string, remaining: number): string {
  return [
    "\u001b[2J\u001b[H",
    "  Claude Code update installed\n\n",
    `  Restarting ${label} in ${remaining} s\n`,
    "  (same session, same flags)\n\n",
    "  Press any key to cancel.",
  ].join("");
}

export function runCountdown(options: CountdownOptions): Promise<"proceed" | "cancel"> {
  const { input, output } = options;
  return new Promise((resolve) => {
    let remaining = Math.max(1, Math.round(options.seconds));
    let done = false;

    const finish = (answer: "proceed" | "cancel") => {
      if (done) return;
      done = true;
      clearInterval(timer);
      input.off("data", onKey);
      if (input.isTTY) input.setRawMode(false);
      input.pause();
      writeAtomic(options.resultFile, answer);
      output.write(answer === "cancel" ? "\n\n  Cancelled. This pane keeps its version until the next update.\n" : "\n\n  Restarting…\n");
      resolve(answer);
    };
    const onKey = () => finish("cancel");

    if (input.isTTY) input.setRawMode(true);
    input.resume();
    input.on("data", onKey);

    output.write(renderCountdown(options.label, remaining));
    const timer = setInterval(() => {
      remaining--;
      if (remaining <= 0) finish("proceed");
      else output.write(renderCountdown(options.label, remaining));
    }, 1000);
  });
}
