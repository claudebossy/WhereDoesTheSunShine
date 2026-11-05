export function snapshotPath(path: string): string {
  const url = new URL(path, 'https://weather.invalid');
  if (url.pathname === '/api/grid') {
    const time = url.searchParams.get('time');
    const run = url.searchParams.get('run');
    const valid = (value: string | null): value is string => value !== null
      && /^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/.test(value)
      && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
    if (!valid(time) || !valid(run)) throw new Error('Invalid snapshot grid time or run.');
    return `weather/grids/${run.replace(/[:-]/g, '')}/${time.replace(/[:-]/g, '')}.json`;
  }
  if (!['/api/stations', '/api/observations', '/api/forecasts', '/api/history', '/api/grid-index'].includes(url.pathname)
    || url.search) throw new Error(`Unknown snapshot endpoint: ${path}`);
  return `weather/${url.pathname.slice(5)}.json`;
}
