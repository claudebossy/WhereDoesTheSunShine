import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, formatHistoryTime, historicalTimes, historyDays, hourAtTime, swissDate, swissMidnight, type Station } from '../src/weather.js';
import { hourlyTime, loadHistory, loadStationHistory, mergeHourly, parseHourly } from '../server/history.js';

const station: Station = { id: 'PIL', name: 'Pilatus', canton: 'OW', latitude: 46.978869, longitude: 8.252256, elevation: 2105 };
const header = 'station_abbr;reference_timestamp;tre200h0;sre000h0';
const csv = (rows: string[]) => `${header}\n${rows.join('\n')}\n`;
const now = Date.parse('2026-11-01T12:30:00Z');
const start = Date.parse('2026-10-29T23:00:00Z');

test('hourly observations use 48 minutes, without forecast cloud requirements or stale flags', () => {
  const reading = parseHourly(csv(['PIL;30.10.2026 11:00;5;48']), station)[0];
  assert.equal(classify(reading, 'history', now), 'sunny');
  assert.equal(classify(reading, 'observations', now), 'stale');
  assert.equal(classify({ ...reading, sunshineMinutes: 47.99 }, 'history', now), 'mixed');
  assert.equal(classify({ ...reading, sunshineMinutes: 0 }, 'history', now), 'no-sun');
  assert.equal(classify({ ...reading, sunshineMinutes: null }, 'history', now), 'unknown');
  assert.equal(classify(undefined, 'history', now), 'unknown');
});

test('hourly timestamps are validated UTC hour-ending timestamps', () => {
  assert.equal(hourlyTime('01.11.2026 11:00'), '2026-11-01T11:00:00.000Z');
  for (const value of ['30.02.2026 11:00', '01.13.2026 11:00', '01.11.2026 24:00', '01.11.2026 11:10', 'bad']) {
    assert.throws(() => hourlyTime(value), /Invalid hourly/);
  }
});

test('hourly parsing preserves missing values and validates station and schema', () => {
  const reading = parseHourly(csv(['PIL;01.11.2026 11:00;;']), station)[0];
  assert.equal(reading.temperature, null);
  assert.equal(reading.sunshineMinutes, null);
  assert.equal(reading.lowCloud, null);
  assert.equal(reading.cloud, null);
  const invalid = parseHourly(csv(['PIL;01.11.2026 11:00;-999;61']), station)[0];
  assert.equal(invalid.temperature, null);
  assert.equal(invalid.sunshineMinutes, null);
  assert.throws(() => parseHourly(csv(['SAE;01.11.2026 11:00;1;30']), station), /station mismatch/);
  assert.throws(() => parseHourly('new;schema\n1;2', station), /schema/);
  assert.throws(() => parseHourly('', station), /no header/);
  assert.deepEqual(parseHourly(`${header}\n`, station), []);
});

test('positive sunshine around sunset is not hidden by the hour midpoint', () => {
  const measuredSun = parseHourly(csv(['PIL;01.11.2026 18:00;3;5']), station)[0];
  const noSun = parseHourly(csv(['PIL;01.11.2026 18:00;3;0']), station)[0];
  assert.equal(measuredSun.isDay, true);
  assert.equal(classify(measuredSun, 'history'), 'mixed');
  assert.equal(noSun.isDay, false);
  assert.equal(classify(noSun, 'history'), 'night');
});

test('history dates are Swiss calendar dates across UTC midnight, months and leap years', () => {
  assert.equal(swissDate('2026-11-01T23:30:00Z'), '2026-11-02');
  assert.deepEqual(historyDays(Date.parse('2026-11-01T23:30:00Z')).map((day) => day.date), ['2026-11-02', '2026-11-01', '2026-10-31']);
  assert.deepEqual(historyDays(Date.parse('2024-03-01T12:00:00Z')).map((day) => day.date), ['2024-03-01', '2024-02-29', '2024-02-28']);
});

test('Swiss midnight uses the offset at the start of each calendar day', () => {
  assert.equal(new Date(swissMidnight('2026-11-01')).toISOString(), '2026-10-31T23:00:00.000Z');
  assert.equal(new Date(swissMidnight('2026-07-01')).toISOString(), '2026-06-30T22:00:00.000Z');
  assert.equal(new Date(swissMidnight('2026-03-29')).toISOString(), '2026-03-28T23:00:00.000Z');
  assert.equal(new Date(swissMidnight('2026-10-25')).toISOString(), '2026-10-24T22:00:00.000Z');
});

test('hourly timelines preserve 23/25-hour DST days and distinguish repeated hours', () => {
  const autumn = historicalTimes('2026-10-25', Date.parse('2026-10-26T12:00:00Z'));
  const spring = historicalTimes('2026-03-29', Date.parse('2026-03-30T12:00:00Z'));
  assert.equal(autumn.length, 25);
  assert.equal(new Set(autumn).size, 25);
  assert.equal(spring.length, 23);
  assert.notEqual(formatHistoryTime('2026-10-25T00:00:00Z'), formatHistoryTime('2026-10-25T01:00:00Z'));
  assert.ok(formatHistoryTime('2026-10-25T00:00:00Z').includes('02:00'));
  assert.ok(formatHistoryTime('2026-10-25T01:00:00Z').includes('02:00'));
});

test('today exposes only completed hours and preserves slots even when a reading is missing', () => {
  const times = historicalTimes('2026-11-01', now);
  assert.equal(times.length, 14);
  assert.equal(times.at(-1), '2026-11-01T12:00:00.000Z');
  assert.ok(times.every((time) => Date.parse(time) <= now));
  assert.deepEqual(historicalTimes('2026-11-02', now), []);
  assert.equal(hourAtTime([], times[5]), undefined);
});

