import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { build } from 'vite';
import { generateSnapshots } from '../server/snapshots.js';
import { snapshotPath } from '../src/snapshots.js';
import type { ForecastGrid } from '../src/grid.js';
import type { Dataset, ObservationHistory, Station } from '../src/weather.js';

const now = new Date('2026-11-04T10:17:00.000Z');
const run = '2026-11-04T06:00:00.000Z';
const hours = ['2026-11-04T09:00:00.000Z', '2026-11-04T10:00:00.000Z', '2026-11-04T11:00:00.000Z'];
const stations: Station[] = [{ id: 'TEST', name: 'Test station', canton: 'BE', elevation: 1000, latitude: 47, longitude: 8 }];

function fixture() {
  let historyCalls = 0;
  const gridCalls: string[] = [];
  const loaders = {
    stations: async () => stations,
    observations: async () => ({}),
    forecasts: async () => ({}),
    history: async (): Promise<ObservationHistory> => {
      historyCalls++;
      return { series: { TEST: [] }, unavailable: [{ stationId: 'OTHER', message: 'Provider unavailable.' }] };
    },
    index: async () => ({ referenceTime: run, hours, resolutionKm: 1.1 }),
    grid: async (time: string, referenceTime: string): Promise<ForecastGrid> => {
      gridCalls.push(time);
      return {
        time, referenceTime, resolutionKm: 1.1, gridId: 'test',
        width: 1, height: 1, west: 0, north: 0, cellSize: 1500,
        bounds: [[46, 8], [47, 9]], elevation: [1000], isDay: [true],
        sunshine: [45], lowCloud: [20], cloud: [30], temperature: [5],
      };
    },
  };
  return { loaders, gridCalls, historyCalls: () => historyCalls };
}

test('snapshot paths cover every endpoint under the project-relative weather directory', () => {
  for (const name of ['stations', 'observations', 'forecasts', 'history', 'grid-index']) {
    assert.equal(snapshotPath(`/api/${name}`), `weather/${name}.json`);
  }
  assert.equal(snapshotPath(`/api/grid?${new URLSearchParams({ time: hours[1], run })}`),
    'weather/grids/20261104T060000.000Z/20261104T100000.000Z.json');
  for (const path of ['/api/unknown', '/api/history?date=bad', '/api/grid', '/api/grid?time=../../secret&run=bad',
    '/api/grid?time=2026-02-30T10:00:00.000Z&run=2026-11-04T06:00:00.000Z']) {
    assert.throws(() => snapshotPath(path));
  }
});

test('the production client uses Pages-relative snapshots while API mode keeps the external origin', async () => {
  for (const snapshot of [true, false]) {
    const result = await build({
      configFile: false,
      logLevel: 'silent',
      base: '/WhereDoesTheSunShine/',
      define: {
        'import.meta.env.VITE_DATA_MODE': JSON.stringify(snapshot ? 'snapshot' : ''),
        'import.meta.env.VITE_API_BASE_URL': JSON.stringify('https://weather.example.test/'),
      },
      build: { write: false, minify: false, lib: { entry: 'src/api.ts', formats: ['es'] } },
    });
    assert.ok(!('on' in result));
    const output = (Array.isArray(result) ? result[0] : result).output;
    const chunk = output.find((item) => item.type === 'chunk');
    assert.ok(chunk?.type === 'chunk');
    const client = await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`);
    assert.equal(client.snapshotMode, snapshot);
    assert.equal(client.apiUrl('/api/stations'), snapshot
      ? '/WhereDoesTheSunShine/weather/stations.json' : 'https://weather.example.test/api/stations');
    const gridPath = `/api/grid?${new URLSearchParams({ time: hours[1], run })}`;
    assert.equal(client.apiUrl(gridPath), snapshot
      ? `/WhereDoesTheSunShine/${snapshotPath(gridPath)}` : `https://weather.example.test${gridPath}`);
  }
});

