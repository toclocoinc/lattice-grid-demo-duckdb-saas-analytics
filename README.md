# lattice-grid-demo-duckdb-saas-analytics

Embedded per-tenant analytics: your customers' dashboards, served from Parquet. One set of Parquet files, DuckDB-Wasm in the browser, [Lattice Grid](https://latticegrid.dev) for the grids, KPI strip and charts. Pick a customer at the top and every view re-scopes to that tenant.

Plain JavaScript, no framework, no bundler, no build step to run the page.

## The embedded pattern

An application with many customers keeps **one** Parquet set (usage events, invoices, tenants) and answers each customer's dashboard with queries over it. The rule an app backend enforces is that every query carries the caller's `tenant_id`. This page does the same, in the browser:

1. **One read per file, tenant bound.** On a tenant switch the page runs two statements, each with the tenant id bound as `?`:
   `CREATE TEMP TABLE tenant_events AS SELECT ... FROM read_parquet('usage_events.parquet') WHERE tenant_id = ?` and the same for invoices.
   The events file is sorted by `tenant_id` then time, in row groups of 100,000 rows, so DuckDB's Parquet statistics skip every row group that cannot hold the tenant and range-read the rest (the largest tenant, about 940,000 events, spans at most ten of the 200 row groups).
2. **Everything else queries that working set.** The usage grid (events by feature by week), the invoices grid, the four KPI tiles, the header histograms and both charts run in DuckDB over the tenant's temporary tables: filter, sort, quick search, group and page are all pushed into SQL by the grid's `duckdbAdapter` / `createPushdownSource`. Because the tenant scope lives in the tables, "clear filters" cannot widen it and no query can reach another tenant's rows.
3. **Charts are bound to the grids.** They call `source.aggregate()` on each grid's own source with the grid's current filter and search, so a chart always shows what its grid shows.

Switching tenant rebuilds the working set and remounts the grids: about 0.5 s at small scale and about 1 s for a typical tenant at full scale (the largest takes about 2 s on localhost).

The tenant id the grids' relations use is an integer the page itself supplies from the switcher; a real backend would bind it the same way the `?` is bound here.

## Loading

The first visit has three slow steps: the query engine (about 34 MB of WebAssembly, a fifth of that on the wire), starting it, and reading the opening tenant from the Parquet file. Nobody should watch a blank page through them, so the page says what it is doing. The pattern, which the other DuckDB demos can copy (`src/loading.js`, `src/duckdb.js`):

1. **A status line in the static HTML** (`index.html`): a spinner, one plain-English sentence and a progress bar, so it is on screen from first paint. `createStatus()` adopts it and updates it; the bar is hidden when the size is not known.
2. **Real byte counts, no second download.** The engine's WebAssembly is fetched by DuckDB-Wasm itself inside `db.instantiate()`, which reports `bytesLoaded` / `bytesTotal`: "Downloading the query engine (33 MB, first visit only): 12 MB of 33 MB", then "Starting the engine". For the Parquet reads, the worker is started through a small wrapper that reports each response size over a `BroadcastChannel`, so the page can show "Reading <tenant> usage (258 KB of 583 KB)". The total is the compressed size of the columns and row groups the read will touch, taken from `parquet_metadata()` (the footer, fetched anyway).
3. **Every panel has a loading state.** `slot(panel, text)` covers a KPI strip, chart or grid until its first answer, and again on each tenant switch, so there is never blank space.
4. **Open on a mid-size tenant** (`OPENING_TENANT_ID` in `src/config.js`); the switcher keeps every tenant.

## Run it

```
npm install
npm run build-data -- --scale small     # ~1M events, ~5 MB, about 25 s. Writes data/*.parquet
npm start                                # http://localhost:<port>/?data=local
npm run verify                           # headless Chrome; needs Node 22 and Chrome
npm test                                 # generator tests
```

`?data=local` reads `./data/` (served with HTTP range support by `tools/serve.mjs`). Without it the page reads `https://data.latticegrid.dev/duckdb/lattice-grid-demo-duckdb-saas-analytics/`. The location is one constant in `src/config.js`.

`npm run build-data` with no arguments builds the full set (20M events, 68 MB, about 40 s) into `data/`; upload `data/*.parquet` to the data host. The Parquet is never committed. See `data/README.md` for row counts, sizes, the data dictionary and licence.

## What `npm run verify` checks

Loads the page in headless Chrome against `data/` and compares against a second DuckDB in Node: the KPI tiles, row counts and first rows of both grids, a header-click sort, quick search, a column filter, grouping, histogram counts, chart marks, a real tenant switch (new tenant's KPIs and rows, none of the previous tenant's, statements carry the new tenant bound), the theme button, no console errors, no `NaN`/`undefined` text, no watermark.

## Layout

```
index.html  main.js  styles.css
src/config.js     data location, as-of date
src/duckdb.js     DuckDB-Wasm start, recording connection
src/model.js      SQL for the working set and KPIs, grid columns
src/loading.js    status line and panel loading states
src/dashboard.js  the page: switcher, KPIs, charts, grids, histograms
tools/            generate.mjs, build-parquet.mjs, serve.mjs, verify.mjs
```

## Licence

MIT. Data is synthetic.
