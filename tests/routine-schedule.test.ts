import { describe, expect, it } from 'vitest';
import { commandSchema, routineSchema } from '../src/core.js';
import {
  dailyLocalCandidates,
  firstDailyLocalAfter,
  firstDailyLocalAtOrAfter,
  latestDailyLocalCursor,
  resolveDailyLocalAt,
  validateDailyLocalSchedule,
} from '../src/routine-schedule.js';

describe('daily local routine schedule', () => {
  it('resolves the first 09:00 after an anchor across the spring DST change', () => {
    const anchor = Date.parse('2026-03-07T15:00:00.000Z');
    expect(firstDailyLocalAtOrAfter(anchor, 'America/New_York', '09:00'))
      .toEqual({ at: Date.parse('2026-03-08T13:00:00.000Z'), date: '2026-03-08' });
  });

  it('moves a spring gap forward by its full gap and returns to the requested time next day', () => {
    expect(resolveDailyLocalAt('2026-03-08', 'America/New_York', '02:30'))
      .toBe(Date.parse('2026-03-08T07:30:00.000Z'));
    expect(resolveDailyLocalAt('2026-03-09', 'America/New_York', '02:30'))
      .toBe(Date.parse('2026-03-09T06:30:00.000Z'));
  });

  it('uses the earlier instant for a fall fold', () => {
    expect(resolveDailyLocalAt('2026-11-01', 'America/New_York', '01:30'))
      .toBe(Date.parse('2026-11-01T05:30:00.000Z'));
  });

  it('applies a half-hour gap in Lord Howe', () => {
    expect(resolveDailyLocalAt('2026-10-04', 'Australia/Lord_Howe', '02:15'))
      .toBe(Date.parse('2026-10-03T15:45:00.000Z'));
  });

  it('deduplicates the same instant from Apia\'s skipped civil date and consumes both dates', () => {
    const candidates = dailyLocalCandidates(Date.parse('2011-12-30T20:00:00.000Z'), 'Pacific/Apia', '09:00');
    expect(candidates.filter(candidate => candidate.at === Date.parse('2011-12-30T19:00:00.000Z')))
      .toEqual([{ at: Date.parse('2011-12-30T19:00:00.000Z'), date: '2011-12-31' }]);
    expect(latestDailyLocalCursor({ at: Date.parse('2011-12-30T19:00:00Z'), date: '2011-12-30' }, Date.parse('2011-12-30T20:00:00Z'), 'Pacific/Apia', '09:00'))
      .toEqual({ occurrence: Date.parse('2011-12-30T19:00:00Z'), occurrenceDate: '2011-12-30', nextAt: Date.parse('2011-12-31T19:00:00Z'), nextDate: '2012-01-01' });
  });

  it('finds only the latest due date after distant downtime', () => {
    const now = Date.parse('2026-10-09T11:00:00.000Z');
    expect(latestDailyLocalCursor({ at: Date.parse('2010-01-01T09:00:00.000Z'), date: '2010-01-01' }, now, 'UTC', '09:00'))
      .toEqual({ occurrence: Date.parse('2026-10-09T09:00:00.000Z'), occurrenceDate: '2026-10-09', nextAt: Date.parse('2026-10-10T09:00:00.000Z'), nextDate: '2026-10-10' });
  });

  it.each([
    ['later', '2026-10-09T08:00:00Z', '2026-10-09T08:30:00Z'],
    ['earlier', '2026-10-09T10:00:00Z', '2026-10-09T10:30:00Z'],
  ])('keeps the saved due instant when current resolution moves %s and never repeats its calendar day', (_direction, saved, current) => {
    const result = latestDailyLocalCursor({ at: Date.parse(saved), date: '2026-10-09' }, Date.parse(current), 'UTC', '09:00');
    expect(result).toEqual({ occurrence: Date.parse(saved), occurrenceDate: '2026-10-09', nextAt: Date.parse('2026-10-10T09:00:00Z'), nextDate: '2026-10-10' });
    expect(() => latestDailyLocalCursor({ at: result.nextAt, date: result.nextDate }, Date.parse('2026-10-09T12:00:00Z'), 'UTC', '09:00')).toThrow('not due');
  });

  it('uses the saved intended date rather than deriving it from the current timezone', () => {
    const saved = { at: Date.parse('2026-10-08T23:00:00Z'), date: '2026-10-09' };
    expect(latestDailyLocalCursor(saved, Date.parse('2026-10-09T09:30:00Z'), 'UTC', '09:00'))
      .toEqual({ occurrence: saved.at, occurrenceDate: '2026-10-09', nextAt: Date.parse('2026-10-10T09:00:00Z'), nextDate: '2026-10-10' });
  });

  it('lets latest catchup consume a later date after a timezone resolution change', () => {
    expect(latestDailyLocalCursor({ at: Date.parse('2026-10-09T08:00:00Z'), date: '2026-10-09' }, Date.parse('2026-10-11T10:00:00Z'), 'UTC', '09:00'))
      .toEqual({ occurrence: Date.parse('2026-10-11T09:00:00Z'), occurrenceDate: '2026-10-11', nextAt: Date.parse('2026-10-12T09:00:00Z'), nextDate: '2026-10-12' });
  });

  it('skips a folded local occurrence when resuming between its two possible instants', () => {
    expect(firstDailyLocalAfter(Date.parse('2026-11-01T06:00:00.000Z'), 'America/New_York', '01:30', '2026-11-01'))
      .toEqual({ at: Date.parse('2026-11-02T06:30:00.000Z'), date: '2026-11-02' });
  });

  it('skips the overdue intended date on resume even when its current resolution is future', () => {
    expect(firstDailyLocalAfter(Date.parse('2026-10-09T08:30:00Z'), 'UTC', '09:00', '2026-10-09'))
      .toEqual({ at: Date.parse('2026-10-10T09:00:00Z'), date: '2026-10-10' });
    expect(firstDailyLocalAfter(Date.parse('2026-10-09T08:30:00Z'), 'UTC', '09:00', '2010-01-01'))
      .toEqual({ at: Date.parse('2026-10-09T09:00:00Z'), date: '2026-10-09' });
  });

  it('requires a valid stored intended date but rejects that field from command input', () => {
    const routine = { id: 'routine', scopeId: 'scope', createdBy: 'manager', instruction: 'Digest', state: 'active', timezone: 'UTC', nextAt: 0, intervalMs: 86_400_000, budgetMicros: 5000 };
    expect(routineSchema.safeParse({ ...routine, schedule: { kind: 'daily_local', time: '09:00', nextDate: '2024-02-29' } }).success).toBe(true);
    for (const nextDate of [undefined, '2026-02-29', '2026-04-31', '2026-10-09T09:00Z', '+010000-01-01']) {
      expect(routineSchema.safeParse({ ...routine, schedule: { kind: 'daily_local', time: '09:00', nextDate } }).success).toBe(false);
    }
    expect(commandSchema.safeParse({ ...routine, kind: 'create_routine', schedule: { kind: 'daily_local', time: '09:00', nextDate: '2026-10-09' } }).success).toBe(false);
  });

  it('rejects offset zones and invalid local times, dates, or anchors', () => {
    expect(() => validateDailyLocalSchedule('+05:00', '09:00', 0)).toThrow();
    expect(() => validateDailyLocalSchedule('UTC', '24:00', 0)).toThrow();
    expect(() => validateDailyLocalSchedule('UTC', '09:00', 0.5)).toThrow();
    expect(() => validateDailyLocalSchedule('UTC', '09:00', Number.MAX_SAFE_INTEGER)).toThrow();
    expect(() => resolveDailyLocalAt('2026-02-29', 'UTC', '09:00')).toThrow();
    expect(() => latestDailyLocalCursor({ at: 0, date: 'invalid' }, 1, 'UTC', '09:00')).toThrow();
    expect(() => firstDailyLocalAtOrAfter(Date.parse('+010000-01-01T00:00:00Z'), 'UTC', '09:00')).toThrow();
    expect(() => dailyLocalCandidates(Date.parse('9999-12-31T00:00:00Z'), 'UTC', '09:00')).toThrow();
  });
});
