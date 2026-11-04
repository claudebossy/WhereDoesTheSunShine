import { useCallback, useEffect, useState } from 'react';
import type { Dataset } from './weather';
import { apiUrl } from './api';

export function useDataset<T>(path: string, enabled: boolean, interval: number) {
  const [dataset, setDataset] = useState<Dataset<T>>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let active = true;
    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const response = await fetch(apiUrl(path), { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(210_000)]) });
        if (!response.ok) throw new Error(`Weather service returned HTTP ${response.status}. Please retry in a minute.`);
        const result: Dataset<T> = await response.json();
        if (active) setDataset(result);
      } catch (error: unknown) {
        if (!active) return;
        console.error('[weather]', error);
        setDataset(undefined);
        setError(error instanceof Error ? error.message : 'Weather data could not be loaded.');
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, interval);
    return () => { active = false; controller.abort(); window.clearInterval(timer); };
  }, [path, enabled, interval, revision]);

  return { dataset, error, loading, refresh };
}
