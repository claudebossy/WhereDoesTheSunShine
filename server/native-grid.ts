import wasm, { type CodesHandle, type Eccodes } from '@meri-imperiumi/eccodes-wasm';
import Flatbush from 'flatbush';
import { createHash } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { cache } from './data.js';
import { daylight } from '../src/weather.js';
import { project, unproject, type ForecastGrid, type GridIndex } from '../src/grid.js';

const COLLECTION = 'ch.meteoschweiz.ogd-forecasting-icon-ch1';
const STAC = 'https://data.geo.admin.ch/api/stac/v1';
const VARIABLES = ['CLCL', 'CLCT', 'DURSUN', 'T_2M'] as const;
type Variable = typeof VARIABLES[number];
export interface ModelAsset {
  variable: string;
  referenceTime: string;
  time: string;
  url: string;
}
interface ModelRun extends GridIndex {
  assets: Map<string, ModelAsset>;
  staticURL: string;
}
interface StaticGrid {
  gridId: string;
  nativeCount: number;
  mapping: number[];
  elevation: (number | null)[];
  width: number;
  height: number;
  west: number;
  north: number;
  cellSize: number;
  bounds: [[number, number], [number, number]];
}
interface Field {
  gridId: string;
  referenceTime: string;
  time: string;
  values: (number | null)[];
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid native model metadata.');
  return value as Record<string, unknown>;
}

function iso(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|\+00:00)$/.test(value)
    || !Number.isFinite(Date.parse(value))) throw new Error('Invalid native model timestamp.');
  const normalized = new Date(value).toISOString();
  if (normalized.slice(0, 19) !== value.slice(0, 19)) throw new Error('Invalid native model timestamp.');
  return normalized;
}

export function parseModelAssets(value: unknown): ModelAsset[] {
  const response = object(value);
  if (!Array.isArray(response.features)) throw new Error('Native model search returned no feature list.');
  return response.features.map((feature: unknown) => {
    const item = object(feature);
    const properties = object(item.properties);
    const assets = Object.values(object(item.assets));
    if (assets.length !== 1) throw new Error('Native model feature must contain exactly one GRIB asset.');
    const url = object(assets[0]).href;
    if (typeof url !== 'string' || new URL(url).protocol !== 'https:' || new URL(url).hostname !== 'rgw.cscs.ch') {
      throw new Error('Unexpected native model asset host.');
    }
    if (typeof properties['forecast:variable'] !== 'string' || properties['forecast:perturbed'] !== false) {
      throw new Error('Native model must be an identified control forecast.');
    }
    return {
      variable: properties['forecast:variable'],
      referenceTime: iso(properties['forecast:reference_datetime']),
      time: iso(properties.datetime),
      url,
    };
  });
}

async function json(url: string, body?: object): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
    ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`Native model metadata returned HTTP ${response.status}.`);
  return response.json();
}

async function search(filters: object, limit: number): Promise<ModelAsset[]> {
  return parseModelAssets(await json(`${STAC}/search`, {
    collections: [COLLECTION], limit, 'forecast:perturbed': false,
    sortby: [{ field: 'properties.created', direction: 'desc' }], ...filters,
  }));
}

function assetKey(variable: string, time: string): string {
  return `${variable}:${time}`;
}

const runs = new Map<string, ModelRun>();
const modelRun = cache(async (): Promise<ModelRun> => {
  // The final lead selects a completed 33-hour run, not a partially published run.
  const latest = (await search({ 'forecast:variable': 'CLCL', 'forecast:horizon': 'P1DT09H00M00S' }, 1))[0];
  if (!latest) throw new Error('No completed ICON-CH1 control run is available.');
  const all = (await Promise.all(VARIABLES.map((variable) => search({
    'forecast:variable': variable, 'forecast:reference_datetime': latest.referenceTime,
  }, 100)))).flat();
  const assets = new Map<string, ModelAsset>();
  for (const asset of all) {
    if (asset.referenceTime !== latest.referenceTime || !VARIABLES.some((variable) => variable === asset.variable)) {
      throw new Error('Native model search mixed different runs or variables.');
    }
    assets.set(assetKey(asset.variable, asset.time), asset);
  }
  const hours: string[] = [];
  for (let lead = 1; lead <= 33; lead++) {
    const time = new Date(Date.parse(latest.referenceTime) + lead * 3_600_000).toISOString();
    const previous = new Date(Date.parse(time) - 3_600_000).toISOString();
    if (VARIABLES.every((variable) => assets.has(assetKey(variable, time))) && assets.has(assetKey('DURSUN', previous))) hours.push(time);
  }
  if (!hours.length) throw new Error('No complete native model forecast hours are available.');
  const collection = object(await json(`${STAC}/collections/${COLLECTION}`));
  const collectionAssets = object(collection.assets);
  const staticURL = object(collectionAssets['horizontal_constants_icon-ch1-eps.grib2']).href;
  const parameterURL = object(collectionAssets['params_icon-ch1-eps.csv']).href;
  if (typeof staticURL !== 'string' || typeof parameterURL !== 'string') throw new Error('Native grid constants are unavailable.');
  const parametersResponse = await fetch(parameterURL, { signal: AbortSignal.timeout(30_000) });
  if (!parametersResponse.ok) throw new Error(`Model parameter catalogue returned HTTP ${parametersResponse.status}.`);
  const parameters: string[][] = parse(await parametersResponse.text(), { skip_empty_lines: true });
  const expectedUnits: Record<Variable, string> = { CLCL: '%', CLCT: '%', DURSUN: 's', T_2M: 'K' };
  for (const variable of VARIABLES) {
    if (parameters.find((row) => row[0] === variable)?.[2] !== expectedUnits[variable]) {
      throw new Error(`Native model units changed for ${variable}.`);
    }
  }
  const run: ModelRun = { referenceTime: latest.referenceTime, hours, assets, staticURL, resolutionKm: 1.1 };
  runs.set(run.referenceTime, run);
  if (runs.size > 4) runs.delete(runs.keys().next().value!);
  return run;
}, 15 * 60_000);

