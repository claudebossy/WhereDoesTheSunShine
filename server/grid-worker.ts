import { parentPort } from 'node:worker_threads';
import { getForecastGrid, getGridIndex } from './native-grid.js';

if (!parentPort) throw new Error('Native model decoder must run in a worker.');
const port = parentPort;
port.on('message', async (message: { id: number; kind: 'index' | 'grid'; time?: string; run?: string }) => {
  try {
    const data = message.kind === 'index' ? await getGridIndex() : await getForecastGrid(message.time!, message.run!);
    port.postMessage({ id: message.id, data });
  } catch (error: unknown) {
    console.error('[native-grid]', error);
    port.postMessage({ id: message.id, error: error instanceof Error ? error.message : 'Native forecast grid could not be loaded.' });
  }
});