test('generation writes dataset envelopes and every advertised grid from the same run', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'sunward-snapshots-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const { loaders, gridCalls } = fixture();
  await generateSnapshots({ output: directory, historyFile: join(directory, 'saved-history.json'), now, loaders });
  const read = async (path: string) => JSON.parse(await readFile(join(directory, snapshotPath(path)), 'utf8'));
  assert.deepEqual(await read('/api/stations'), { fetchedAt: now.toISOString(), data: stations });
  for (const name of ['observations', 'forecasts', 'history']) {
    assert.equal((await read(`/api/${name}`)).fetchedAt, now.toISOString());
  }
  const index = await read('/api/grid-index');
  assert.deepEqual(index.data.hours, hours.slice(1));
  assert.deepEqual(gridCalls, index.data.hours);
  for (const time of index.data.hours) {
    const snapshot = await read(`/api/grid?${new URLSearchParams({ time, run })}`);
    assert.equal(snapshot.data.time, time);
    assert.equal(snapshot.data.referenceTime, index.data.referenceTime);
  }
  assert.equal((await read('/api/history')).data.unavailable[0].stationId, 'OTHER');
});

test('history is reused within a Swiss day, preserves its timestamp, and refreshes at Swiss midnight', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'sunward-history-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const historyFile = join(directory, 'saved-history.json');
  const first = fixture();
  await generateSnapshots({ output: directory, historyFile, now, loaders: first.loaders });
  assert.equal(first.historyCalls(), 1);
  const second = fixture();
  second.loaders.index = async () => ({ referenceTime: run, hours: ['2026-11-04T23:00:00.000Z'], resolutionKm: 1.1 });
  await generateSnapshots({ output: directory, historyFile, now: new Date('2026-11-04T22:17:00Z'), loaders: second.loaders });
  assert.equal(second.historyCalls(), 0);
  const saved: Dataset<ObservationHistory> = JSON.parse(await readFile(historyFile, 'utf8'));
  assert.equal(saved.fetchedAt, now.toISOString());
  const third = fixture();
  third.loaders.index = second.loaders.index;
  await generateSnapshots({ output: directory, historyFile, now: new Date('2026-11-04T23:17:00Z'), loaders: third.loaders });
  assert.equal(third.historyCalls(), 1);
});

test('collection errors and incomplete or mismatched native runs reject rather than publish an index', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'sunward-failure-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const options = { output: directory, historyFile: join(directory, 'saved-history.json'), now };
  const failedGrid = fixture().loaders;
  failedGrid.grid = async () => { throw new Error('Native provider unavailable'); };
  await assert.rejects(generateSnapshots({ ...options, loaders: failedGrid }), /Native provider unavailable/);
  await assert.rejects(readFile(join(directory, snapshotPath('/api/grid-index'))), { code: 'ENOENT' });
  const emptyIndex = fixture().loaders;
  emptyIndex.index = async () => ({ referenceTime: run, hours: [hours[0]], resolutionKm: 1.1 });
  await assert.rejects(generateSnapshots({ ...options, loaders: emptyIndex }), /No current or future/);
  const mismatchedGrid = fixture().loaders;
  const original = mismatchedGrid.grid;
  mismatchedGrid.grid = async (time, referenceTime) => ({ ...await original(time, referenceTime), referenceTime: hours[0] });
  await assert.rejects(generateSnapshots({ ...options, loaders: mismatchedGrid }), /does not match/);
  const failedForecast = fixture().loaders;
  failedForecast.forecasts = async () => { throw new Error('Forecast provider unavailable'); };
  await assert.rejects(generateSnapshots({ ...options, loaders: failedForecast }), /Forecast provider unavailable/);
});

test('corrupt saved history fails explicitly instead of silently publishing empty history', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'sunward-corrupt-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const historyFile = join(directory, 'saved-history.json');
  await writeFile(historyFile, JSON.stringify({ fetchedAt: 'bad', data: {} }));
  await assert.rejects(generateSnapshots({ output: directory, historyFile, now, loaders: fixture().loaders }), /invalid/);
});
