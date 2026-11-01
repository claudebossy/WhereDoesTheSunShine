import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleMarker, MapContainer, Popup, TileLayer, useMap } from 'react-leaflet';
import type { Map as LeafletMap } from 'leaflet';
import { ArrowDown, ArrowUpRight, ChevronRight, Cloud, Compass, History, Info, MapPin, Moon, Mountain, RefreshCw, Search, SlidersHorizontal, Sun, X } from 'lucide-react';
import { classify, daylight, forecastHour, formatHistoryTime, formatTime, historicalTimes, historyDays, hourAtTime, metres, STATUS, type Conditions, type Forecast, type Mode, type ObservationHistory, type Station, type Status } from './weather';
import { useDataset } from './useDataset';
import GridLayer, { type GridPoint } from './GridLayer';
import { gridCell, gridConditions, type ForecastGrid, type GridIndex } from './grid';

const normalize = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

function WeatherIcon({ status, size = 20 }: { status: Status; size?: number }) {
  return status === 'night' ? <Moon size={size} /> : status === 'sunny' ? <Sun size={size} /> : <Cloud size={size} />;
}

function MapFocus({ station, reset }: { station?: Station; reset: number }) {
  const map = useMap();
  useEffect(() => {
    if (station) map.flyTo([station.latitude, station.longitude], Math.max(map.getZoom(), 9), { duration: 0.7, animate: !window.matchMedia('(prefers-reduced-motion: reduce)').matches });
  }, [station, map]);
  useEffect(() => {
    map.fitBounds([[45.75, 5.95], [47.85, 10.5]], { padding: [25, 25] });
  }, [reset, map]);
  return null;
}

