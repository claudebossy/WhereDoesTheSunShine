import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { snapshotPath } from '../src/snapshots.js';
import { swissDate, type Dataset, type ObservationHistory, type Station } from '../src/weather.js';
import { loadForecasts, OBSERVATIONS_URL, parseObservations, parseStations, STATIONS_URL, upstream } from './data.js';
import { loadHistory } from './history.js';
import { getForecastGrid, getGridIndex } from './native-grid.js';

const sources = {
  stations: async () => parseStations(await upstream(STATIONS_URL, true)),
  observations: async (stations: Station[]) => parseObservations(await upstream(OBSERVATIONS_URL), stations),
  forecasts: loadForecasts,
  history: loadHistory,
  index: getGridIndex,
  grid: getForecastGrid,
};

async function savedHistory(path: string): Promise<Dataset<ObservationHistory> | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
  const value: Dataset<ObservationHistory> = JSON.parse(text);
  if (!Number.isFinite(Date.parse(value.fetchedAt)) || !value.data?.series || !Array.isArray(value.data.unavailable)) {
    throw new Error('Saved history snapshot is invalid.');
  }
  return value;
}

export async function generateSnapshots({
  output = 'dist', historyFile = '.snapshots/history.json', now = new Date(), loaders = sources,
}: {
  output?: string; historyFile?: string; now?: Date; loaders?: typeof sources;
} = {}): Promise<void> {
  const fetchedAt = now.toISOString();
  const write = async (path: string, value: unknown) => {
    const file = resolve(output, snapshotPath(path));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(value));
  };
  const stations = await loaders.stations();
  await write('/api/stations', { fetchedAt, data: stations });
  await write('/api/observations', { fetchedAt, data: await loaders.observations(stations) });
  await write('/api/forecasts', { fetchedAt, data: await loaders.forecasts(stations) });

  let history = await savedHistory(historyFile);
  if (!history || swissDate(history.fetchedAt) !== swissDate(fetchedAt)) {
    history = { fetchedAt, data: await loaders.history(stations, now.getTime()) };
    await mkdir(dirname(historyFile), { recursive: true });
    await writeFile(historyFile, JSON.stringify(history));
  }
  await write('/api/history', history);

  const index = await loaders.index();
  const hours = index.hours.filter((time) => Date.parse(time) >= Math.floor(now.getTime() / 3_600_000) * 3_600_000);
  if (!hours.length) throw new Error('No current or future native forecast hours are available for the snapshot.');
  for (const time of hours) {
    console.log(`[snapshot] Native grid ${time}`);
    const data = await loaders.grid(time, index.referenceTime);
    if (data.time !== time || data.referenceTime !== index.referenceTime) throw new Error('Snapshot grid does not match the advertised model run and hour.');
    await write(`/api/grid?${new URLSearchParams({ time, run: index.referenceTime })}`, { fetchedAt, data });
  }
  await write('/api/grid-index', { fetchedAt, data: { ...index, hours } });
  console.log(`[snapshot] Published ${hours.length} native grids; history fetched ${history.fetchedAt}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await generateSnapshots();
}
