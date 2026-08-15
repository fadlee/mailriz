import pc from 'picocolors';

/**
 * Terminal UI kit for mailriz-cli.
 *
 * The wizard reads as a live task runner: every stage is a row that moves
 * pending → running → done in place, with its result aligned in a value
 * column. Interactive prompts happen first; once provisioning starts the
 * task block owns the bottom of the screen and redraws itself.
 *
 * Anything that needs more than a value — a warning, a manual fallback — is
 * collected and printed after the block, so long text never tears the layout.
 */

// ---------------------------------------------------------------- palette

const EMERALD = '\x1b[38;5;42m';
const EMERALD_DIM = '\x1b[38;5;29m';
const RESET = '\x1b[0m';

const paint = (code: string) => (s: string) =>
  pc.isColorSupported ? `${code}${s}${RESET}` : s;

export const accent = paint(EMERALD);
export const accentDim = paint(EMERALD_DIM);

// ---------------------------------------------------------------- layout

const INDENT = '  ';
/** Width of the label column; values line up past it. */
const LABEL_W = 15;

function width(): number {
  return Math.min(process.stdout.columns || 80, 74);
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

/** Truncate to fit, accounting for the indent and label column. */
function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + '…';
}

/** Every printed line goes through here so blank() can collapse runs of
 *  vertical space instead of letting callers stack them. */
let lastBlank = true;

function out(line = ''): void {
  console.log(line);
  lastBlank = line === '';
}

/** Emit one empty line — a no-op when the previous line was already empty. */
export function blank(): void {
  if (!lastBlank) out();
}

/** TaskList writes straight to stdout; let it re-sync the spacing state. */
export function markDirty(): void {
  lastBlank = false;
}

export function rule(): void {
  out(INDENT + pc.dim('─'.repeat(width() - INDENT.length)));
}

// ---------------------------------------------------------------- banner

const WORDMARK = [
  '███╗   ███╗ █████╗ ██╗██╗     ██████╗ ██╗███████╗',
  '████╗ ████║██╔══██╗██║██║     ██╔══██╗██║╚══███╔╝',
  '██╔████╔██║███████║██║██║     ██████╔╝██║  ███╔╝ ',
  '██║╚██╔╝██║██╔══██║██║██║     ██╔══██╗██║ ███╔╝  ',
  '██║ ╚═╝ ██║██║  ██║██║███████╗██║  ██║██║███████╗',
  '╚═╝     ╚═╝╚═╝  ╚═╝╚═╝╚══════╝╚═╝  ╚═╝╚═╝╚══════╝',
];

const TAGLINE = 'Persistent email aliases, self-hosted on Cloudflare';

export function banner(): void {
  blank();
  // The wordmark is 49 columns; drop to a plain one on narrow terminals
  // rather than letting it wrap into noise.
  if ((process.stdout.columns || 80) >= 53) {
    for (const line of WORDMARK) out(INDENT + accent(line));
  } else {
    out(INDENT + accent(pc.bold('MailRiz')));
  }
  blank();
  out(INDENT + pc.dim(TAGLINE));
  blank();
}

/** `setup                              acme-corp / example.com` */
export function commandHeader(command: string, context?: string): void {
  const w = width();
  const left = pc.bold(command);
  if (context) {
    const room = w - INDENT.length - command.length - 1;
    const right = pc.dim(clip(context, Math.max(0, room)));
    const gap = Math.max(1, w - INDENT.length - command.length - stripLen(right));
    out(INDENT + left + ' '.repeat(gap) + right);
  } else {
    out(INDENT + left);
  }
  rule();
}

/** Visible length, ignoring ANSI escapes. */
function stripLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

// ---------------------------------------------------------------- static rows

const OK = '✔';
const BAD = '✘';
const WARN = '▲';
const SKIP = '–';
const PENDING = ' ';

/** A one-off check row, used before the task block takes over. */
export function checkRow(ok: boolean, label: string, detail = ''): void {
  const icon = ok ? accent(OK) : pc.red(BAD);
  const body = detail ? pc.dim(detail) : '';
  out(`${INDENT}${icon} ${pad(label, LABEL_W)}${body}`);
}

