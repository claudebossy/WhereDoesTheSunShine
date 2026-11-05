# Sunward · Where Does the Sun Shine?

An interactive map of Switzerland for finding sunshine, with **real MeteoSwiss
observations**, an **hourly forecast** view and **historical observations**. Search 159 automatic weather
stations (the count can change upstream), filter by altitude or sunshine, select
a station for details, and move through the next 48 hours of predictions.
**Plan ahead** now defaults to a continuous **1.1 km ICON-CH1 area forecast**
decoded directly from MeteoSwiss Open Government Data. Click a coloured area
or use **Inspect map centre** for its forecast. Toggle station forecast dots
as reference locations, or switch off **Area forecast** for the original
48-hour station-only view.
**Look back** shows measured hourly sunshine and mean temperature for **Today,
Yesterday or 2 days ago**, with an hourly slider. Dates and times are Swiss local
time; the history timestamp is the **end** of the measured hour.

## Run locally

Requires Node.js **24+** and npm (the ecCodes WebAssembly decoder uses memory64).
No Python, native ecCodes installation or paid model API is required.

```powershell
npm.cmd install
npm.cmd run dev
```

Open http://127.0.0.1:5173. The React/Vite app proxies weather requests to the
Node/Express server on port 3001. On other platforms, use `npm` instead of
`npm.cmd`.

```powershell
npm.cmd test
npm.cmd run build
npm.cmd start
```

The last command serves the built app and API at http://127.0.0.1:3001.
`PORT` overrides the server port. This is a full-stack application: deploying
only `dist` on a static host does **not** provide the weather API. The server
binds to loopback by default; use a reverse proxy for public hosting. For
static-only hosting without an API, use the snapshot workflow below.

## Publish on GitHub Pages

The workflow in `.github/workflows/pages.yml` builds and deploys the frontend
when changes are pushed to `main`. In the repository's **Settings → Pages**,
select **GitHub Actions** as the build and deployment source. The project site
will be published at `https://<owner>.github.io/WhereDoesTheSunShine/`.

**No separate API host is required for Pages.** The workflow runs hourly at
17 minutes past the hour, and also on pushes and manual runs. It fetches real
station metadata, latest observations and station forecasts, and precomputes
every current/future complete area-forecast hour in one native model run.
`npm run snapshot` writes these datasets under `dist/weather/` after the build.
The Pages build uses `VITE_DATA_MODE=snapshot` to read project-relative JSON
files instead of `/api` endpoints. `VITE_API_BASE_URL` is not used in this mode.

History is collected once per **Swiss calendar day**, on the first successful
run that day, and reused through the Actions cache. Cache eviction can cause an
extra collection. Yesterday is the default history date on Pages; today's
history and any measurements published after collection remain incomplete until
the next daily collection. Missing values are never filled with forecasts.
Station-specific history failures remain visible in the app.

Actions schedules can be delayed, and scheduled workflows only run on the
default branch. For public repositories, GitHub can disable schedules after
60 days without repository activity. Snapshot collection timestamps are shown;
observations retain their real measurement timestamps and the 40-minute stale
threshold, so hourly observations will sometimes be marked out of date.
Forecast/observation snapshots older than two hours and history snapshots older
than 36 hours display an additional warning. Refresh only reloads published
files; it does not fetch new provider data.

Each deployment includes all advertised grid files before publishing. A failed
collection fails the workflow and leaves the previous deployed site intact,
whose timestamps and stale warnings remain visible. Precomputing the area
forecast downloads substantially more data than viewing a single hour; monitor
Actions runtime and Pages artifact limits. It retains the existing ~1 km
display grid rather than inventing station-interpolated area data.

Local development and `npm start` still use the on-demand Node API. To host
the frontend separately in API mode, build without `VITE_DATA_MODE=snapshot`,
set `VITE_API_BASE_URL` to the API's HTTPS origin (no trailing slash), and
configure the API host with `HOST=0.0.0.0` and
`CORS_ORIGIN=https://<owner>.github.io`.

## Data sources