export async function getGridIndex(): Promise<GridIndex> {
  const { data } = await modelRun();
  return { referenceTime: data.referenceTime, hours: data.hours, resolutionKm: data.resolutionKm };
}

let decoder: Promise<Eccodes> | undefined;
function getDecoder(): Promise<Eccodes> {
  if (!decoder) decoder = wasm.createEccodes();
  return decoder;
}

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Native GRIB download returned HTTP ${response.status}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const checksum = response.headers.get('x-amz-meta-sha256');
  if (checksum && createHash('sha256').update(bytes).digest('hex') !== checksum.toLowerCase()) {
    throw new Error('Native GRIB checksum verification failed.');
  }
  return bytes;
}

function gribTime(handle: CodesHandle, validity: boolean): string {
  const date = String(handle.getLong(validity ? 'validityDate' : 'dataDate'));
  const clock = String(handle.getLong(validity ? 'validityTime' : 'dataTime')).padStart(4, '0');
  return iso(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${clock.slice(0, 2)}:${clock.slice(2)}:00Z`);
}

let staticPending: Promise<StaticGrid> | undefined;
let staticStored: StaticGrid | undefined;

async function staticGrid(url: string): Promise<StaticGrid> {
  if (staticStored) return staticStored;
  if (staticPending) return staticPending;
  staticPending = (async () => {
    const api = await getDecoder();
    api.writeFile('/static.grib', await download(url));
    let longitude: number[] | undefined;
    let latitude: number[] | undefined;
    let terrain: number[] | undefined;
    let gridId = '';
    try {
      api.forEachMessage('/static.grib', (handle) => {
        const id = handle.getString('uuidOfHGrid');
        if (gridId && gridId !== id) throw new Error('Static constants contain different native grids.');
        gridId = id;
        // Parameter numbers avoid dependence on optional COSMO short-name tables.
        const category = handle.getLong('parameterCategory');
        const parameter = handle.getLong('parameterNumber');
        if (category === 191 && parameter === 2) longitude = handle.getDoubleArray('values');
        if (category === 191 && parameter === 1) latitude = handle.getDoubleArray('values');
        if (category === 3 && parameter === 6) terrain = handle.getDoubleArray('values');
      });
    } finally { api.writeFile('/static.grib', new Uint8Array()); }
    if (!longitude || !latitude || !terrain || !gridId || latitude.length !== longitude.length || terrain.length !== longitude.length) {
      throw new Error('Native grid coordinates and terrain are incomplete.');
    }
    const coordinates: [number, number][] = [];
    const nativeIndices: number[] = [];
    for (let index = 0; index < longitude.length; index++) {
      if (longitude[index] >= 5.75 && longitude[index] <= 10.7 && latitude[index] >= 45.55 && latitude[index] <= 48.05) {
        coordinates.push(project(longitude[index], latitude[index]));
        nativeIndices.push(index);
      }
    }
    if (!coordinates.length) throw new Error('Native coordinates do not cover Switzerland.');
    const tree = new Flatbush(coordinates.length);
    coordinates.forEach(([x, y]) => tree.add(x, y, x, y));
    tree.finish();
    const [west, south] = project(5.95, 45.75);
    const [east, north] = project(10.5, 47.85);
    // A 1.5 km Mercator pixel is about 1 km on the ground in Switzerland.
    const cellSize = 1500;
    const width = Math.ceil((east - west) / cellSize);
    const height = Math.ceil((north - south) / cellSize);
    const mapping: number[] = [];
    const elevation: (number | null)[] = [];
    for (let row = 0; row < height; row++) {
      for (let column = 0; column < width; column++) {
        const nearest = tree.neighbors(west + (column + 0.5) * cellSize, north - (row + 0.5) * cellSize, 1, 2500)[0];
        const native = nearest === undefined ? -1 : nativeIndices[nearest];
        mapping.push(native);
        elevation.push(native < 0 || !Number.isFinite(terrain[native]) ? null : Math.round(terrain[native]));
      }
    }
    const [southLongitude, southLatitude] = unproject(west, north - height * cellSize);
    const [northLongitude, northLatitude] = unproject(west + width * cellSize, north);
    staticStored = {
      gridId, nativeCount: longitude.length, mapping, elevation, width, height, west, north, cellSize,
      bounds: [[southLatitude, southLongitude], [northLatitude, northLongitude]],
    };
    return staticStored;
  })().finally(() => { staticPending = undefined; });
  return staticPending;
}

async function field(asset: ModelAsset, grid: StaticGrid): Promise<Field> {
  const bytes = await download(asset.url);
  const api = await getDecoder();
  api.writeFile('/field.grib', bytes);
  let result: Field | undefined;
  try {
    api.forEachMessage('/field.grib', (handle) => {
      if (result) throw new Error('Control forecast unexpectedly contains multiple GRIB messages.');
      const gridId = handle.getString('uuidOfHGrid');
      const referenceTime = gribTime(handle, false);
      const time = gribTime(handle, true);
      if (gridId !== grid.gridId || handle.getSize('values') !== grid.nativeCount || referenceTime !== asset.referenceTime || time !== asset.time
        || handle.getLong('perturbationNumber') !== 0) {
        if (gridId !== grid.gridId) staticStored = undefined;
        throw new Error('Native forecast and static grid metadata do not match.');
      }
      const values = handle.getDoubleArray('values');
      const missing = handle.getDouble('missingValue');
      result = {
        gridId, referenceTime, time,
        values: grid.mapping.map((native) => native < 0 || !Number.isFinite(values[native]) || values[native] === missing ? null : values[native]),
      };
    });
  } finally { api.writeFile('/field.grib', new Uint8Array()); }
  if (!result) throw new Error('Native forecast contains no GRIB message.');
  return result;
}

export function hourlySunshine(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null;
  const difference = current - previous;
  if (!Number.isFinite(difference) || difference < -1 || difference > 3601) throw new Error('Invalid native sunshine accumulation difference.');
  return Math.max(0, Math.min(3600, difference)) / 60;
}

function percent(value: number | null): number | null {
  return value === null || value < -0.01 || value > 100.01 ? null : Math.max(0, Math.min(100, value));
}

const gridLoads = new Map<string, ReturnType<typeof cache<ForecastGrid>>>();

export async function getForecastGrid(time: string, referenceTime: string): Promise<ForecastGrid> {
  if (!runs.has(referenceTime)) await modelRun();
  const run = runs.get(referenceTime);
  if (!run || !run.hours.includes(time)) throw new Error('Requested hour is not available in this native model run.');
  const key = `${referenceTime}:${time}`;
  let load = gridLoads.get(key);
  if (!load) {
    load = cache(async () => {
      const grid = await staticGrid(run.staticURL);
      const previous = new Date(Date.parse(time) - 3_600_000).toISOString();
      const descriptors = [...VARIABLES.map((variable) => run.assets.get(assetKey(variable, time))!), run.assets.get(assetKey('DURSUN', previous))!];
      const [lowCloud, cloud, sunshine, temperature, previousSunshine] = await Promise.all(descriptors.map((asset) => field(asset, grid)));
      const midpoint = new Date(Date.parse(time) - 30 * 60_000).toISOString();
      const minutes = sunshine.values.map((value, cell) => hourlySunshine(value, previousSunshine.values[cell]));
      const isDay = minutes.map((value, cell) => {
        const [longitude, latitude] = unproject(grid.west + (cell % grid.width + 0.5) * grid.cellSize, grid.north - (Math.floor(cell / grid.width) + 0.5) * grid.cellSize);
        return (value !== null && value > 0) || daylight(midpoint, { latitude, longitude });
      });
      return {
        time, referenceTime, resolutionKm: run.resolutionKm, gridId: grid.gridId,
        width: grid.width, height: grid.height, west: grid.west, north: grid.north, cellSize: grid.cellSize, bounds: grid.bounds,
        elevation: grid.elevation, isDay,
        sunshine: minutes.map((value) => value === null ? null : Math.round(value * 100) / 100),
        lowCloud: lowCloud.values.map(percent), cloud: cloud.values.map(percent),
        temperature: temperature.values.map((value) => value === null || value < 183 || value > 333 ? null : Math.round((value - 273.15) * 10) / 10),
      };
    }, 6 * 60 * 60_000);
    gridLoads.set(key, load);
    if (gridLoads.size > 20) gridLoads.delete(gridLoads.keys().next().value!);
  }
  return (await load()).data;
}
