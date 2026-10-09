import { Temporal } from '@js-temporal/polyfill';

// A fixed nine-date window covers a skipped civil date without work growing with downtime.
const daysEitherSide = 4;
const localTimePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const localDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const numericOffsetPattern = /^(?:Z|[+-]\d{2}(?::?\d{2})?(?::?\d{2}(?:[.,]\d+)?)?)$/i;

export type DailyLocalOccurrence = {
  at: number;
  date: string;
};

export type DailyLocalCursor = {
  occurrence: number;
  occurrenceDate: string;
  nextAt: number;
  nextDate: string;
};

export function validateDailyLocalSchedule(timezone: string, time: string, anchor: number): void {
  if (!localTimePattern.test(time)) throw new RangeError('Local time must use HH:mm.');
  Temporal.PlainTime.from(time);
  if (!Number.isSafeInteger(anchor)) throw new RangeError('UTC anchor must be an integer millisecond timestamp.');

  const timeZoneId = Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(timezone).timeZoneId;
  if (numericOffsetPattern.test(timeZoneId)) throw new RangeError('Use a named IANA timezone.');
  Temporal.Instant.fromEpochMilliseconds(anchor).toZonedDateTimeISO(timezone);
}

function intendedDate(date: string): Temporal.PlainDate {
  if (!localDatePattern.test(date)) throw new RangeError('Local date must use YYYY-MM-DD.');
  return Temporal.PlainDate.from(date, { overflow: 'reject' });
}

// Compatible disambiguation shifts a gap by its full size and picks the earlier fold instant.
export function resolveDailyLocalAt(date: string, timezone: string, time: string): number {
  if (!localTimePattern.test(time)) throw new RangeError('Local time must use HH:mm.');
  return intendedDate(date)
    .toPlainDateTime(Temporal.PlainTime.from(time))
    .toZonedDateTime(timezone, { disambiguation: 'compatible' })
    .epochMilliseconds;
}

export function firstDailyLocalAtOrAfter(anchor: number, timezone: string, time: string): DailyLocalOccurrence {
  const first = dailyLocalCandidates(anchor, timezone, time).find(candidate => candidate.at >= anchor);
  if (!first) throw new RangeError('Could not resolve a local occurrence near the UTC anchor.');
  return first;
}

// Equal UTC instants consume the later date too, as in Apia's skipped civil date.
export function dailyLocalCandidates(now: number, timezone: string, time: string): DailyLocalOccurrence[] {
  validateDailyLocalSchedule(timezone, time, now);
  const today = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(timezone).toPlainDate();
  const candidates = new Map<number, DailyLocalOccurrence>();
  for (let offset = -daysEitherSide; offset <= daysEitherSide; offset += 1) {
    const date = today.add({ days: offset }).toString();
    const at = resolveDailyLocalAt(date, timezone, time);
    candidates.set(at, { at, date });
  }
  return [...candidates.values()].sort((left, right) => left.at - right.at);
}

export function latestDailyLocalCursor(cursor: DailyLocalOccurrence, now: number, timezone: string, time: string): DailyLocalCursor {
  validateDailyLocalSchedule(timezone, time, cursor.at);
  intendedDate(cursor.date);
  if (cursor.at > now) throw new RangeError('Routine cursor is not due.');
  const candidates = dailyLocalCandidates(now, timezone, time);
  // The saved date identifies its occurrence even if host tzdb rules move that day's UTC time.
  // Only later dates and instants can replace it during latest-only catchup.
  const due = candidates.filter(candidate => candidate.date > cursor.date && candidate.at > cursor.at && candidate.at <= now).at(-1);
  const occurrence = due ?? cursor;
  const next = candidates.find(candidate => candidate.date > occurrence.date && candidate.at > now && candidate.at > occurrence.at);
  if (!next) throw new RangeError('Could not resolve the next local occurrence in the bounded date window.');
  return { occurrence: occurrence.at, occurrenceDate: occurrence.date, nextAt: next.at, nextDate: next.date };
}

// Resume consumes the overdue intended date, including when its new resolution is still future.
export function firstDailyLocalAfter(now: number, timezone: string, time: string, afterDate: string): DailyLocalOccurrence {
  intendedDate(afterDate);
  const next = dailyLocalCandidates(now, timezone, time).find(candidate => candidate.date > afterDate && candidate.at > now);
  if (!next) throw new RangeError('Could not resolve a future local occurrence in the bounded date window.');
  return next;
}
