/**
 * Where the data lives, and the few constants the page shares.
 *
 * **This is the only place the data location is named.** The Parquet set is
 * hosted on data.latticegrid.dev, which answers HTTP range requests with CORS;
 * `?data=local` points the page at `./data/` instead, served by
 * `tools/serve.mjs`, for development against a set you built yourself
 * (`npm run build-data -- --scale small`).
 */
export const DATA_URL = 'https://data.latticegrid.dev/duckdb/lattice-grid-demo-duckdb-saas-analytics/';
export const LOCAL_DATA_URL = './data/';

/** The data folder in force for this page load. Always ends in a slash. */
export function dataBase(search = location.search) {
  const mode = new URLSearchParams(search).get('data');
  const base = mode === 'local' ? LOCAL_DATA_URL : DATA_URL;
  return new URL(base, location.href).href;
}

/** The files the page reads, by table name. */
export const FILES = ['tenants', 'usage_events', 'invoices'];

/**
 * "Now" for the app. The generated data ends on this day, so "the last 30
 * days" and "this month's MRR" are measured from it, not from the visitor's
 * clock (a static data set has no today).
 */
export const AS_OF = '2026-09-30';

/** How far back "active users" looks, in days. */
export const ACTIVE_DAYS = 30;

/**
 * The account the page opens on: Tidal Logistics Partners, a business tenant
 * with about 42,000 events and three years of invoices: a small read with a
 * full dashboard. The largest tenants have around 940,000 events and are one pick
 * away in the switcher. If the id is absent (a different data set), the page
 * opens on the first tenant listed.
 */
export const OPENING_TENANT_ID = 127;
