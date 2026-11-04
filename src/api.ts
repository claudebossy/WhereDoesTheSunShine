import { snapshotPath } from './snapshots';

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL?.replace(/\/+$/, '') ?? '';
export const snapshotMode = import.meta.env.VITE_DATA_MODE === 'snapshot';

export function apiUrl(path: string) {
  if (snapshotMode) return `${import.meta.env.BASE_URL}${snapshotPath(path)}`;
  return `${apiBaseUrl}${path}`;
}
