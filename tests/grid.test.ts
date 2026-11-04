import assert from 'node:assert/strict';
import { test } from 'node:test';
import wasm from '@meri-imperiumi/eccodes-wasm';
import { gridCell, gridConditions, project, rasterPixels, unproject, type ForecastGrid } from '../src/grid.js';
import { hourlySunshine, parseModelAssets } from '../server/native-grid.js';

const [west, north] = project(8, 47);
const grid: ForecastGrid = {
  time: '2026-11-02T11:00:00.000Z',
  referenceTime: '2026-11-01T18:00:00.000Z',
  resolutionKm: 1.1, gridId: '17643da2574959b644d254a3cd6e2bc0',
  width: 2, height: 2, west, north, cellSize: 1500,
  bounds: [[46.98, 8], [47, 8.03]],
  sunshine: [60, 0, null, 0],
  lowCloud: [0, 80, null, 0],
  cloud: [0, 80, null, 0],
  temperature: [3, 8, null, 2],
  elevation: [2000, 500, 1000, 1200],
  isDay: [true, true, true, false],
};

test('map projection round-trips Swiss coordinates and display pixels stay around 1 km on the ground', () => {
  for (const [longitude, latitude] of [[5.95, 45.75], [10.5, 47.85], [8.2, 46.8]]) {
    const restored = unproject(...project(longitude, latitude));
    assert.ok(Math.abs(restored[0] - longitude) < 1e-8);
    assert.ok(Math.abs(restored[1] - latitude) < 1e-8);
    const groundMetres = 1500 * Math.cos(latitude * Math.PI / 180);
    assert.ok(groundMetres >= 1000 && groundMetres <= 1100);
  }
});

test('point inspection chooses the correct north-to-south raster cell', () => {
  for (let cell = 0; cell < 4; cell++) {
    const [longitude, latitude] = unproject(west + (cell % 2 + 0.5) * 1500, north - (Math.floor(cell / 2) + 0.5) * 1500);
    assert.equal(gridCell(grid, latitude, longitude), cell);
  }
  const [longitude, latitude] = unproject(west - 100, north);
  assert.equal(gridCell(grid, latitude, longitude), undefined);
  assert.equal(gridConditions(grid, 0)?.sunshineMinutes, 60);
  assert.equal(gridConditions(grid, 2)?.sunshineMinutes, null);
  assert.equal(gridConditions(grid, 10), undefined);
  assert.equal(gridConditions({ ...grid, elevation: [null, 500, 1000, 1200] }, 0), undefined);
});

test('raster colours represent sunny, cloudy, missing and night cells rather than station interpolation', () => {
  const pixels = rasterPixels(grid, 0, false);
  assert.equal(pixels.length, 16);
  assert.deepEqual([...pixels.slice(0, 4)], [229, 165, 27, 175]);
  assert.deepEqual([...pixels.slice(4, 8)], [134, 155, 167, 175]);
  assert.deepEqual([...pixels.slice(8, 12)], [181, 181, 173, 175]);
  assert.deepEqual([...pixels.slice(12, 16)], [101, 115, 140, 175]);
});

test('sunshine and model-altitude filters preserve transparency for excluded pixels', () => {
  const sunny = rasterPixels(grid, 0, true);
  assert.equal(sunny[3], 175);
  for (const alpha of [7, 11, 15]) assert.equal(sunny[alpha], 0);
  const altitude = rasterPixels(grid, 1000, false);
  assert.equal(altitude[3], 175);
  assert.equal(altitude[7], 0);
  assert.equal(altitude[11], 175);
  const missing = rasterPixels({ ...grid, elevation: [null, 500, 1000, 1200] }, 0, false);
  assert.equal(missing[3], 0);
});

test('sunshine uses the difference of cumulative seconds, not the cumulative total as an hourly value', () => {
  assert.equal(hourlySunshine(10_800, 7200), 60);
  assert.equal(hourlySunshine(9900, 7200), 45);
  assert.equal(hourlySunshine(7200, 7200), 0);
  assert.equal(hourlySunshine(null, 7200), null);
  assert.equal(hourlySunshine(7200, null), null);
  assert.equal(hourlySunshine(7199.5, 7200), 0);
  assert.equal(hourlySunshine(10_800.5, 7200), 60);
  assert.throws(() => hourlySunshine(7000, 7200), /accumulation difference/);
  assert.throws(() => hourlySunshine(11_000, 7200), /accumulation difference/);
  assert.throws(() => hourlySunshine(NaN, 7200), /accumulation difference/);
});

const feature = () => ({
  properties: {
    datetime: '2026-11-02T11:00:00Z',
    'forecast:reference_datetime': '2026-11-01T18:00:00Z',
    'forecast:variable': 'CLCL',
    'forecast:perturbed': false,
  },
  assets: { 'cloud.grib2': { href: 'https://rgw.cscs.ch/public.grib2' } },
});

test('native STAC metadata normalizes time and requires a control forecast from the official host', () => {
  const parsed = parseModelAssets({ features: [feature()] });
  assert.equal(parsed[0].time, grid.time);
  assert.equal(parsed[0].referenceTime, grid.referenceTime);
  assert.equal(parsed[0].variable, 'CLCL');
  const ensemble = feature();
  ensemble.properties['forecast:perturbed'] = true;
  assert.throws(() => parseModelAssets({ features: [ensemble] }), /control forecast/);
  const wrongHost = feature();
  wrongHost.assets['cloud.grib2'].href = 'https://example.test/model.grib';
  assert.throws(() => parseModelAssets({ features: [wrongHost] }), /asset host/);
  const invalidTime = feature();
  invalidTime.properties.datetime = 'broken';
  assert.throws(() => parseModelAssets({ features: [invalidTime] }), /timestamp/);
  assert.throws(() => parseModelAssets({ error: 'provider unavailable' }), /feature list/);
});

test('ecCodes decodes an actual MeteoSwiss native-grid constant-packed GRIB on Node', async () => {
  // Source: MeteoSwiss OGD, ICON-CH1 control DURSUN at lead zero, 2026-11-01 18 UTC.
  const fixture = Buffer.from('R1JJQv//AAIAAAAAAAAAxwAAABUBANcA/w8BAQfqCwESAAABBQAAAB4CAP0AB+oLARMJEQAAAAAAAAAAAQABAAD//wAAACMDAAARhEwAAABlBgAAAQEXZD2iV0lZtkTSVKPNbivAAAAAPQQAAAALBiEEAI0AAAAAAAAAAAEAAAAAAP///////8AACwfqCwESAAABAAAAAAECAAAAAAD/AAAAAAAAABUFABGETAAAAAAAAIAKAAAAAAAAAAYG/wAAAAUHNzc3Nw==', 'base64');
  const api = await wasm.createEccodes();
  api.writeFile('/fixture.grib', fixture);
  let messages = 0;
  try {
    api.forEachMessage('/fixture.grib', (handle) => {
      messages++;
      assert.equal(handle.getString('uuidOfHGrid'), grid.gridId);
      assert.equal(handle.getLong('gridDefinitionTemplateNumber'), 101);
      assert.equal(handle.getLong('dataDate'), 20261101);
      assert.equal(handle.getLong('dataTime'), 1800);
      assert.equal(handle.getSize('values'), 1_147_980);
      assert.ok(handle.getDoubleArray('values').every((value) => value === 0));
    });
  } finally { api.writeFile('/fixture.grib', new Uint8Array()); }
  assert.equal(messages, 1);
});
