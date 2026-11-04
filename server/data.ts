import { parse } from 'csv-parse/sync';
import { daylight, type Conditions, type Forecast, type Station } from '../src/weather.js';

type Row = Record<string, string>;
export const STATIONS_URL = 'https://data.geo.admin.ch/ch.meteoschweiz.ogd-smn/ogd-smn_meta_stations.csv';
export const OBSERVATIONS_URL = 'https://data.geo.admin.ch/ch.meteoschweiz.messwerte-aktuell/VQHA80.csv';

function rows(text: string, required: string[]): Row[] {
  let headers: string[] = [];
  const result: Row[] = parse(text, {
    delimiter: ';',
    bom: true,
    skip_empty_lines: true,
    columns: (columns: string[]) => {
      headers = columns;
      return columns;
    },
    trim: true,
  });
  if (required.some((column) => !headers.includes(column))) throw new Error('Upstream CSV schema has changed.');
  if (!result.length) throw new Error('Upstream CSV contains no data.');
  return result;
}

export function number(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim() || value.trim() === '-') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function ranged(value: unknown, min: number, max: number): number | null {
  const parsed = number(value);
  return parsed !== null && parsed >= min && parsed <= max ? parsed : null;
}

export function parseStations(text: string): Station[] {
  return rows(text, ['station_abbr', 'station_name', 'station_canton', 'station_height_masl', 'station_coordinates_wgs84_lat', 'station_coordinates_wgs84_lon']).map((row) => {
    const elevation = number(row.station_height_masl);
    const latitude = ranged(row.station_coordinates_wgs84_lat, 45, 49);
    const longitude = ranged(row.station_coordinates_wgs84_lon, 5, 11);
    if (elevation === null || latitude === null || longitude === null || !row.station_abbr || !row.station_name) {
      throw new Error(`Invalid metadata for station ${row.station_abbr || '(unnamed)'}.`);
    }
    return { id: row.station_abbr, name: row.station_name, canton: row.station_canton, elevation, latitude, longitude };
  });
}

export function observationTime(value: string): string {
  if (!/^\d{12}$/.test(value)) throw new Error(`Invalid observation timestamp: ${value}`);
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:00.000Z`;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== iso) throw new Error(`Invalid observation timestamp: ${value}`);
  return iso;
}

export function parseObservations(text: string, stations: Station[]): Record<string, Conditions> {
  const metadata = new Map(stations.map((station) => [station.id, station]));
  const result: Record<string, Conditions> = {};
  for (const row of rows(text, ['Station/Location', 'Date', 'sre000z0', 'tre200s0'])) {
    const station = metadata.get(row['Station/Location']);
    if (!station) continue;
    const time = observationTime(row.Date);
    if (result[station.id] && result[station.id].time >= time) continue;
    result[station.id] = {
      time,
      temperature: ranged(row.tre200s0, -90, 60),
      sunshineMinutes: ranged(row.sre000z0, 0, 10),
      lowCloud: null,
      cloud: null,
      isDay: daylight(time, station),
    };
  }
  if (!Object.keys(result).length) throw new Error('No observations match the station metadata.');
  return result;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid forecast response.');
  return value as Record<string, unknown>;
}

export function parseForecast(value: unknown, station: Station): Forecast {
  const response = object(value);
  const hourly = object(response.hourly);
  const times = hourly.time;
  const elevation = number(response.elevation);
  if (!Array.isArray(times) || !times.length || elevation === null || response.utc_offset_seconds !== 0) {
    throw new Error(`Invalid forecast metadata for ${station.id}.`);
  }
  const fields = ['temperature_2m', 'sunshine_duration', 'cloud_cover_low', 'cloud_cover', 'is_day'] as const;
  const values = Object.fromEntries(fields.map((field) => {
    const series = hourly[field];
    if (!Array.isArray(series) || series.length !== times.length) throw new Error(`Incomplete forecast field: ${field}.`);
    return [field, series];
  })) as Record<typeof fields[number], unknown[]>;
  return {
    stationId: station.id,
    modelElevation: elevation,
    hours: times.map((time: unknown, index: number) => {
      if (typeof time !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(time) || !Number.isFinite(Date.parse(`${time}Z`))) {
        throw new Error('Invalid forecast timestamp.');
      }
      if (values.is_day[index] !== 0 && values.is_day[index] !== 1) throw new Error('Invalid forecast daylight flag.');
      const sunshine = ranged(values.sunshine_duration[index], 0, 3600);
      return {
        time: new Date(`${time}Z`).toISOString(),
        temperature: ranged(values.temperature_2m[index], -90, 60),
        sunshineMinutes: sunshine === null ? null : sunshine / 60,
        lowCloud: ranged(values.cloud_cover_low[index], 0, 100),
        cloud: ranged(values.cloud_cover[index], 0, 100),
        isDay: values.is_day[index] === 1,
      };
    }),
  };
}

export async function upstream(url: string, latin1 = false): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(25_000) });
  if (!response.ok) throw new Error(`Weather provider returned HTTP ${response.status}.`);
  return latin1
    ? new TextDecoder('windows-1252').decode(await response.arrayBuffer())
    : response.text();
}

export async function loadForecasts(stations: Station[]): Promise<Record<string, Forecast>> {
  const result: Record<string, Forecast> = {};
  // Small sequential batches limit upstream traffic; a failed batch fails the dataset.
  for (let start = 0; start < stations.length; start += 25) {
    const batch = stations.slice(start, start + 25);
    const params = new URLSearchParams({
      latitude: batch.map((s) => s.latitude).join(','),
      longitude: batch.map((s) => s.longitude).join(','),
      elevation: batch.map((s) => s.elevation).join(','),
      hourly: 'temperature_2m,cloud_cover,cloud_cover_low,sunshine_duration,is_day',
      models: 'meteoswiss_icon_ch1',
      forecast_days: '3',
      timezone: 'GMT',
    });
    const json: unknown = JSON.parse(await upstream(`https://api.open-meteo.com/v1/forecast?${params}`));
    const responses = Array.isArray(json) ? json : [json];
    if (responses.length !== batch.length) throw new Error('Forecast provider returned an incomplete batch.');
    batch.forEach((station, index) => { result[station.id] = parseForecast(responses[index], station); });
  }
  return result;
}

export function cache<T>(load: () => Promise<T>, ttl: number): () => Promise<{ fetchedAt: string; data: T }> {
  let stored: { fetchedAt: string; data: T } | undefined;
  let pending: Promise<{ fetchedAt: string; data: T }> | undefined;
  let retryAfter = 0;
  let lastError: unknown;
  return async () => {
    if (stored && Date.now() - Date.parse(stored.fetchedAt) < ttl) return stored;
    if (pending) return pending;
    if (Date.now() < retryAfter) throw lastError;
    pending = load().then((data) => {
      stored = { fetchedAt: new Date().toISOString(), data };
      return stored;
    }).catch((error: unknown) => {
      lastError = error;
      retryAfter = Date.now() + 60_000;
      throw error;
    }).finally(() => { pending = undefined; });
    return pending;
  };
}