| Data | Source | Refresh / server cache |
| --- | --- | --- |
| Station names, coordinates, altitude | [MeteoSwiss SMN metadata](https://data.geo.admin.ch/ch.meteoschweiz.ogd-smn/ogd-smn_meta_stations.csv) | Daily |
| Latest 10-minute sunshine and temperature | [MeteoSwiss VQHA80](https://data.geo.admin.ch/ch.meteoschweiz.messwerte-aktuell/VQHA80.csv) | Browser: 5 min; server: 2 min; source: about 10 min |
| Historical hourly sunshine and mean temperature | [MeteoSwiss SMN hourly station files](https://opendatadocs.meteoswiss.ch/a-data-groundbased/a1-automatic-weather-stations) (`h_now`, `h_recent`, prior-year archive when needed) | 15 min, on demand |
| Hourly sunshine, temperature, total and low cloud | [MeteoSwiss ICON-CH1 via Open-Meteo](https://open-meteo.com/en/docs/meteoswiss-api) | 30 min, on demand |
| Continuous area forecast | [MeteoSwiss native ICON-CH1 control-run GRIB2](https://opendatadocs.meteoswiss.ch/e-forecast-data/e2-e3-numerical-weather-forecasting-model) | Run index: 15 min; selected-hour grids: bounded memory cache |
| Swiss national map | [swisstopo WMTS](https://www.swisstopo.admin.ch/en/online-maps-and-data) | Provider-managed |

**Source: MeteoSwiss.** Its OGD may be reused with source attribution; see
[terms](https://opendatadocs.meteoswiss.ch/general/terms-of-use).
Forecast delivery through Open-Meteo is attributed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
The public Open-Meteo API is **non-commercial**, limited to 600 calls/minute,
5,000/hour and 10,000/day; multi-location requests count as multiple calls.
This application batches 25 stations per request and caches the entire forecast
for 30 minutes in one server process. Review current
[API terms](https://open-meteo.com/en/terms) before publishing, especially for
commercial use. Multiple server instances need a shared cache and rate limiting.
Station forecasts use an intermediary API for government-model forecasts.
The continuous area layer downloads native MeteoSwiss model data directly
and does not use the Open-Meteo quota.

The Node server handles upstream requests because the government CSV endpoints
do not reliably expose browser CORS headers. Metadata is decoded as Windows-1252
to preserve Swiss place names. Forecast timestamps are requested in UTC; all
display times use `Europe/Zurich`, including daylight-saving changes.
No account, API key, geolocation permission or database is needed.

## What the map means

These are application heuristics, **not official MeteoSwiss weather categories**:

- **Observed sunshine:** at least 8 minutes of sunshine in the measured 10-minute
  interval. Between 0 and 8 means some sunshine; 0 means no direct sunshine.
- **Historical sunshine:** at least 48 minutes in the measured hour (80%, matching
  the live threshold). Between 0 and 48 means some sunshine; 0 means no sunshine.
  Uses official hourly aggregates, not a sum calculated from live snapshots or
  archived forecasts. Historical readings are not marked stale due to their age.
- **Predicted sunshine:** at least 45 minutes/hour, low cloud at most 25% and
  total cloud at most 40%.
- **Low cloud risk (forecast only):** at least 60% low cloud and at most
  2 minutes/hour of sunshine. Low-cloud percentage describes model grid cloud
  cover, not fog at a precise station or a measured cloud ceiling.
- **Night:** solar position below the horizon for observations, model `is_day`
  for predictions. History uses the measured interval midpoint, preserving any
  positive measured sunshine during sunrise/sunset hours. Terrain horizon is not
  modeled.
- **Out of date:** observations more than 40 minutes old or over 10 minutes
  in the future. Missing values are not converted to zero.

The "sunny above 1,000 m" counter is an altitude shortlist, **not an above-fog
classification**. Sunshine, even at high altitude, does not establish that a
fog layer exists below it. This version does not estimate the fog-top altitude
or draw an invented fog polygon. Station forecasts are evaluated at station
locations, while the area layer samples native model cells. Both may miss local
inversions, summit cloud and terrain shade. Check official forecasts, webcams, access and mountain
safety information before travelling.

## Continuous area forecasts

The native ICON-CH1 control run has approximately **1.1 km model resolution** and
a **33-hour horizon**. The area timeline shows only complete available hourly
fields in one run, never a silent switch to a coarser model for later hours.
Its displayed run timestamp can differ from the Open-Meteo station forecasts.
The counters and station cards still refer to station forecast locations, not
the count of shaded pixels. Measured now and Look back remain station
observations; no synthetic historical area forecast is drawn.

`server/native-grid.ts` discovers the latest completed control run through the
government STAC API, checks the parameter catalogue units and decodes GRIB2
using ECMWF ecCodes in WebAssembly. It reads `CLCL`, `CLCT`, `T_2M` and `DURSUN`.
Hourly sunshine is calculated by differencing the **same run's** accumulated
`DURSUN` at consecutive lead times; Kelvin temperature is converted to Celsius.
GRIB forecast/run timestamps, native point counts and `uuidOfHGrid` must match
the static longitude, latitude and terrain grid. Supplied SHA-256 checksums
are verified. Mismatched grids and missing variables fail visibly.

The display samples the **nearest native cell** onto a Web Mercator raster:
1,500 projected metres is about 1 km on the ground in Switzerland. It is not
station interpolation, is not higher-resolution evidence than the native model,
and covers Switzerland plus nearby areas within the map extent. No geographic
fog polygon or fog ceiling is inferred. The altitude filter uses **model terrain**
for pixels and official station altitude for station dots; search filters station
locations only. Model terrain can differ considerably from a summit or valley.
Missing model fields stay missing. Pixel rendering is kept sharp on zoom.

The GRIB decoder and spatial indexing run in a worker thread so the main
weather API remains responsive. Static grid mapping is reused; concurrent loads
of the same hour are coalesced, and at most 20 decoded display grids are cached.
Dragging the hour slider is debounced to reduce upstream downloads, and an
old hour's raster is hidden while the new hour loads. The first area load downloads
about 35 MB of static constants plus the selected hour's GRIB fields; subsequent
loads reuse the constants. Model files are available from the source for only
24 hours after publication. This app does not yet maintain a persistent model
archive for the previous two days.

`GET /api/grid-index` returns the available run and hours.
`GET /api/grid?time=<UTC hour>&run=<UTC run>` returns the matching model raster.
Use canonical hourly ISO timestamps, e.g. `2026-11-02T11:00:00.000Z`.

## Reliability & architecture

React + TypeScript + Leaflet, with an Express API. Shared classification logic
lives in `src/weather.ts`; upstream parsers and memory caches in `server/data.ts`.
Requests have timeouts; concurrent clients share in-flight loads; upstream
failures trigger a one-minute cooldown. A failed batch fails the forecast
dataset rather than silently excluding stations. Errors are visible in the app;
expired cached data are not served as live, and no synthetic/demo weather is
used. Cache timestamps describe retrieval, not the forecast model run time.
Caching resets when the server restarts.

History is served at `/api/history` with a `series` map of station IDs to hourly
readings and an explicit `unavailable` list for failed stations. `server/history.ts`
loads official `now` files and recent file tails using HTTP suffix ranges,
expanding the range if it does not cover the requested dates. This avoids
downloading a full year for every station; providers ignoring ranges still work.
Four workers bound upstream concurrency. Year boundaries include the appropriate
decade archive when needed, and newer `now` readings override duplicate archived
readings. Partial station failures are logged and displayed; failure of every
station fails the request. No missing hour is filled from a neighbouring station,
another time, or a forecast. Today's completed hours can have unpublished
readings; these show **No data**. The timeline preserves missing-hour gaps and
23/25-hour days at daylight-saving changes; CET/CEST labels distinguish repeated
local hours. A cached dataset can take up to 15 minutes to include a new day
after midnight.

Station selection is also available from the searchable list for keyboard
users. Responsive layouts put the map first on small screens. Map tiles and
optional Google Fonts require internet access; typography has local fallbacks.
