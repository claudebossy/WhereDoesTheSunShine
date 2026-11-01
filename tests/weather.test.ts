import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, daylight, forecastHour, formatTime, type Conditions, type Station } from '../src/weather.js';
import { cache, loadForecasts, number, observationTime, parseForecast, parseObservations, parseStations, upstream } from '../server/data.js';

const station: Station = { id: 'PIL', name: 'Pilatus', canton: 'LU', latitude: 46.978869, longitude: 8.252256, elevation: 2106 };
const noon = '2026-11-01T11:00:00.000Z';
const conditions: Conditions = { time: noon, temperature: 5, sunshineMinutes: 8, cloud: null, lowCloud: null, isDay: true };
const forecastConditions: Conditions = { ...conditions, sunshineMinutes: 45, cloud: 40, lowCloud: 25 };
const now = Date.parse(noon) + 5 * 60_000;

test('observed sunshine uses exact 8-minute threshold, not altitude', () => {
  assert.equal(classify(conditions, 'observations', now), 'sunny');
  assert.equal(classify({ ...conditions, sunshineMinutes: 7.99 }, 'observations', now), 'mixed');
  assert.equal(classify({ ...conditions, sunshineMinutes: 0.01 }, 'observations', now), 'mixed');
  assert.equal(classify({ ...conditions, sunshineMinutes: 0 }, 'observations', now), 'no-sun');
});

test('missing measurements are not interpreted as no sunshine', () => {
  assert.equal(classify(undefined, 'observations', now), 'unknown');
  assert.equal(classify({ ...conditions, sunshineMinutes: null }, 'observations', now), 'unknown');
  assert.equal(classify({ ...conditions, sunshineMinutes: NaN }, 'observations', now), 'unknown');
  assert.equal(classify({ ...conditions, time: 'broken' }, 'observations', now), 'unknown');
});

test('stale and future observations do not appear live', () => {
  assert.equal(classify(conditions, 'observations', Date.parse(noon) + 40 * 60_000), 'sunny');
  assert.equal(classify(conditions, 'observations', Date.parse(noon) + 40 * 60_000 + 1), 'stale');
  assert.equal(classify(conditions, 'observations', Date.parse(noon) - 11 * 60_000), 'stale');
  assert.equal(classify({ ...conditions, isDay: false }, 'observations', Date.parse(noon) + 41 * 60_000), 'stale');
});

test('nighttime cannot be classified as sunshine or fog', () => {
  assert.equal(classify({ ...conditions, isDay: false }, 'observations', now), 'night');
  assert.equal(classify({ ...forecastConditions, isDay: false }, 'forecast', now), 'night');
  assert.equal(daylight(noon, station), true);
  assert.equal(daylight('2026-11-01T23:00:00.000Z', station), false);
});

test('forecast sunny thresholds require all three variables', () => {
  assert.equal(classify(forecastConditions, 'forecast'), 'sunny');
  assert.equal(classify({ ...forecastConditions, sunshineMinutes: 44.99 }, 'forecast'), 'mixed');
  assert.equal(classify({ ...forecastConditions, lowCloud: 25.01 }, 'forecast'), 'mixed');
  assert.equal(classify({ ...forecastConditions, cloud: 40.01 }, 'forecast'), 'mixed');
  assert.equal(classify({ ...forecastConditions, lowCloud: null }, 'forecast'), 'unknown');
  assert.equal(classify({ ...forecastConditions, cloud: null }, 'forecast'), 'unknown');
});

test('low-cloud risk is separate from higher cloud and zero sun', () => {
  assert.equal(classify({ ...forecastConditions, lowCloud: 60, sunshineMinutes: 2 }, 'forecast'), 'low-cloud');
  assert.equal(classify({ ...forecastConditions, lowCloud: 59.99, sunshineMinutes: 2 }, 'forecast'), 'no-sun');
  assert.equal(classify({ ...forecastConditions, lowCloud: 60, sunshineMinutes: 2.01 }, 'forecast'), 'mixed');
  assert.equal(classify({ ...forecastConditions, lowCloud: 5, cloud: 90, sunshineMinutes: 0 }, 'forecast'), 'no-sun');
});

test('Swiss display times handle both winter, summer and repeated DST hours', () => {
  assert.equal(formatTime(noon), '12:00');
  assert.equal(formatTime('2026-07-01T11:00:00.000Z'), '13:00');
  assert.equal(formatTime('2026-10-25T00:00:00.000Z'), '02:00');
  assert.equal(formatTime('2026-10-25T01:00:00.000Z'), '02:00');
});

test('numeric missing and invalid values remain null', () => {
  for (const value of ['', ' ', '-', 'NaN', 'bad', null, undefined, Infinity]) assert.equal(number(value), null);
  assert.equal(number('0.00'), 0);
  assert.equal(number('-4.2'), -4.2);
});

test('MeteoSwiss compact timestamps are validated and interpreted as UTC', () => {
  assert.equal(observationTime('202611011100'), noon);
  for (const value of ['202602301100', '202613011100', '202611012500', '2026110111', 'bad']) {
    assert.throws(() => observationTime(value), /Invalid observation timestamp/);
  }
});

test('station CSV preserves accented names and rejects changed schemas', () => {
  const csv = 'station_abbr;station_name;station_canton;station_height_masl;station_coordinates_wgs84_lat;station_coordinates_wgs84_lon\nSAE;Säntis;AI;2501;47.249;9.343\n';
  const parsed = parseStations(csv);
  assert.equal(parsed[0].name, 'Säntis');
  assert.equal(parsed[0].elevation, 2501);
  assert.throws(() => parseStations('new_schema;name\nPIL;Pilatus'), /schema/);
  assert.throws(() => parseStations(csv.replace('47.249', '-')), /Invalid metadata/);
});

