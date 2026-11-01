import { Worker } from 'node:worker_threads';
import type { ForecastGrid, GridIndex } from '../src/grid.js';

let worker: Worker | undefined;
let nextId = 0;
type GridResponse = ForecastGrid | GridIndex;
const pending = new Map<number, { resolve: (data: GridResponse) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

function request(kind: 'index' | 'grid', time?: string, run?: string): Promise<GridResponse> {
  if (!worker) {
    const instance = new Worker(new URL('./grid-worker.mjs', import.meta.url));
    worker = instance;
    instance.on('message', (message: { id: number; data?: GridResponse; error?: string }) => {
      const job = pending.get(message.id);
      if (!job) return;
      clearTimeout(job.timer);
      pending.delete(message.id);
      if (message.error) job.reject(new Error(message.error));
      else if (message.data) job.resolve(message.data);
      else job.reject(new Error('Native worker returned an empty response.'));
    });
    const fail = (error: Error) => {
      if (worker !== instance) return;
      console.error('[grid-worker]', error);
      for (const job of pending.values()) { clearTimeout(job.timer); job.reject(error); }
      pending.clear();
      worker = undefined;
      void instance.terminate();
    };
    instance.on('error', fail);
    instance.on('exit', (code) => { fail(new Error(`Native grid worker exited with code ${code}.`)); });
  }
  const instance = worker;
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Native model grid loading timed out.')); }, 180_000);
    pending.set(id, { resolve, reject, timer });
    instance.postMessage({ id, kind, time, run });
  });
}

export async function gridIndex(): Promise<GridIndex> {
  const data = await request('index');
  if (!('hours' in data)) throw new Error('Native worker returned a grid instead of an index.');
  return data;
}

export async function forecastGrid(time: string, run: string): Promise<ForecastGrid> {
  const data = await request('grid', time, run);
  if (!('sunshine' in data)) throw new Error('Native worker returned an index instead of a grid.');
  return data;
}