function Sources({ close }: { close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className="sources-dialog" onClose={close} aria-labelledby="sources-title">
    <button className="icon-button dialog-close" onClick={() => ref.current?.close()} aria-label="Close data sources"><X size={20} /></button>
    <span className="eyebrow">OPEN DATA, OPENLY EXPLAINED</span>
    <h2 id="sources-title">A little clarity, before you climb.</h2>
    <h3>Measured sunshine</h3>
    <p>Source: <a href="https://opendatadocs.meteoswiss.ch/a-data-groundbased/a1-automatic-weather-stations" target="_blank" rel="noreferrer">MeteoSwiss Open Government Data</a>. Station metadata and the latest 10-minute measurements come directly from data.geo.admin.ch. Sunshine means at least 8 minutes of direct sun in the last measured 10-minute period. More than 0 but less than 8 minutes means some sunshine. Observations over 40 minutes old are marked out of date.</p>
    <h3>Hourly forecasts</h3>
    <p>Source: MeteoSwiss ICON-CH1, delivered through <a href="https://open-meteo.com/en/docs/meteoswiss-api" target="_blank" rel="noreferrer">Open-Meteo</a> (<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a>). Sunshine means at least 45 minutes per hour, with at most 25% low cloud and 40% total cloud. Low cloud risk means at least 60% low cloud and at most 2 minutes of sunshine. These are our screening thresholds, not official MeteoSwiss categories. The forecast can differ from conditions at a summit.</p>
    <h3>Continuous area forecast</h3>
    <p>Source: <a href="https://opendatadocs.meteoswiss.ch/e-forecast-data/e2-e3-numerical-weather-forecasting-model" target="_blank" rel="noreferrer">MeteoSwiss ICON-CH1 Open Government Data</a>, decoded directly from the control-run GRIB files. Its native resolution is approximately 1.1 km. The coloured layer samples the nearest native model cell onto roughly 1 km display pixels; it does not interpolate station observations. It covers Switzerland and nearby areas. The same forecast sunshine and cloud thresholds apply. Each area timestamp ends the forecast hour, and sunshine is the difference between that run's accumulated sunshine at consecutive hours.</p>
    <p>The area timeline uses only complete hours available in one 33-hour model run. Switch off <strong>Area forecast</strong> for the original 48-hour station timeline. Station cards and optional station dots use Open-Meteo forecasts and can use a different model run from the area layer. They are not measured evidence for a future hour; use Measured now or Look back for observations. Grid temperature and altitude describe the model, not a precise summit. Raw model files are retained by MeteoSwiss for 24 hours, so no historical area layer is invented for the two-day observation history.</p>
    <h3>Looking back</h3>
    <p>Source: MeteoSwiss Open Government Data, using the official hourly station files. Today, yesterday and two days ago are Swiss calendar dates. Each timestamp is the <strong>end of the measured hour</strong>; sunshine is the total for that hour, and temperature is the hourly mean. Sunshine means at least 48 minutes per hour (the same 80% threshold as live observations). More than 0 but less than 48 minutes means some sunshine. These are observations, not archived forecasts. Missing readings stay missing; publication of today's hourly values can lag. Historical readings are not flagged as stale just because they are in the past.</p>
    <h3>Above the fog is not a guarantee</h3>
    <p>Neither station sunshine nor model low-cloud cover measures the fog-top altitude. A sunny high station is a candidate, not proof of a cloud inversion. Clouds, terrain shade and nighttime are different things. Check local webcams, mountain access and the official weather before travelling; this is not a mountain-safety service.</p>
    <h3>Map & availability</h3>
    <p>Map: <a href="https://www.swisstopo.admin.ch/en/online-maps-and-data" target="_blank" rel="noreferrer">swisstopo</a>. All times are Swiss local time. Observations refresh every 5 minutes; forecasts every 30 minutes; history every 15 minutes. Stations refresh daily. Only real data are shown; unavailable services are reported, never replaced with invented weather.</p>
    <p className="small">Open-Meteo's public endpoint is for non-commercial use and has request limits. See the README for hosting and usage details.</p>
  </dialog>;
}

export default function App() {
  const [mode, setMode] = useState<Mode>('observations');
  const [search, setSearch] = useState('');
  const [minElevation, setMinElevation] = useState(0);
  const [sunnyOnly, setSunnyOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [time, setTime] = useState('');
  const [areaForecast, setAreaForecast] = useState(true);
  const [showStationDots, setShowStationDots] = useState(false);
  const [gridPoint, setGridPoint] = useState<GridPoint>();
  const [requestedGridTime, setRequestedGridTime] = useState('');
  const [historyDate, setHistoryDate] = useState(() => historyDays(Date.now())[0].date);
  const [historyTime, setHistoryTime] = useState('');
  const [now, setNow] = useState(Date.now());
  const [showSources, setShowSources] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [mapReset, setMapReset] = useState(0);
  const [tileError, setTileError] = useState(false);
  const detailRef = useRef<HTMLElement>(null);
  const mapRef = useRef<LeafletMap>(null);
  const stationData = useDataset<Station[]>('/api/stations', true, 24 * 60 * 60_000);
  const observations = useDataset<Record<string, Conditions>>('/api/observations', mode === 'observations', 5 * 60_000);
  const forecasts = useDataset<Record<string, Forecast>>('/api/forecasts', mode === 'forecast', 30 * 60_000);
  const history = useDataset<ObservationHistory>('/api/history', mode === 'history', 15 * 60_000);
  const areaEnabled = mode === 'forecast' && areaForecast;
  const nativeIndex = useDataset<GridIndex>('/api/grid-index', areaEnabled, 15 * 60_000);
  const modelRun = nativeIndex.dataset?.data.referenceTime ?? '';
  useEffect(() => {
    if (!areaEnabled || !time) return;
    const timer = window.setTimeout(() => setRequestedGridTime(time), 300);
    return () => window.clearTimeout(timer);
  }, [areaEnabled, time]);
  const gridData = useDataset<ForecastGrid>(
    `/api/grid?${new URLSearchParams({ time: requestedGridTime, run: modelRun })}`,
    areaEnabled && requestedGridTime === time && !!modelRun && !!nativeIndex.dataset?.data.hours.includes(requestedGridTime),
    30 * 60_000,
  );
  const currentGrid = areaEnabled && gridData.dataset?.data.time === time && gridData.dataset.data.referenceTime === modelRun
    ? gridData.dataset.data : undefined;
  const stations = stationData.dataset?.data;
  const active = mode === 'observations' ? observations : mode === 'history' ? history : forecasts;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (selectedId || gridPoint) detailRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedId, gridPoint]);

  const hours = useMemo(() => {
    const first = Object.values(forecasts.dataset?.data ?? {})[0];
    return first?.hours.filter((hour) => Date.parse(hour.time) >= Math.floor(now / 3_600_000) * 3_600_000 && Date.parse(hour.time) < now + 48 * 3_600_000) ?? [];
  }, [forecasts.dataset, now]);

  const forecastTimes = useMemo(() => areaEnabled
    ? nativeIndex.dataset?.data.hours.filter((value) => Date.parse(value) >= Math.floor(now / 3_600_000) * 3_600_000) ?? []
    : hours.map((hour) => hour.time), [areaEnabled, nativeIndex.dataset, hours, now]);
  useEffect(() => {
    if (forecastTimes.length && !forecastTimes.includes(time)) {
      const nextDaytime = daylight(forecastTimes[0], { latitude: 46.8, longitude: 8.2 }) ? forecastTimes[0]
        : forecastTimes.find((value) => formatTime(value) === '12:00') ?? forecastTimes[0];
      setTime(nextDaytime);
    }
  }, [forecastTimes, time]);

  const days = useMemo(() => historyDays(now), [now]);
  const pastTimes = useMemo(() => historicalTimes(historyDate, now), [historyDate, now]);
  useEffect(() => {
    if (!days.some((day) => day.date === historyDate)) setHistoryDate(days[0].date);
  }, [days, historyDate]);
  useEffect(() => {
    if (!pastTimes.includes(historyTime)) {
      setHistoryTime(pastTimes.find((value) => formatTime(value) === '12:00') ?? pastTimes.at(-1) ?? '');
    }
  }, [pastTimes, historyTime]);

  const conditionsFor = (id: string): Conditions | undefined => mode === 'observations'
    ? observations.dataset?.data[id]
    : mode === 'history' ? hourAtTime(history.dataset?.data.series[id], historyTime)
      : forecastHour(forecasts.dataset?.data[id], time);
  const ranked = (stations ?? []).map((station) => {
    const conditions = conditionsFor(station.id);
    return { station, conditions, status: classify(conditions, mode, now) };
  }).sort((a, b) => {
    const priority: Record<Status, number> = { sunny: 0, mixed: 1, 'low-cloud': 2, 'no-sun': 2, night: 3, unknown: 4, stale: 4 };
    return priority[a.status] - priority[b.status] || b.station.elevation - a.station.elevation;
  });
  const filtered = ranked.filter(({ station, status }) => station.elevation >= minElevation
    && (!sunnyOnly || status === 'sunny')
    && normalize(`${station.name} ${station.canton} ${station.id}`).includes(normalize(search)));
  const selected = stations?.find((station) => station.id === selectedId);
  const selectedConditions = selected && conditionsFor(selected.id);
  const selectedStatus = classify(selectedConditions, mode, now);
  const sunnyCount = ranked.filter((item) => item.status === 'sunny').length;
  const highSunCount = ranked.filter((item) => item.status === 'sunny' && item.station.elevation >= 1000).length;
  const currentHourIndex = Math.max(0, forecastTimes.indexOf(time));
  const pastHourIndex = Math.max(0, pastTimes.indexOf(historyTime));
  const latestObservation = Object.values(observations.dataset?.data ?? {}).map((item) => item.time).sort().at(-1);
  const errors = [
    stationData.error && `Station metadata: ${stationData.error}`,
    active.error && `${mode === 'history' ? 'Observation history' : mode === 'forecast' ? 'Station forecasts' : 'Live observations'}: ${active.error}`,
    areaEnabled && nativeIndex.error && `Native model index: ${nativeIndex.error}`,
    areaEnabled && gridData.error && `Area forecast: ${gridData.error}`,
  ].filter(Boolean);
  const initialLoading = !stations || (!active.dataset && active.loading);
  const refresh = () => { stationData.refresh(); active.refresh(); if (areaEnabled) { nativeIndex.refresh(); gridData.refresh(); } setNow(Date.now()); };
  const noNativeHours = areaEnabled && !!nativeIndex.dataset && !forecastTimes.length;
  const gridLoading = areaEnabled && !currentGrid && !nativeIndex.error && !gridData.error && !noNativeHours;
  const updateLabel = areaEnabled ? modelRun ? `ICON-CH1 run ${formatTime(modelRun, true)}` : 'Fetching native model run...'
    : active.loading ? 'Fetching weather data...'
    : !active.dataset ? 'Waiting for weather data'
      : mode === 'observations' && latestObservation ? `Latest measurement ${formatTime(latestObservation, true)}`
        : `${mode === 'history' ? 'History' : 'Forecast'} fetched ${formatTime(active.dataset.fetchedAt, true)}`;
  const timelineTimes = mode === 'history' ? pastTimes : forecastTimes;
  const timelineTime = mode === 'history' ? historyTime : areaEnabled && !forecastTimes.length ? '' : time;
  const displayTimelineTime = mode === 'history' ? formatHistoryTime : formatTime;
  const unavailableHistory = mode === 'history' ? history.dataset?.data.unavailable ?? [] : [];
  const selectedCell = currentGrid && gridPoint ? gridCell(currentGrid, gridPoint.latitude, gridPoint.longitude) : undefined;
  const cellConditions = currentGrid && selectedCell !== undefined ? gridConditions(currentGrid, selectedCell) : undefined;
  const cellStatus = classify(cellConditions, 'forecast', now);
  const selectGridPoint = (point: GridPoint) => { setGridPoint(point); setSelectedId(undefined); };

  return <div className="app">
    <header className="site-header">
      <a className="brand" href="/" aria-label="Sunward home"><span className="brand-mark"><Sun size={27} strokeWidth={1.7} /></span>sunward<span className="brand-dot">.</span></a>
      <span className="header-tagline">A brighter side of Switzerland.</span>
      <button className="sources-button" onClick={() => setShowSources(true)}><Info size={16} /><span>About the data</span><ArrowUpRight size={15} /></button>
    </header>

    <main>
      <section className="intro">
        <div><div className="eyebrow"><span className="swiss-cross">+</span> SWITZERLAND, IN A DIFFERENT LIGHT</div>
          <h1>Leave the grey.<br className="mobile-break" /> <span>Find the sunshine.</span></h1>
          <p>Down here, a sea of fog. Up there, a different day.<br />Explore real observations and forecasts to find your patch of sun.</p>
        </div>
        <div className="intro-illustration" aria-hidden="true"><div className="illustration-sun" /><Mountain size={118} strokeWidth={0.8} /><div className="illustration-fog" /><span>A LITTLE HIGHER, A LITTLE BRIGHTER</span></div>
      </section>

      <section className="explorer" aria-label="Swiss sunshine explorer">
        <div className="explorer-toolbar">
          <div className="mode-switch" aria-label="Weather mode">
            <button className={mode === 'observations' ? 'active' : ''} aria-pressed={mode === 'observations'} onClick={() => setMode('observations')}><span className="live-dot" />Measured now</button>
            <button className={mode === 'forecast' ? 'active' : ''} aria-pressed={mode === 'forecast'} onClick={() => setMode('forecast')}><Sun size={16} />Plan ahead</button>
            <button className={mode === 'history' ? 'active' : ''} aria-pressed={mode === 'history'} onClick={() => setMode('history')}><History size={16} />Look back</button>
          </div>
          <div className="update-note"><span>{updateLabel}</span>
            <button className={`icon-button ${active.loading || gridLoading ? 'spinning' : ''}`} disabled={active.loading || stationData.loading || gridLoading} onClick={refresh} aria-label="Refresh weather data"><RefreshCw size={16} /></button>
          </div>
        </div>

        {errors.length > 0 && <div className="error-banner" role="alert"><Info size={18} /><div><strong>Some weather data are unavailable.</strong> {errors.join(' ')} No demo weather is shown.</div><button onClick={refresh}>Retry</button></div>}
        {unavailableHistory.length > 0 && <details className="history-warning">
          <summary>{unavailableHistory.length} {unavailableHistory.length === 1 ? 'station has' : 'stations have'} unavailable history. Other stations show real observations.</summary>
          <ul>{unavailableHistory.map((failure) => <li key={failure.stationId}>{stations?.find((station) => station.id === failure.stationId)?.name ?? failure.stationId}: {failure.message}</li>)}</ul>
        </details>}

        <div className="explorer-body">
          <aside className="sidebar" aria-label="Places and filters">
            <div className="sidebar-heading"><div className="eyebrow">YOUR NEXT BRIGHT SPOT</div><h2>A little altitude.<br />A lot of possibility.</h2>
              <p>{areaEnabled ? 'Click the coloured map for a native model forecast. Station cards below use forecasts via Open-Meteo and may use a different run.' : 'Look for sunny high stations, then check conditions before heading up.'}</p>
            </div>
            <div className="stats"><div><Sun size={19} /><strong>{active.dataset ? sunnyCount : '--'}</strong><span>sunny stations</span></div><div><Mountain size={19} /><strong>{active.dataset ? highSunCount : '--'}</strong><span>sunny above 1,000 m</span></div></div>
            <div className="filters">
              <label className="search-box"><Search size={17} /><input aria-label="Search stations" placeholder="Find a station or canton..." value={search} onChange={(event) => setSearch(event.target.value)} />{search && <button className="icon-button" onClick={() => setSearch('')} aria-label="Clear search"><X size={14} /></button>}</label>
              <div className="filter-label"><label htmlFor="elevation"><SlidersHorizontal size={14} />Minimum altitude</label><strong>{metres(minElevation)}</strong></div>
              <input id="elevation" type="range" min="0" max="3500" step="100" value={minElevation} onChange={(event) => setMinElevation(Number(event.target.value))} />
              <div className="range-labels"><span>Valley floor</span><span>High mountains</span></div>
              <label className="toggle-row"><span><Sun size={16} />Only show sunshine</span><input type="checkbox" checked={sunnyOnly} onChange={(event) => setSunnyOnly(event.target.checked)} /><span className="toggle-track" aria-hidden="true" /></label>
            </div>

            {areaEnabled && gridPoint && !selected && <section ref={detailRef} className="station-detail grid-detail" aria-label="Model grid forecast details">
              <button className="icon-button detail-close" onClick={() => setGridPoint(undefined)} aria-label="Close grid details"><X size={16} /></button>
              <div className="eyebrow">MODEL GRID · NOT A MEASUREMENT</div>
              <h3>Your patch of sky.</h3>
              <span className="small">{gridPoint.latitude.toFixed(3)}° N · {gridPoint.longitude.toFixed(3)}° E</span>
              {gridLoading ? <p>Loading this forecast hour...</p> : <><div className="detail-status" style={{ color: STATUS[cellStatus].color }}><WeatherIcon status={cellStatus} /><strong>{STATUS[cellStatus].label}</strong></div><p>{STATUS[cellStatus].description}</p></>}
              {cellConditions && currentGrid && selectedCell !== undefined && <><dl className="detail-metrics">
                <div><dt>Model temperature</dt><dd>{cellConditions.temperature === null ? 'Unavailable' : `${cellConditions.temperature.toFixed(1)} °C`}</dd></div>
                <div><dt>Sunshine / hour</dt><dd>{cellConditions.sunshineMinutes === null ? 'Unavailable' : `${Math.round(cellConditions.sunshineMinutes)} min`}</dd></div>
                <div><dt>Low cloud cover</dt><dd>{cellConditions.lowCloud === null ? 'Unavailable' : `${Math.round(cellConditions.lowCloud)}%`}</dd></div>
                <div><dt>Total cloud cover</dt><dd>{cellConditions.cloud === null ? 'Unavailable' : `${Math.round(cellConditions.cloud)}%`}</dd></div>
                <div><dt>Model terrain altitude</dt><dd>{currentGrid.elevation[selectedCell] === null ? 'Unavailable' : metres(currentGrid.elevation[selectedCell]!)}</dd></div>
              </dl><span className="small">Forecast hour ending {formatHistoryTime(currentGrid.time, true)}.</span><p className="small">ICON-CH1 control · {currentGrid.resolutionKm} km native detail. This is the nearest model cell, not a measured fog ceiling.</p></>}
            </section>}

            {selected && <section ref={detailRef} className="station-detail" aria-label={`Details for ${selected.name}`}>
              <button className="icon-button detail-close" onClick={() => setSelectedId(undefined)} aria-label="Close station details"><X size={16} /></button>
              <div className="eyebrow">A CLOSER LOOK · {selected.id}</div><h3>{selected.name}</h3>
              <span className="small">{selected.canton} · {metres(selected.elevation)} above sea level</span>
              <div className="detail-status" style={{ color: STATUS[selectedStatus].color }}><WeatherIcon status={selectedStatus} /><strong>{STATUS[selectedStatus].label}</strong></div>
              <p>{STATUS[selectedStatus].description}</p>
              {selectedConditions && <><dl className="detail-metrics"><div><dt>{mode === 'history' ? 'Mean temperature' : 'Temperature'}</dt><dd>{selectedConditions.temperature === null ? 'Unavailable' : `${selectedConditions.temperature.toFixed(1)} °C`}</dd></div><div><dt>Sunshine / {mode === 'observations' ? '10 min' : 'hour'}</dt><dd>{selectedConditions.sunshineMinutes === null ? 'Unavailable' : `${Math.round(selectedConditions.sunshineMinutes)} min`}</dd></div>{mode === 'forecast' && <div><dt>Low cloud cover</dt><dd>{selectedConditions.lowCloud === null ? 'Unavailable' : `${Math.round(selectedConditions.lowCloud)}%`}</dd></div>}</dl><span className="small">{mode === 'history' ? 'Measured hour ending' : mode === 'observations' ? 'Measured' : 'Forecast for'} {(mode === 'history' ? formatHistoryTime : formatTime)(selectedConditions.time, true)}</span></>}
              {mode === 'history' && !selectedConditions && historyTime && <p className="small">No measurement for the hour ending {formatHistoryTime(historyTime, true)}. It may be missing or not yet published.</p>}
              {mode === 'forecast' && forecasts.dataset?.data[selected.id] && <p className="small">Forecast elevation: {metres(forecasts.dataset.data[selected.id].modelElevation)}. Low cloud cover is not a fog-top measurement.</p>}
              {areaEnabled && <p className="small">Station forecast via Open-Meteo; its model run can differ from the native area layer.</p>}
              <a className="station-link" href={`https://map.geo.admin.ch/?lang=en&topic=ech&bgLayer=ch.swisstopo.pixelkarte-farbe&swisssearch=${encodeURIComponent(selected.name)}`} target="_blank" rel="noreferrer">Explore on the Swiss map <ArrowUpRight size={14} /></a>
            </section>}

            <div className="list-heading"><h3>{sunnyOnly ? 'Sunny stations' : 'Explore stations'}</h3><span>{filtered.length} {filtered.length === 1 ? 'place' : 'places'}</span></div>
            <div className="station-list">
              {errors.length > 0 ? <div className="empty-state"><Cloud size={28} /><strong>Weather is unavailable.</strong><p>Retry using the button above. Stations without weather for the selected time are marked as missing, not cloudy.</p></div> : initialLoading ? <div className="empty-state"><Sun size={28} /><strong>Looking for the bright side...</strong><p>{mode === 'history' ? 'Loading measured hourly history across Switzerland. The first load can take a moment.' : mode === 'forecast' ? 'Loading hourly forecasts across Switzerland. The first load can take a moment.' : 'Fetching real MeteoSwiss observations.'}</p></div> : filtered.length === 0 ? <div className="empty-state"><Cloud size={30} /><strong>No stations match.</strong><p>Try a lower altitude or switch off the sunshine filter. At night, no stations are classified as sunny.</p><button onClick={() => { setMinElevation(0); setSearch(''); setSunnyOnly(false); }}>Clear filters</button></div> : filtered.slice(0, showAll ? undefined : 8).map(({ station, conditions, status }) =>
                <button className={`station-card ${selectedId === station.id ? 'selected' : ''}`} key={station.id} onClick={() => { setSelectedId(station.id); setGridPoint(undefined); }}>
                  <span className="weather-badge" style={{ color: STATUS[status].color }}><WeatherIcon status={status} size={22} /></span>
                  <span className="station-card-text"><strong>{station.name}</strong><span>{metres(station.elevation)} <span className="separator">/</span> {station.canton}</span></span>
                  <span className="station-card-right"><span>{conditions?.temperature != null ? `${Math.round(conditions.temperature)}°` : '--'}</span><small>{STATUS[status].label}</small></span><ChevronRight size={14} />
                </button>)}
            </div>
            {filtered.length > 8 && <button className="all-stations" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show fewer stations' : `See all ${filtered.length} stations`}<ArrowDown size={14} /></button>}
            <div className="sidebar-note"><Info size={16} /><p>A sunny summit isn't proof of being above fog. <button onClick={() => setShowSources(true)}>Here's what the data can tell us.</button></p></div>
          </aside>

          <div className="map-area">
            <MapContainer ref={mapRef} center={[46.8, 8.2]} zoom={7} minZoom={6} maxZoom={17} className="swiss-map" scrollWheelZoom={true} aria-label="Interactive Swiss sunshine map">
              <TileLayer url="https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/{z}/{x}/{y}.jpeg" bounds={[[45.7, 5.9], [47.9, 10.6]]} attribution='Map &copy; <a href="https://www.swisstopo.admin.ch/">swisstopo</a>' eventHandlers={{ tileerror: () => setTileError(true) }} />
              <MapFocus station={selected} reset={mapReset} />
              {areaEnabled && <GridLayer grid={currentGrid} minimumElevation={minElevation} sunnyOnly={sunnyOnly} selected={gridPoint} onSelect={selectGridPoint} />}
              {filtered.filter(({ station }) => !areaEnabled || showStationDots || station.id === selectedId).map(({ station, conditions, status }) => <CircleMarker key={station.id} center={[station.latitude, station.longitude]} radius={selectedId === station.id ? 11 : status === 'sunny' ? 8 : 6} bubblingMouseEvents={false} pathOptions={{ color: selectedId === station.id ? '#293d32' : '#fff', weight: selectedId === station.id ? 3 : 2, fillColor: STATUS[status].color, fillOpacity: 0.95 }} eventHandlers={{ click: () => { setSelectedId(station.id); setGridPoint(undefined); } }}>
                <Popup><div className="map-popup"><strong>{station.name}</strong><span>{metres(station.elevation)} · {station.canton}</span><b style={{ color: STATUS[status].color }}>{STATUS[status].label}</b>{conditions && <span>{mode === 'history' ? `Hour ending ${formatHistoryTime(conditions.time, true)}` : formatTime(conditions.time, true)}</span>}</div></Popup>
              </CircleMarker>)}
            </MapContainer>
            <div className="map-top-label">{mode === 'history' ? <History size={12} /> : <span className="live-dot" />}<span>{areaEnabled ? 'ICON-CH1 AREA FORECAST · 1.1 KM' : `${mode === 'history' ? 'PAST OBSERVATIONS' : mode === 'observations' ? 'REAL OBSERVATIONS' : 'HOURLY FORECAST'} · ${filtered.length} ${filtered.length === 1 ? 'STATION' : 'STATIONS'}`}</span></div>
            <button className="map-reset" aria-label="Show all of Switzerland" onClick={() => { setSelectedId(undefined); setGridPoint(undefined); setMapReset((value) => value + 1); }}><Compass size={20} /></button>
            {mode === 'forecast' && <div className="layer-controls">
              <label><input type="checkbox" checked={areaForecast} onChange={(event) => setAreaForecast(event.target.checked)} />Area forecast</label>
              {areaEnabled && <label><input type="checkbox" checked={showStationDots} onChange={(event) => setShowStationDots(event.target.checked)} />Station forecast dots</label>}
              {areaEnabled && <button disabled={!currentGrid} onClick={() => { const centre = mapRef.current?.getCenter(); if (centre) selectGridPoint({ latitude: centre.lat, longitude: centre.lng }); }}><MapPin size={13} />Inspect map centre</button>}
            </div>}
            {gridLoading && <div className="grid-loading" role="status"><RefreshCw size={15} className="grid-spinner" />Loading the native forecast grid...</div>}
            {noNativeHours && <div className="tile-error" role="alert">No future hours are available in this native run. Refresh, or switch off Area forecast for the station timeline.</div>}
            {tileError && <div className="tile-error" role="alert">Some swisstopo map tiles could not load. Weather markers are still available. Reload to retry.</div>}
            <div className="map-bottom">
              <div className="legend"><span><i style={{ background: STATUS.sunny.color }} />Sunshine</span><span><i style={{ background: STATUS.mixed.color }} />Some sunshine</span><span><i style={{ background: STATUS['no-sun'].color }} />{mode === 'forecast' ? 'Cloud / low cloud risk' : 'No sunshine'}</span><span><i style={{ background: STATUS.night.color }} />Night</span><span><i style={{ background: STATUS.unknown.color }} />{mode === 'observations' ? 'Missing / stale' : 'Missing data'}</span></div>
              <div className="time-panel">
                {mode === 'observations' ? <><div className="time-panel-icon"><MapPin size={21} /></div><div><strong>The view, right now.</strong><p>Measured sunshine in the last 10-minute period.</p></div><span className="time-live"><span className="live-dot" />{active.dataset ? 'OBSERVATIONS' : 'CONNECTING'}</span></> : <div className="forecast-timeline">
                  {mode === 'history' && <div className="history-days" aria-label="Historical day">{days.map((day) => <button key={day.date} aria-label={`${day.label}, ${day.date}`} aria-pressed={day.date === historyDate} className={day.date === historyDate ? 'active' : ''} onClick={() => setHistoryDate(day.date)}>{day.label}</button>)}</div>}
                  <div className="timeline-title"><div><span className="eyebrow">{mode === 'history' ? 'MEASURED HOUR ENDING' : areaEnabled ? 'FORECAST HOUR ENDING' : 'PICK YOUR MOMENT'}</span><strong>{timelineTime ? displayTimelineTime(timelineTime, true) : mode === 'history' ? 'No completed hours yet' : noNativeHours ? 'No native hours available' : 'Loading forecast...'}</strong></div><span className="forecast-label">{mode === 'history' ? 'Hourly observations' : areaEnabled ? 'Native model hours' : 'Next 48 hours'}</span></div>
                  <input type="range" aria-label={mode === 'history' ? 'Historical hour' : 'Forecast hour'} min="0" max={Math.max(0, timelineTimes.length - 1)} value={mode === 'history' ? pastHourIndex : currentHourIndex} disabled={!timelineTimes.length || (!areaEnabled && !active.dataset)} onChange={(event) => { const value = timelineTimes[Number(event.target.value)]; if (mode === 'history') setHistoryTime(value); else setTime(value); }} />
                  <div className="range-labels"><span>{timelineTimes[0] && displayTimelineTime(timelineTimes[0], true)}</span><span>{timelineTimes.at(-1) && displayTimelineTime(timelineTimes.at(-1)!, true)}</span></div>
                  {mode === 'history' && <p className="history-caption">Sunshine total and mean temperature for the preceding hour. Publication may lag.</p>}
                  {areaEnabled && <p className="grid-caption">Source: MeteoSwiss · ICON-CH1 control · nearest-cell shading. Click an area for details. No fog-top altitude is inferred.</p>}
                </div>}
              </div>
            </div>
          </div>
        </div>
      </section>
      <footer><span><Sun size={15} /> Made for a little more daylight.</span><span>Source: MeteoSwiss · Forecasts via Open-Meteo · Map: swisstopo <button onClick={() => setShowSources(true)}>Sources & limitations <ArrowUpRight size={12} /></button></span></footer>
    </main>
    {showSources && <Sources close={() => setShowSources(false)} />}
  </div>;
}