/** Aligned key/value lines for summaries. */
export function rows(pairs: [string, string][]): void {
  for (const [k, v] of pairs) {
    out(`${INDENT}${pc.dim(pad(k, LABEL_W))}${v}`);
  }
}

export function hint(text: string): void {
  out(INDENT + pc.dim(text));
}

export function bullet(text: string): void {
  out(`${INDENT}${pc.dim('·')} ${pc.dim(text)}`);
}

export function link(url: string): void {
  out(`${INDENT}${accentDim('→')} ${pc.underline(url)}`);
}

export function heading(text: string): void {
  blank();
  out(INDENT + pc.bold(text));
}

/**
 * Run one awaited step as a single self-replacing row. Used during the
 * interactive stages, where the full task block isn't live yet.
 */
export async function spin<T>(
  label: string,
  fn: () => Promise<T>,
  describe?: (value: T) => string
): Promise<T> {
  const tty = Boolean(process.stdout.isTTY);
  let i = 0;
  let timer: NodeJS.Timeout | null = null;

  const draw = () => {
    process.stdout.write(`\r\x1b[2K${INDENT}${accent(FRAMES[i]!)} ${pad(label, LABEL_W)}`);
  };

  if (tty) {
    process.stdout.write('\x1b[?25l');
    draw();
    timer = setInterval(() => {
      i = (i + 1) % FRAMES.length;
      draw();
    }, 80);
  }

  const finish = () => {
    if (timer) clearInterval(timer);
    if (tty) process.stdout.write('\r\x1b[2K\x1b[?25h');
  };

  try {
    const value = await fn();
    finish();
    checkRow(true, label, describe ? describe(value) : '');
    return value;
  } catch (e) {
    finish();
    checkRow(false, label, (e as Error).message);
    throw e;
  }
}

// ---------------------------------------------------------------- task list

export type TaskState = 'pending' | 'run' | 'ok' | 'warn' | 'fail' | 'skip';

interface Task {
  key: string;
  label: string;
  state: TaskState;
  detail: string;
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * A block of task rows that redraws in place while work runs.
 *
 * On a non-TTY (CI, piped output) it degrades to one append-only line per
 * settled task — no cursor movement, no spinner frames.
 */
export class TaskList {
  private tasks: Task[];
  private drawn = 0;
  private frame = 0;
  private timer: NodeJS.Timeout | null = null;
  private startedAt = 0;
  private live = false;
  private notes: { title: string; body: string }[] = [];
  private readonly tty = Boolean(process.stdout.isTTY);

  constructor(tasks: { key: string; label: string }[]) {
    this.tasks = tasks.map((t) => ({ ...t, state: 'pending', detail: '' }));
  }

  /** Mark a task settled before the block goes live (interactive stages). */
  seed(key: string, detail: string, state: TaskState = 'ok'): void {
    this.set(key, state, detail);
  }

