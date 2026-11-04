import { classify, STATUS, type Conditions } from './weather';

export interface GridIndex {
  referenceTime: string;
  hours: string[];
  resolutionKm: number;
}

export interface ForecastGrid {
  time: string;
  referenceTime: string;
  resolutionKm: number;
  gridId: string;
  width: number;
  height: number;
  west: number;
  north: number;
  cellSize: number;
  bounds: [[number, number], [number, number]];
  sunshine: (number | null)[];
  lowCloud: (number | null)[];
  cloud: (number | null)[];
  temperature: (number | null)[];
  elevation: (number | null)[];
  isDay: boolean[];
}

const EARTH_RADIUS = 6_378_137;

export function project(longitude: number, latitude: number): [number, number] {
  return [
    EARTH_RADIUS * longitude * Math.PI / 180,
    EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360)),
  ];
}

export function unproject(x: number, y: number): [number, number] {
  return [
    x / EARTH_RADIUS * 180 / Math.PI,
    (2 * Math.atan(Math.exp(y / EARTH_RADIUS)) - Math.PI / 2) * 180 / Math.PI,
  ];
}

export function gridCell(grid: ForecastGrid, latitude: number, longitude: number): number | undefined {
  const [x, y] = project(longitude, latitude);
  const column = Math.floor((x - grid.west) / grid.cellSize);
  const row = Math.floor((grid.north - y) / grid.cellSize);
  if (column < 0 || column >= grid.width || row < 0 || row >= grid.height) return undefined;
  return row * grid.width + column;
}

export function gridConditions(grid: ForecastGrid, cell: number): Conditions | undefined {
  if (cell < 0 || cell >= grid.width * grid.height || grid.elevation[cell] === null) return undefined;
  return {
    time: grid.time,
    temperature: grid.temperature[cell],
    sunshineMinutes: grid.sunshine[cell],
    lowCloud: grid.lowCloud[cell],
    cloud: grid.cloud[cell],
    isDay: grid.isDay[cell],
  };
}

export function rasterPixels(grid: ForecastGrid, minimumElevation: number, sunnyOnly: boolean): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(grid.width * grid.height * 4);
  for (let cell = 0; cell < grid.width * grid.height; cell++) {
    const elevation = grid.elevation[cell];
    if (elevation === null || elevation < minimumElevation) continue;
    const status = classify(gridConditions(grid, cell), 'forecast');
    if (sunnyOnly && status !== 'sunny') continue;
    const color = STATUS[status].color;
    pixels[cell * 4] = parseInt(color.slice(1, 3), 16);
    pixels[cell * 4 + 1] = parseInt(color.slice(3, 5), 16);
    pixels[cell * 4 + 2] = parseInt(color.slice(5, 7), 16);
    pixels[cell * 4 + 3] = 175;
  }
  return pixels;
}
