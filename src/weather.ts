import SunCalc from 'suncalc';

export interface Station {
  id: string;
  name: string;
  canton: string;
  elevation: number;
  latitude: number;
  longitude: number;
}

export interface Conditions {
  time: string;
  temperature: number | null;
  sunshineMinutes: number | null;
  lowCloud: number | null;
  cloud: number | null;
  isDay: boolean;
}

export interface Forecast {
  stationId: string;
  modelElevation: number;
  hours: Conditions[];
}

export interface ObservationHistory {
  series: Record<string, Conditions[]>;
  unavailable: { stationId: string; message: string }[];
}

export interface Dataset<T> {
  fetchedAt: string;
  data: T;
}

export type Status = 'sunny' | 'mixed' | 'low-cloud' | 'no-sun' | 'night' | 'unknown' | 'stale';
export type Mode = 'observations' | 'forecast' | 'history';

export const STATUS: Record<Status, { label: string; color: string; description: string }> = {
  sunny: { label: 'Sunshine', color: '#e5a51b', description: 'A promising patch of sunshine.' },
  mixed: { label: 'Some sunshine', color: '#9da975', description: 'Sunshine with cloud or interruptions.' },
  'low-cloud': { label: 'Low cloud risk', color: '#869ba7', description: 'The model predicts extensive low cloud and little sunshine.' },
  'no-sun': { label: 'No sunshine', color: '#869ba7', description: 'No direct sunshine. This alone cannot distinguish fog from higher cloud or terrain shade.' },
  night: { label: 'Nighttime', color: '#65738c', description: 'The sun is below the horizon.' },
  unknown: { label: 'No data', color: '#b5b5ad', description: 'Sunshine data are unavailable for this place and time.' },
  stale: { label: 'Out of date', color: '#b5b5ad', description: 'This observation is older than 40 minutes; do not treat it as live.' },
};

export function daylight(time: string, station: Pick<Station, 'latitude' | 'longitude'>): boolean {
  return SunCalc.getPosition(new Date(time), station.latitude, station.longitude).altitude > 0;
}

export function classify(conditions: Conditions | undefined, mode: Mode, now = Date.now()): Status {
  if (!conditions || !Number.isFinite(Date.parse(conditions.time))) return 'unknown';
  if (mode === 'observations' && (now - Date.parse(conditions.time) > 40 * 60_000 || Date.parse(conditions.time) - now > 10 * 60_000)) return 'stale';
  if (!conditions.isDay) return 'night';
  if (conditions.sunshineMinutes === null || !Number.isFinite(conditions.sunshineMinutes)) return 'unknown';
  if (mode !== 'forecast') {
    if (conditions.sunshineMinutes >= (mode === 'history' ? 48 : 8)) return 'sunny';
    return conditions.sunshineMinutes > 0 ? 'mixed' : 'no-sun';
  }
  if (conditions.lowCloud === null || conditions.cloud === null) return 'unknown';
  if (conditions.sunshineMinutes >= 45 && conditions.lowCloud <= 25 && conditions.cloud <= 40) return 'sunny';
  if (conditions.lowCloud >= 60 && conditions.sunshineMinutes <= 2) return 'low-cloud';
  return conditions.sunshineMinutes > 2 ? 'mixed' : 'no-sun';
}

export function forecastHour(forecast: Forecast | undefined, time: string): Conditions | undefined {
  return hourAtTime(forecast?.hours, time);
}

export function hourAtTime(hours: Conditions[] | undefined, time: string): Conditions | undefined {
  return hours?.find((hour) => hour.time === time);
}

export function swissDate(time: string | number): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(time));
  const part = (type: string) => parts.find((value) => value.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function historyDays(now: number): { date: string; label: string }[] {
  const today = Date.parse(`${swissDate(now)}T00:00:00Z`);
  return ['Today', 'Yesterday', '2 days ago'].map((label, index) => ({
    date: new Date(today - index * 86_400_000).toISOString().slice(0, 10), label,
  }));
}

export function swissMidnight(date: string): number {
  const midnightUTC = Date.parse(`${date}T00:00:00Z`);
  // In Switzerland, the UTC-midnight local hour is the offset (1 or 2).
  const offset = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Zurich', hour: '2-digit', hourCycle: 'h23',
  }).format(new Date(midnightUTC)));
  return midnightUTC - offset * 3_600_000;
}

export function historicalTimes(date: string, now: number): string[] {
  const nextDate = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const end = Math.min(swissMidnight(nextDate) - 1, now);
  const times: string[] = [];
  for (let time = swissMidnight(date); time <= end; time += 3_600_000) times.push(new Date(time).toISOString());
  return times;
}

export function formatHistoryTime(time: string, includeDate = false): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Zurich', timeZoneName: 'short',
    ...(includeDate ? { weekday: 'short', day: 'numeric', month: 'short' } : {}),
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(time));
}

export function formatTime(time: string, includeDate = false): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Zurich',
    ...(includeDate ? { weekday: 'short', day: 'numeric', month: 'short' } : {}),
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(time));
}

export function metres(value: number): string {
  return `${new Intl.NumberFormat('en-CH').format(Math.round(value))} m`;
}
