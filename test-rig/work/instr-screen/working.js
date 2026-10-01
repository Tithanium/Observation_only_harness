// src/working.js
// Round 8 feature: the "working" indicator — pi's spinner while a request is in
// flight, shown only on a TTY, erased cleanly when done. pi's approach, adapted
// to this plain-JS CLI (extraction: "Working" indicator — spinner frames +
// 80 ms interval + TTY gating + clean erase, verified in the pi-tui Loader and
// print-mode's no-spinner design):
//   - frames are pi's loader DEFAULT_FRAMES, message is pi's defaultWorkingMessage
//     ("Working"), each frame ticking every DEFAULT_INTERVAL_MS = 80 ms, each
//     frame redrawing the SAME line in place ("\r\x1b[K" + frame + " " + message);
//     start() draws once immediately (loader.js start() + restartAnimation()),
//     stop() clears the timer (clearInterval) and erases the line — the caller's
//     next write (the reply) then starts on a CLEAN line and the footer follows
//     on its own line. The cursor is hidden ("\x1b[?25l") while working and
//     restored ("\x1b[?25h") at stop, like pi's terminal.js cursor handling.
//   - TTY-only gate, pi's resolveAppMode rule: the indicator writes ONLY when the
//     output stream is a TTY (process.stdout.isTTY, mirroring pi's
//     stdin/out isTTY check — non-TTY -> pi has no spinner at all, output prints
//     once at the end). Piped output therefore contains NO spinner and NO ANSI;
//     the explicit `isTTY` option lets tests drive the gate deterministically.
// The client (src/client.js) starts it at the beginning of every LLM round trip
// and stops it in `finally` — the indicator is active EXACTLY over the in-flight
// window. Never prints secrets.

/** pi's loader DEFAULT_FRAMES (loader.js): the braille spinner cycle. */
export const DEFAULT_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** pi's loader DEFAULT_INTERVAL_MS — one frame per 80 ms. */
export const FRAME_INTERVAL_MS = 80;

/** pi's defaultWorkingMessage (interactive-mode.js). */
export const DEFAULT_MESSAGE = "Working";

/** Cursor hidden while working, restored at stop (terminal.js \x1b[?25l / \x1b[?25h). */
export const CURSOR_HIDE = "\x1b[?25l";
export const CURSOR_SHOW = "\x1b[?25h";

/** In-place single-line redraw/erase: carriage return + clear to end of line. */
export const ERASE_LINE = "\r\x1b[K";

/**
 * The working indicator. `stream` is the output the spinner is written to
 * (default process.stdout); it is written to ONLY when `isTTY` is truthy
 * (default = stream.isTTY — piped output → silent, exactly like pi's print
 * mode). start() draws the first frame immediately and animates until stop();
 * every frame redraws the same line, stop() clears the timer and erases the
 * line, so the caller's reply + footer follow on clean lines.
 */
export function createWorkingIndicator(options = {}) {
  const stream = options.stream ?? process.stdout;
  const frames = options.frames ?? DEFAULT_FRAMES;
  const intervalMs = options.intervalMs ?? FRAME_INTERVAL_MS;
  const enabled = options.isTTY ?? Boolean(stream?.isTTY);
  let timer = null;
  let index = 0;
  let active = false;
  let text = DEFAULT_MESSAGE;
  const write = (s) => {
    try {
      stream.write(s);
    } catch {
      /* a closed stream must never take the request down */
    }
  };

  return {
    /** True only between start() and stop() — the in-flight window (start → reply). */
    get active() {
      return active;
    },
    /** Non-TTY output → nothing is ever written; start/stop are no-ops. */
    get enabled() {
      return enabled;
    },
    /** Show "⠋ Working" (start draws once, then one frame per intervalMs); a new
     *  start resets the message ("Working"; update() only lasts until the next
     *  start). */
    start(msg = options.message ?? DEFAULT_MESSAGE) {
      if (!enabled || active) return;
      text = msg;
      active = true;
      write(CURSOR_HIDE + frames[0] + " " + text); // pi's start(): draws once + restarts the animation
      timer = setInterval(() => {
        index = (index + 1) % frames.length;
        write(ERASE_LINE + frames[index] + " " + text); // same line redrawn in place (loader updateDisplay)
      }, intervalMs);
      if (timer.unref) timer.unref(); // the pending request keeps the process alive; the timer never does
    },
    /** Change the visible message while working (pi's setWorkingMessage). */
    update(msg) {
      if (!enabled || !active) return;
      text = msg;
      write(ERASE_LINE + frames[index] + " " + text);
    },
    /** Stop animating and erase the line (pi's loader stop() + terminal cleanup):
     *  the cursor is restored and the line cleared, so the reply and the footer
     *  follow on clean lines. */
    stop() {
      if (!enabled || !active) return;
      clearInterval(timer);
      timer = null;
      write(CURSOR_SHOW + ERASE_LINE);
      active = false;
    },
  };
}