test('observations join by station ID, preserve missing sunshine and reject invalid ranges', () => {
  const csv = 'Station/Location;Date;tre200s0;sre000z0\nPIL;202611011100;5.2;-\nOTHER;202611011100;2;10\n';
  const parsed = parseObservations(csv, [station]);
  assert.deepEqual(Object.keys(parsed), ['PIL']);
  assert.equal(parsed.PIL.sunshineMinutes, null);
  assert.equal(parsed.PIL.temperature, 5.2);
  assert.equal(parsed.PIL.isDay, true);
  assert.equal(parseObservations(csv.replace('5.2;-', '-;-1'), [station]).PIL.sunshineMinutes, null);
  assert.throws(() => parseObservations(csv, []), /No observations match/);
});

test('duplicate observations keep the latest measurement', () => {
  const csv = 'Station/Location;Date;tre200s0;sre000z0\nPIL;202611011100;5;10\nPIL;202611011050;4;0\n';
  assert.equal(parseObservations(csv, [station]).PIL.sunshineMinutes, 10);
});

const forecastResponse = () => ({
  utc_offset_seconds: 0,
  elevation: 2106,
  hourly: {
    time: ['2026-11-01T11:00', '2026-11-01T12:00'],
    temperature_2m: [5, null],
    sunshine_duration: [2700, null],
    cloud_cover_low: [25, null],
    cloud_cover: [40, null],
    is_day: [1, 1],
  },
});

test('forecast parses UTC, converts seconds to minutes and keeps nulls', () => {
  const result = parseForecast(forecastResponse(), station);
  assert.equal(result.stationId, 'PIL');
  assert.equal(result.hours[0].time, noon);
  assert.equal(result.hours[0].sunshineMinutes, 45);
  assert.equal(result.hours[1].sunshineMinutes, null);
  assert.equal(result.hours[1].lowCloud, null);
  assert.equal(forecastHour(result, noon), result.hours[0]);
  assert.equal(forecastHour(result, 'missing'), undefined);
});

test('forecast response fails explicitly for changed shapes or incomplete arrays', () => {
  assert.throws(() => parseForecast({ error: true }, station), /Invalid forecast/);
  const incomplete = forecastResponse();
  incomplete.hourly.cloud_cover = [];
  assert.throws(() => parseForecast(incomplete, station), /Incomplete forecast field/);
  assert.throws(() => parseForecast({ ...forecastResponse(), utc_offset_seconds: 3600 }, station), /Invalid forecast metadata/);
  const badDaylight = forecastResponse();
  badDaylight.hourly.is_day[0] = 3;
  assert.throws(() => parseForecast(badDaylight, station), /daylight/);
});

test('cache coalesces concurrent requests and reuses fresh data', async () => {
  let calls = 0;
  const load = cache(async () => { calls++; await new Promise((resolve) => setTimeout(resolve, 5)); return ['real-data']; }, 60_000);
  const [a, b] = await Promise.all([load(), load()]);
  assert.equal(calls, 1);
  assert.equal(a, b);
  assert.equal(await load(), a);
});

test('expired cache failure is not a success-shaped stale fallback', async () => {
  let calls = 0;
  const load = cache(async () => { calls++; if (calls > 1) throw new Error('provider unavailable'); return 'first'; }, 0);
  assert.equal((await load()).data, 'first');
  await assert.rejects(load(), /provider unavailable/);
  await assert.rejects(load(), /provider unavailable/);
  assert.equal(calls, 2, 'failure cooldown prevents a request storm');
});

test('forecast batches preserve station pairing and request the Swiss model in UTC', async () => {
  const original = globalThis.fetch;
  const locations = Array.from({ length: 26 }, (_, index) => ({ ...station, id: `S${index}` }));
  let requests = 0;
  globalThis.fetch = async (input) => {
    requests++;
    const url = new URL(String(input));
    assert.equal(url.searchParams.get('models'), 'meteoswiss_icon_ch1');
    assert.equal(url.searchParams.get('timezone'), 'GMT');
    assert.equal(url.searchParams.get('forecast_days'), '3');
    const count = url.searchParams.get('latitude')!.split(',').length;
    assert.ok(count <= 25);
    assert.equal(url.searchParams.get('longitude')!.split(',').length, count);
    assert.equal(url.searchParams.get('elevation')!.split(',').length, count);
    return Response.json(count === 1 ? forecastResponse() : Array.from({ length: count }, forecastResponse));
  };
  try {
    const result = await loadForecasts(locations);
    assert.equal(requests, 2);
    assert.equal(Object.keys(result).length, 26);
    assert.equal(result.S25.stationId, 'S25');
    assert.equal(result.S0.hours[0].sunshineMinutes, 45);
  } finally { globalThis.fetch = original; }
});

test('a failed forecast batch fails the dataset rather than hiding missing stations', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('Rate limited', { status: 429 });
  try {
    await assert.rejects(loadForecasts([station]), /HTTP 429/);
  } finally { globalThis.fetch = original; }
});

test('upstream decoder preserves Swiss characters and reports HTTP errors', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Uint8Array([83, 228, 110, 116, 105, 115]));
  try {
    assert.equal(await upstream('https://example.test/metadata', true), 'Säntis');
    globalThis.fetch = async () => new Response('Unavailable', { status: 503 });
    await assert.rejects(upstream('https://example.test/metadata'), /HTTP 503/);
  } finally { globalThis.fetch = original; }
});