  /** Start live rendering. Nothing interactive may print until stop(). */
  start(): void {
    this.startedAt = Date.now();
    this.live = true;
    if (!this.tty) {
      // Replay what the interactive stages already settled.
      for (const t of this.tasks) {
        if (t.state !== 'pending') out(this.plainLine(t));
      }
      return;
    }
    process.stdout.write('\x1b[?25l'); // hide cursor
    process.once('SIGINT', this.restoreCursor);
    this.render();
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % FRAMES.length;
      this.render();
    }, 80);
  }

  private restoreCursor = () => {
    process.stdout.write('\x1b[?25h');
  };

  set(key: string, state: TaskState, detail = ''): void {
    const t = this.tasks.find((x) => x.key === key);
    if (!t) return;
    const settled = state !== 'pending' && state !== 'run';
    t.state = state;
    if (detail) t.detail = detail;
    if (this.live) {
      if (this.tty) this.render();
      else if (settled) out(this.plainLine(t));
    }
  }

  run(key: string, detail = ''): void {
    this.set(key, 'run', detail);
  }

  ok(key: string, detail = ''): void {
    this.set(key, 'ok', detail);
  }

  warn(key: string, detail: string, note?: { title: string; body: string }): void {
    this.set(key, 'warn', detail);
    if (note) this.notes.push(note);
  }

  failTask(key: string, detail: string): void {
    this.set(key, 'fail', detail);
  }

  skip(key: string, detail = 'skipped'): void {
    this.set(key, 'skip', detail);
  }

  /** Stop rendering and leave the finished block on screen. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.live = false;
    if (this.tty) {
      this.render(true);
      this.restoreCursor();
      process.removeListener('SIGINT', this.restoreCursor);
      // The block bypassed out(), so spacing state has to be re-synced.
      markDirty();
    }
    for (const n of this.notes) {
      blank();
      out(INDENT + pc.yellow(pc.bold(n.title)));
      for (const line of n.body.split('\n')) {
        out(INDENT + pc.dim(line));
      }
    }
    this.notes = [];
  }

  private icon(t: Task): string {
    switch (t.state) {
      case 'ok': return accent(OK);
      case 'fail': return pc.red(BAD);
      case 'warn': return pc.yellow(WARN);
      case 'skip': return pc.dim(SKIP);
      case 'run': return accent(FRAMES[this.frame]!);
      default: return PENDING;
    }
  }

  private line(t: Task): string {
    const label = t.state === 'pending' ? pc.dim(pad(t.label, LABEL_W)) : pad(t.label, LABEL_W);
    const room = width() - INDENT.length - 2 - LABEL_W;
    const text = t.detail || (t.state === 'pending' ? 'pending' : '');
    const detail = text ? clip(text, room) : '';
    const body =
      t.state === 'ok' ? pc.dim(detail)
      : t.state === 'fail' ? pc.red(detail)
      : t.state === 'warn' ? pc.yellow(detail)
      : pc.dim(detail);
    return `${INDENT}${this.icon(t)} ${label}${body}`;
  }

  private plainLine(t: Task): string {
    const mark =
      t.state === 'ok' ? OK
      : t.state === 'fail' ? BAD
      : t.state === 'warn' ? WARN
      : t.state === 'skip' ? SKIP
      : '·';
    return `${INDENT}${mark} ${pad(t.label, LABEL_W)}${t.detail}`;
  }

  private summary(): string {
    const count = (s: TaskState) => this.tasks.filter((t) => t.state === s).length;
    const done = count('ok');
    const running = count('run');
    const pending = count('pending');
    const failed = count('fail') + count('warn');

    const parts = [`${done} done`];
    if (running) parts.push(`${running} running`);
    if (pending) parts.push(`${pending} pending`);
    if (failed) parts.push(`${failed} needs attention`);

    const secs = Math.floor((Date.now() - this.startedAt) / 1000);
    const elapsed = `elapsed ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;

    const left = parts.join(' · ');
    const gap = Math.max(1, width() - INDENT.length - left.length - elapsed.length);
    return INDENT + pc.dim(left + ' '.repeat(gap) + elapsed);
  }

  private render(final = false): void {
    if (!this.tty) return;
    const out = [...this.tasks.map((t) => this.line(t)), this.ruleLine(), this.summary()];
    if (this.drawn) process.stdout.write(`\x1b[${this.drawn}A`);
    for (const l of out) process.stdout.write(`\x1b[2K${l}\n`);
    this.drawn = final ? 0 : out.length;
  }

  private ruleLine(): string {
    return INDENT + pc.dim('─'.repeat(width() - INDENT.length));
  }
}

// ---------------------------------------------------------------- outcome

export function finished(title: string, pairs: [string, string][], footer?: string): void {
  blank();
  out(INDENT + accent(pc.bold(title)));
  blank();
  rows(pairs);
  if (footer) {
    blank();
    out(INDENT + pc.dim(footer));
  }
  blank();
}

export function aborted(message: string): void {
  blank();
  out(`${INDENT}${pc.red(BAD)} ${message}`);
  blank();
}
