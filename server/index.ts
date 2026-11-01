import express from 'express';
import { fileURLToPath } from 'node:url';
import { cache, loadForecasts, OBSERVATIONS_URL, parseObservations, parseStations, STATIONS_URL, upstream } from './data.js';
import { loadHistory } from './history.js';
import { forecastGrid, gridIndex } from './grid-service.js';

const app = express();
app.disable('x-powered-by');

const stations = cache(async () => parseStations(await upstream(STATIONS_URL, true)), 24 * 60 * 60_000);
const observations = cache(async () => parseObservations(await upstream(OBSERVATIONS_URL), (await stations()).data), 2 * 60_000);
const forecasts = cache(async () => loadForecasts((await stations()).data), 30 * 60_000);
const history = cache(async () => loadHistory((await stations()).data), 15 * 60_000);

app.get('/api/stations', async (_request, response) => { response.json(await stations()); });
app.get('/api/observations', async (_request, response) => { response.json(await observations()); });
app.get('/api/forecasts', async (_request, response) => { response.json(await forecasts()); });
app.get('/api/history', async (_request, response) => { response.json(await history()); });
app.get('/api/grid-index', async (_request, response) => {
  response.json({ fetchedAt: new Date().toISOString(), data: await gridIndex() });
});
app.get('/api/grid', async (request, response) => {
  const { time, run } = request.query;
  const valid = (value: unknown): value is string => typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  if (!valid(time) || !valid(run)) {
    response.status(400).json({ error: 'Grid time and run must be valid UTC hourly timestamps.' });
    return;
  }
  response.json({ fetchedAt: new Date().toISOString(), data: await forecastGrid(time, run) });
});
app.use('/api', (_request, response) => { response.status(404).json({ error: 'Unknown API endpoint.' }); });

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
app.use(express.static(dist));
app.get('/{*path}', (_request, response) => { response.sendFile(`${dist}index.html`); });
app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  console.error('[weather-api]', error);
  response.status(502).json({ error: 'Weather data could not be loaded. Please retry in a minute. No substitute or demo data are being shown.' });
});

const port = Number(process.env.PORT || 3001);
app.listen(port, '127.0.0.1', () => { console.log(`Sunward running at http://127.0.0.1:${port}`); });
