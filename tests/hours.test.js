/**
 * Hours-with-decimals.
 *
 * Every row in the database is whole minutes, but hours are what people think
 * in, so the conversion is the one place a half hour can be entered or lost.
 * These pin the shapes that actually get typed, and — more importantly — the
 * shapes that must be refused rather than silently read as a wrong number.
 *
 * ui.js is browser code with no DOM dependency in these functions, so it
 * imports cleanly under node:test.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseHoursInput, hoursToMinutes, minutesToHoursValue, minutes, minutesShort,
} from '../public/js/ui.js';

describe('reading typed hours', () => {
  // The headline case: 5.5 hours is five and a half hours, not 5 and not 6.
  test('a decimal is minutes, not a truncated hour', () => {
    assert.equal(parseHoursInput('5.5'), 330);
    assert.equal(parseHoursInput('0.5'), 30);
    assert.equal(parseHoursInput('0.25'), 15);
    assert.equal(parseHoursInput('2.75'), 165);
    assert.equal(parseHoursInput('1.1'), 66, 'rounds to the nearest minute');
  });

  test('a comma works as the decimal separator', () => {
    assert.equal(parseHoursInput('5,5'), 330);
    assert.equal(parseHoursInput('0,5'), 30);
  });

  test('the explicit unit forms all mean the same figure', () => {
    // All four are how one and a half hours gets written.
    assert.equal(parseHoursInput('1.5'), 90);
    assert.equal(parseHoursInput('1h30'), 90);
    assert.equal(parseHoursInput('1h 30m'), 90);
    assert.equal(parseHoursInput('1:30'), 90);
    assert.equal(parseHoursInput('90m'), 90);
    assert.equal(parseHoursInput('90 min'), 90);
  });

  test('hours on their own, with or without a unit', () => {
    assert.equal(parseHoursInput('2'), 120);
    assert.equal(parseHoursInput('2h'), 120);
    assert.equal(parseHoursInput('2 hours'), 120);
    assert.equal(parseHoursInput('24'), 1440);
  });

  test('whitespace and case are tolerated', () => {
    assert.equal(parseHoursInput('  5.5  '), 330);
    assert.equal(parseHoursInput('5.5'), 330);
    assert.equal(parseHoursInput('5H30M'), 330, 'units are case-insensitive');
    assert.equal(parseHoursInput('1 H 30 M'), 90);
  });

  test('a bare number is never read as minutes', () => {
    // The bug this guards: making the 'm' optional in the minutes-only pattern
    // let it swallow every bare number, so 6 became six minutes. A bare figure
    // is hours, always — minutes need the unit spelled out.
    assert.equal(parseHoursInput('6'), 360, '6 means six hours');
    assert.equal(parseHoursInput('90'), 5400, '90 means ninety hours; 90m is the minute form');
    assert.equal(parseHoursInput('0'), 0);
  });

  test('nonsense is refused rather than read as a wrong number', () => {
    // Null means "could not read this", which the field turns into a visible
    // error instead of saving zero.
    for (const bad of ['', '   ', 'abc', '-5', '5.5.5', '5..5', '1e3', '5 5', '--', 'NaN', 'Infinity']) {
      assert.equal(parseHoursInput(bad), null, `${JSON.stringify(bad)} must be refused`);
    }
  });

  test('a negative figure is refused rather than clamped', () => {
    assert.equal(parseHoursInput('-5'), null);
    assert.equal(parseHoursInput('-0.5'), null);
  });
});

describe('converting hours to minutes', () => {
  test('multiplies by sixty and rounds to a whole minute', () => {
    assert.equal(hoursToMinutes(5.5), 330);
    assert.equal(hoursToMinutes('5,5'), 330);
    assert.equal(hoursToMinutes(0), 0);
    assert.equal(hoursToMinutes(1), 60);
  });

  test('agrees with parseHoursInput on the same input', () => {
    // Two converters for one job is how they drift apart.
    for (const input of ['5.5', '5,5', '1h30', '1:30', '90m', '2', '2h', '0.25']) {
      assert.equal(
        hoursToMinutes(input),
        parseHoursInput(input),
        `${input} must convert the same way through both`,
      );
    }
  });

  test('bounds a day to twenty-four hours', () => {
    assert.equal(hoursToMinutes(24), 1440);
    assert.equal(hoursToMinutes(99), 1440, 'clamped, not rejected');
    assert.equal(hoursToMinutes(25, { maxHours: 12 }), 720);
  });

  test('an empty or unusable input is null, not zero', () => {
    // Zero is a real value somebody can mean; null means "not a number", and
    // conflating them would let a blank field save as zero.
    for (const bad of [null, undefined, '', 'abc', -1]) {
      assert.equal(hoursToMinutes(bad), null, `${JSON.stringify(bad)} must be null`);
    }
  });
});

describe('showing minutes back as hours', () => {
  test('a figure survives the round trip', () => {
    for (const m of [0, 1, 15, 30, 45, 60, 90, 330, 435, 480, 1440]) {
      const shown = minutesToHoursValue(m);
      assert.equal(parseHoursInput(shown), m, `${m}m shows as "${shown}" and reads back`);
    }
  });

  test('a half hour is shown as exactly 1.5, never 1.499999', () => {
    assert.equal(minutesToHoursValue(90), '1.5');
    assert.equal(minutesToHoursValue(330), '5.5');
  });

  test('trailing zeros are dropped', () => {
    assert.equal(minutesToHoursValue(60), '1', 'not 1.00');
    assert.equal(minutesToHoursValue(480), '8');
  });

  test('zero round-trips as 0 rather than blank', () => {
    // A blank field is ambiguous between "nothing" and "not filled in yet".
    assert.equal(minutesToHoursValue(0), '0');
    assert.equal(parseHoursInput(minutesToHoursValue(0)), 0);
  });

  test('minutes are still displayed in hours and minutes', () => {
    // The field echoes the figure back in the units the rest of the app uses,
    // so 5.5 reads as 5h 30m the moment it is typed.
    assert.equal(minutes(330), '5h 30m');
    assert.equal(minutes(90), '1h 30m');
    assert.equal(minutes(60), '1h 00m');
    assert.equal(minutes(45), '45m');
    assert.equal(minutes(0), '0m');
    assert.equal(minutesShort(330), '5h30m');
  });
});