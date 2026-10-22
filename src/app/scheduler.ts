/**
 * Download scheduler (0.7.0) — time windows in which downloads may run.
 *
 * A window is a local-time range like { start: "22:00", end: "06:00" }.
 * Overnight windows (end <= start) wrap past midnight. The policy is
 * deliberately dumb: it answers "may downloads run right now?" and the
 * manager decides what to do (don't start new jobs outside a window,
 * pause running ones when a window closes). All date math uses the
 * machine's local timezone, matching how a user reads "22:00".
 */

export interface SchedulerWindow {
  /** "HH:MM" 24-hour local time, inclusive start. */
  start: string;
  /** "HH:MM" 24-hour local time, exclusive end. */
  end: string;
}

export interface SchedulerPolicy {
  enabled: boolean;
  windows: SchedulerWindow[];
}

export function parseTimeOfDay(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** True when `now` falls inside one window (overnight wraps midnight). */
export function isInWindow(now: Date, window: SchedulerWindow): boolean {
  const start = parseTimeOfDay(window.start);
  const end = parseTimeOfDay(window.end);
  if (start === null || end === null) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (start === end) return true; // Degenerate window = whole day.
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end; // Overnight.
}

/** True when downloads may run right now under the policy. */
export function shouldRunNow(policy: SchedulerPolicy, now = new Date()): boolean {
  if (!policy.enabled) return true;
  if (policy.windows.length === 0) return true;
  return policy.windows.some((window) => isInWindow(now, window));
}

/** Validate a window pair; returns an error string or null. */
export function validateWindow(start: string, end: string): string | null {
  if (parseTimeOfDay(start) === null) return `Invalid start time: ${start}`;
  if (parseTimeOfDay(end) === null) return `Invalid end time: ${end}`;
  return null;
}