test('merging history clips the requested window, sorts, and lets current readings override archives', () => {
  const archive = parseHourly(csv(['PIL;29.10.2026 22:00;3;0', 'PIL;30.10.2026 11:00;4;48', 'PIL;01.11.2026 11:00;5;48']), station);
  const current = parseHourly(csv(['PIL;01.11.2026 11:00;6;0', 'PIL;01.11.2026 13:00;7;60']), station);
  const result = mergeHourly([archive, current], start, now);
  assert.equal(result.length, 2);
  assert.equal(result[0].time, '2026-10-30T11:00:00.000Z');
  assert.equal(result[1].sunshineMinutes, 0);
  assert.equal(result[1].temperature, 6);
});

test('suffix ranges discard the partial first row and join recent history to current observations', async () => {
  const original = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requested.push(url);
    if (url.endsWith('now.csv')) return new Response(csv(['PIL;01.11.2026 11:00;6;0']));
    assert.equal(new Headers(init?.headers).get('Range'), 'bytes=-65536');
    return new Response('truncated;partial;row\nPIL;29.10.2026 23:00;4;0\nPIL;01.11.2026 11:00;5;48\n', {
      status: 206, headers: { 'Content-Range': 'bytes 100-200/201' },
    });
  };
  try {
    const result = await loadStationHistory(station, start, now);
    assert.equal(requested.length, 2);
    assert.equal(result.length, 2);
    assert.equal(result.at(-1)?.temperature, 6);
    assert.equal(result.at(-1)?.sunshineMinutes, 0);
  } finally { globalThis.fetch = original; }
});

test('ranges expand when the first suffix does not cover the requested dates', async () => {
  const original = globalThis.fetch;
  const ranges: string[] = [];
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith('now.csv')) return new Response(csv(['PIL;01.11.2026 11:00;6;0']));
    ranges.push(new Headers(init?.headers).get('Range')!);
    return ranges.length === 1
      ? new Response('partial\nPIL;31.10.2026 11:00;5;48\n', { status: 206, headers: { 'Content-Range': 'bytes 100-200/201' } })
      : new Response(csv(['PIL;29.10.2026 23:00;4;0', 'PIL;31.10.2026 11:00;5;48']), { status: 206, headers: { 'Content-Range': 'bytes 0-200/201' } });
  };
  try {
    assert.equal((await loadStationHistory(station, start, now)).length, 3);
    assert.deepEqual(ranges, ['bytes=-65536', 'bytes=-131072']);
  } finally { globalThis.fetch = original; }
});

test('servers ignoring Range are supported, and invalid partial metadata fails explicitly', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(csv(['PIL;30.10.2026 11:00;5;48']));
  try {
    assert.equal((await loadStationHistory(station, start, now)).length, 1);
    globalThis.fetch = async (input) => String(input).endsWith('now.csv')
      ? new Response(csv(['PIL;01.11.2026 11:00;6;0']))
      : new Response('partial\n', { status: 206 });
    await assert.rejects(loadStationHistory(station, start, now), /invalid range metadata/);
  } finally { globalThis.fetch = original; }
});

test('year rollover loads the correct prior-year decade archive', async () => {
  const original = globalThis.fetch;
  const requested: string[] = [];
  const yearNow = Date.parse('2027-01-02T12:00:00Z');
  const yearStart = swissMidnight('2026-12-31');
  globalThis.fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    if (url.endsWith('now.csv')) return new Response(csv(['PIL;02.01.2027 11:00;6;0']));
    if (url.endsWith('recent.csv')) return new Response(csv(['PIL;01.01.2027 11:00;4;48']));
    assert.ok(url.endsWith('historical_2020-2029.csv'));
    return new Response(csv(['PIL;30.12.2026 23:00;5;0', 'PIL;31.12.2026 11:00;5;48']));
  };
  try {
    const result = await loadStationHistory(station, yearStart, yearNow);
    assert.equal(requested.length, 3);
    assert.equal(result.length, 4);
    assert.equal(result[0].time, '2026-12-30T23:00:00.000Z');
  } finally { globalThis.fetch = original; }
});

test('history reports partial station failures and bounds upstream concurrency', async (context) => {
  const original = globalThis.fetch;
  context.mock.method(console, 'warn', () => {});
  const stations = Array.from({ length: 6 }, (_, index) => ({ ...station, id: `S${index}` }));
  let active = 0;
  let maxActive = 0;
  globalThis.fetch = async (input) => {
    active++;
    maxActive = Math.max(active, maxActive);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    const id = /\/(s\d)\/ogd-smn_/.exec(String(input))![1].toUpperCase();
    if (id === 'S2') return new Response('Unavailable', { status: 503 });
    return new Response(csv([`${id};30.10.2026 11:00;5;48`]));
  };
  try {
    const result = await loadHistory(stations, now);
    assert.equal(Object.keys(result.series).length, 5);
    assert.equal(result.unavailable.length, 1);
    assert.equal(result.unavailable[0].stationId, 'S2');
    assert.match(result.unavailable[0].message, /HTTP 503/);
    assert.ok(maxActive <= 4);
    assert.ok(maxActive > 1);
  } finally { globalThis.fetch = original; }
});

test('total history failure is an error, not an empty successful dataset', async (context) => {
  const original = globalThis.fetch;
  context.mock.method(console, 'warn', () => {});
  globalThis.fetch = async () => new Response('Unavailable', { status: 503 });
  try {
    await assert.rejects(loadHistory([station], now), /No historical observations/);
  } finally { globalThis.fetch = original; }
});
