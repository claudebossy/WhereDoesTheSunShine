import { parse } from 'csv-parse/sync';
import { daylight, historyDays, swissMidnight, type Conditions, type ObservationHistory, type Station } from '../src/weather.js';
import { number, upstream } from './data.js';

type Row = Record<string, string>;

export function hourlyTime(value: string): string {
  const match = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):00$/.exec(value);
  if (!match) throw new Error(`Invalid hourly observation timestamp: ${value}`);
  const [, day, month, year, hour] = match;
  const iso = `${year}-${month}-${day}T${hour}:00:00.000Z`;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== iso) throw new Error(`Invalid hourly observation timestamp: ${value}`);
  return iso;
}

export function parseHourly(text: string, station: Station): Conditions[] {
  let hasHeader = false;
  const records: Row[] = parse(text, {
    delimiter: ';', bom: true, skip_empty_lines: true, trim: true,
    columns: (columns: string[]) => {
      hasHeader = true;
      for (const field of ['station_abbr', 'reference_timestamp', 'tre200h0', 'sre000h0']) {
        if (!columns.includes(field)) throw new Error(`Hourly observation schema is missing ${field}.`);
      }
      return columns;
    },
  });
  if (!hasHeader) throw new Error('Hourly observation file has no header.');
  return records.map((row) => {
    if (row.station_abbr !== station.id) throw new Error(`Hourly station mismatch for ${station.id}.`);
    const time = hourlyTime(row.reference_timestamp);
    const sunshine = number(row.sre000h0);
    const sunshineMinutes = sunshine !== null && sunshine >= 0 && sunshine <= 60 ? sunshine : null;
    const temperature = number(row.tre200h0);
    return {
      time,
      temperature: temperature !== null && temperature >= -90 && temperature <= 60 ? temperature : null,
      sunshineMinutes, lowCloud: null, cloud: null,
      isDay: (sunshineMinutes !== null && sunshineMinutes > 0) || daylight(new Date(Date.parse(time) - 30 * 60_000).toISOString(), station),
    };
  });
}

export function mergeHourly(series: Conditions[][], start: number, end: number): Conditions[] {
  const readings = new Map<string, Conditions>();
  for (const hours of series) {
    for (const hour of hours) {
      if (Date.parse(hour.time) >= start && Date.parse(hour.time) <= end) readings.set(hour.time, hour);
    }
  }
  return [...readings.values()].sort((a, b) => a.time.localeCompare(b.time));
}

async function loadTail(url: string, header: string, station: Station, start: number): Promise<Conditions[]> {
  let bytes = 65_536;
  while (true) {
    const response = await fetch(url, { headers: { Range: `bytes=-${bytes}` }, signal: AbortSignal.timeout(25_000) });
    if (!response.ok) throw new Error(`Historical provider returned HTTP ${response.status}.`);
    const text = new TextDecoder('windows-1252').decode(await response.arrayBuffer());
    const range = response.headers.get('content-range');
    if (response.status === 206 && (!range || !/^bytes \d+-\d+\/\d+$/.test(range))) {
      throw new Error('Historical provider returned invalid range metadata.');
    }
    const partial = response.status === 206 && range !== null && !/^bytes 0-/.test(range);
    if (partial && !text.includes('\n')) throw new Error('Historical range contains no complete CSV rows.');
    // Suffix ranges may start halfway through a CSV row; keep only whole rows.
    const csv = partial ? `${header}\n${text.slice(text.indexOf('\n') + 1)}` : text;
    const hours = parseHourly(csv, station);
    if (!partial || (hours.length && Date.parse(hours[0].time) <= start)) return hours;
    bytes *= 2;
    if (bytes > 16 * 1024 * 1024) throw new Error('Historical file range could not cover the requested dates.');
  }
}

export async function loadStationHistory(station: Station, start: number, now: number): Promise<Conditions[]> {
  const id = station.id.toLowerCase();
  const base = `https://data.geo.admin.ch/ch.meteoschweiz.ogd-smn/${id}/ogd-smn_${id}_h_`;
  const currentText = await upstream(`${base}now.csv`, true);
  const header = currentText.split(/\r?\n/, 1)[0];
  const current = parseHourly(currentText, station);
  const recent = await loadTail(`${base}recent.csv`, header, station, start);
  const series = [recent];
  const earliest = recent[0];
  const firstYear = new Date(start).getUTCFullYear();
  if (firstYear < new Date(now).getUTCFullYear() && (!earliest || Date.parse(earliest.time) > start)) {
    const decade = Math.floor(firstYear / 10) * 10;
    series.unshift(await loadTail(`${base}historical_${decade}-${decade + 9}.csv`, header, station, start));
  }
  series.push(current);
  return mergeHourly(series, start, now);
}

export async function loadHistory(stations: Station[], now = Date.now()): Promise<ObservationHistory> {
  const start = swissMidnight(historyDays(now)[2].date);
  const result: ObservationHistory = { series: {}, unavailable: [] };
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, stations.length) }, async () => {
    while (next < stations.length) {
      const station = stations[next++];
      try {
        result.series[station.id] = await loadStationHistory(station, start, now);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Historical observations could not be loaded.';
        console.warn('[observation-history]', station.id, message);
        result.unavailable.push({ stationId: station.id, message });
      }
    }
  }));
  if (!Object.values(result.series).some((hours) => hours.length)) throw new Error('No historical observations could be loaded.');
  result.unavailable.sort((a, b) => a.stationId.localeCompare(b.stationId));
  return result;
}
