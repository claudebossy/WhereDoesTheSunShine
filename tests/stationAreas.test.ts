import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stationAreas, STATION_AREA_RADIUS_METRES } from '../src/stationAreas.js';
import { classify, hourAtTime, type Conditions, type Station } from '../src/weather.js';

const station: Station = { id: 'TEST', name: 'Test', canton: 'BE', elevation: 1200, latitude: 46.8, longitude: 8.2 };
const now = Date.parse('2026-11-12T11:00:00.000Z');
const conditions: Conditions = { time: new Date(now).toISOString(), sunshineMinutes: 10, temperature: 5, lowCloud: null, cloud: null, isDay: true };

test('station shading is bounded to an illustrative five-kilometre radius', () => {
  assert.equal(STATION_AREA_RADIUS_METRES, 5000);
});

test('only usable station sunshine readings are shaded, without filling missing or stale data', () => {
  const values = [
    conditions,
    { ...conditions, sunshineMinutes: 4 },
    { ...conditions, sunshineMinutes: 0 },
    { ...conditions, sunshineMinutes: 0, isDay: false },
    { ...conditions, sunshineMinutes: null },
    { ...conditions, sunshineMinutes: null, isDay: false },
    { ...conditions, sunshineMinutes: NaN },
    { ...conditions, time: new Date(now - 41 * 60_000).toISOString() },
    { ...conditions, time: new Date(now + 11 * 60_000).toISOString() },
    undefined,
  ];
  const readings = values.map((value) => ({ station, conditions: value, status: classify(value, 'observations', now) }));
  assert.deepEqual(stationAreas(readings).map(({ status }) => status), ['sunny', 'mixed', 'no-sun', 'night']);
});

test('history shading follows the selected hour and does not mark past measurements stale', () => {
  const sunny = { ...conditions, time: '2026-11-11T11:00:00.000Z', sunshineMinutes: 48 };
  const cloudy = { ...sunny, time: '2026-11-11T12:00:00.000Z', sunshineMinutes: 0 };
  const cases: [string, string | undefined][] = [[sunny.time, 'sunny'], [cloudy.time, 'no-sun'], ['2026-11-11T13:00:00.000Z', undefined]];
  for (const [time, expected] of cases) {
    const value = hourAtTime([sunny, cloudy], time);
    const areas = stationAreas([{ station, conditions: value, status: classify(value, 'history', now) }]);
    assert.equal(areas[0]?.status, expected);
  }
});

test('area selection preserves filtered stations and their original readings', () => {
  const reading = { station, conditions, status: classify(conditions, 'observations', now) };
  assert.deepEqual(stationAreas([]), []);
  assert.deepEqual(stationAreas([reading]), [reading]);
  assert.equal(stationAreas([reading])[0].conditions, conditions);
});
