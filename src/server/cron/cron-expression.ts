// Minimal 5-field cron expression parser/evaluator.
// Fields: minute (0-59) hour (0-23) day-of-month (1-31) month (1-12) day-of-week (0-6, Sun=0)
// Supports: *, */N, A-B, A-B/N, comma-separated lists, single values.

export interface ParsedCron {
  readonly minute: ReadonlySet<number>;
  readonly hour: ReadonlySet<number>;
  readonly dom: ReadonlySet<number>;
  readonly month: ReadonlySet<number>;
  readonly dow: ReadonlySet<number>;
  readonly domStar: boolean;
  readonly dowStar: boolean;
}

const FIELD_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // dom
  [1, 12], // month
  [0, 6],  // dow
];

export class CronParseError extends Error {}

export function parseCron(expr: string): ParsedCron {
  const trimmed = expr.trim();
  if (!trimmed) throw new CronParseError("Empty cron expression");
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) throw new CronParseError(`Cron expression must have 5 fields, got ${fields.length}`);
  const [min, hour, dom, month, dow] = fields.map((f, i) => parseField(f, FIELD_RANGES[i]![0], FIELD_RANGES[i]![1]));
  return {
    minute: min!,
    hour: hour!,
    dom: dom!,
    month: month!,
    dow: dow!,
    domStar: fields[2] === "*",
    dowStar: fields[4] === "*",
  };
}

function parseField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    if (part.trim() === "") throw new CronParseError(`Empty list entry in field: "${field}"`);
    expandPart(part, min, max, out);
  }
  if (out.size === 0) throw new CronParseError(`Empty field: "${field}"`);
  return out;
}

function expandPart(part: string, min: number, max: number, out: Set<number>): void {
  let step = 1;
  let range = part;
  const slash = part.indexOf("/");
  if (slash >= 0) {
    range = part.slice(0, slash);
    const stepStr = part.slice(slash + 1);
    step = Number(stepStr);
    if (!Number.isInteger(step) || step <= 0) throw new CronParseError(`Invalid step: "${part}"`);
  }
  let lo: number, hi: number;
  if (range === "*") {
    lo = min;
    hi = max;
  } else if (range.includes("-")) {
    const [a, b] = range.split("-");
    lo = Number(a);
    hi = Number(b);
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) throw new CronParseError(`Invalid range: "${part}"`);
  } else {
    const n = Number(range);
    if (!Number.isInteger(n)) throw new CronParseError(`Invalid value: "${part}"`);
    if (slash >= 0) {
      lo = n;
      hi = max;
    } else {
      lo = n;
      hi = n;
    }
  }
  if (lo < min || hi > max || lo > hi) throw new CronParseError(`Out-of-range value in "${part}" (allowed ${min}-${max})`);
  for (let i = lo; i <= hi; i += step) out.add(i);
}

export function matches(parsed: ParsedCron, date: Date): boolean {
  const minuteOk = parsed.minute.has(date.getMinutes());
  const hourOk = parsed.hour.has(date.getHours());
  const monthOk = parsed.month.has(date.getMonth() + 1);
  const domOk = parsed.dom.has(date.getDate());
  const dowOk = parsed.dow.has(date.getDay());
  // Standard cron: if both dom and dow are restricted, either match suffices.
  const dayOk = parsed.domStar || parsed.dowStar ? (domOk && dowOk) : (domOk || dowOk);
  return minuteOk && hourOk && monthOk && dayOk;
}

// Find next firing time strictly after `from` (within ~1 year search).
export function nextRun(parsed: ParsedCron, from: Date = new Date()): Date | undefined {
  const candidate = new Date(from.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  for (let i = 0; i < 60 * 24 * 366; i++) {
    if (matches(parsed, candidate)) return new Date(candidate.getTime());
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return undefined;
}
