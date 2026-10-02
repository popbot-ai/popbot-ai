/**
 * Five-field cron schedules for bot triggers: minute hour day-of-month
 * month day-of-week, in the host's local time. Each field takes `*`,
 * a number, a range `a-b`, a step `*\/n` or `a-b/n`, and lists of those.
 * As in classic cron, when both day fields are restricted a day matches
 * either. Day-of-week 0 and 7 are both Sunday.
 */

const FIELDS: Array<{ name: string; min: number; max: number }> = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 },
];

interface Parsed {
  sets: Array<Set<number>>;
  /** Whether each day field was `*`. */
  anyDom: boolean;
  anyDow: boolean;
}

function parse(schedule: string): Parsed | string {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return 'needs five fields: minute hour day month weekday';
  const sets: Array<Set<number>> = [];
  for (let i = 0; i < 5; i += 1) {
    const { name, min, max } = FIELDS[i];
    const set = new Set<number>();
    for (const item of parts[i].split(',')) {
      const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(item);
      if (!m) return `bad ${name} "${item}"`;
      const lo = m[1] === '*' ? min : Number(m[2]);
      const hi = m[1] === '*' ? max : m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? max : lo;
      const step = m[4] !== undefined ? Number(m[4]) : 1;
      if (lo < min || hi > max || lo > hi || step < 1) return `${name} "${item}" is out of range (${min}-${max})`;
      for (let v = lo; v <= hi; v += step) set.add(i === 4 && v === 7 ? 0 : v);
    }
    sets.push(set);
  }
  return { sets, anyDom: parts[2] === '*', anyDow: parts[4] === '*' };
}

/** Why a schedule is not usable, or null when it is. */
export function cronProblem(schedule: string): string | null {
  if (!schedule.trim()) return 'empty';
  const p = parse(schedule);
  return typeof p === 'string' ? p : null;
}

/** Does the schedule fire in the minute `at` falls in? */
export function cronMatches(schedule: string, at: Date): boolean {
  const p = parse(schedule);
  if (typeof p === 'string') return false;
  const [min, hour, dom, month, dow] = p.sets;
  if (!min.has(at.getMinutes()) || !hour.has(at.getHours()) || !month.has(at.getMonth() + 1)) return false;
  const domOk = dom.has(at.getDate());
  const dowOk = dow.has(at.getDay());
  if (p.anyDom && p.anyDow) return true;
  if (p.anyDom) return dowOk;
  if (p.anyDow) return domOk;
  return domOk || dowOk;
}
