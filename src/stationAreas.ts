import type { Conditions, Station, Status } from './weather';

export const STATION_AREA_RADIUS_METRES = 5000;

interface StationReading {
  station: Station;
  conditions?: Conditions;
  status: Status;
}

export function stationAreas(readings: StationReading[]): StationReading[] {
  return readings.filter(({ conditions, status }) => status !== 'unknown' && status !== 'stale'
    && conditions?.sunshineMinutes != null && Number.isFinite(conditions.sunshineMinutes));
}
