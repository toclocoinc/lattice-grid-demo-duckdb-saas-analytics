/**
 * The entry point: starts DuckDB, builds the dashboard, reports readiness.
 * Nothing is awaited at the top level (a pending top-level await keeps the
 * document in its loading state); `start()` is called and the module finishes.
 */
import * as LG from 'https://cdn.latticegrid.dev/lattice-grid@1.111.7/lattice-grid.esm.min.js?v=20261022';
import { createChart } from 'https://cdn.latticegrid.dev/lattice-grid@1.111.7/modules/charts.esm.min.js?v=20261022';
import { createKPI } from 'https://cdn.latticegrid.dev/lattice-grid@1.111.7/modules/kpi.esm.min.js?v=20261022';
import { DEMO_LICENCE } from './src/licence.js';
import { startDuckDB, recordingConnection } from './src/duckdb.js';
import { buildDashboard } from './src/dashboard.js';
import { createStatus, megabytes } from './src/loading.js';

/* Applied before anything is drawn: a grid keeps the licence in force when it was built. */
LG.setLicence(DEMO_LICENCE);

const root = document.querySelector('#app');
const TITLE = 'Your customers’ dashboards, served from Parquet';

/* ---- theme: follows the system until the visitor picks one ---- */
const media = window.matchMedia('(prefers-color-scheme: dark)');
const applyTheme = (theme) => {
  document.documentElement.dataset.theme = theme;
  const button = document.querySelector('[data-theme-toggle]');
  if (button) {
    button.textContent = theme === 'dark' ? 'Light mode' : 'Dark mode';
    button.setAttribute('aria-pressed', String(theme === 'dark'));
  }
};
applyTheme(media.matches ? 'dark' : 'light');
document.addEventListener('click', (event) => {
  if (event.target.closest?.('[data-theme-toggle]')) {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  }
});

/** The failure screen: replaces everything with what went wrong. */
function panel(title, message, extra) {
  root.textContent = '';
  const box = document.createElement('div');
  box.className = 'loading';
  const h = document.createElement('h1');
  h.textContent = title;
  const p = document.createElement('p');
  p.className = 'loading-message';
  p.textContent = message;
  box.append(h, p);
  if (extra) {
    const e = document.createElement('p');
    e.className = 'loading-message';
    e.textContent = extra;
    box.append(e);
  }
  root.append(box);
}

async function start() {
  const started = performance.now();
  /* The status line is in index.html, so it is there from first paint. */
  const status = createStatus(root.querySelector('.load-status'));
  try {
    const { connection, version, close, reads } = await startDuckDB(
      (message) => status.set(message),
      ({ loaded, total }) => status.set(
        `Downloading the query engine (${megabytes(total)}, first visit only): ${megabytes(loaded)} of ${megabytes(total)}`,
        loaded / total,
      ),
    );
    status.set('Reading the customer list');
    const built = await buildDashboard({
      root, LG, createChart, createKPI, connection, recordSql: recordingConnection, duckdbVersion: version, reads, status,
    });
    applyTheme(document.documentElement.dataset.theme);
    window.addEventListener('pagehide', () => { built.destroy(); close(); }, { once: true });
    built.ready = true;
    built.bootMs = Math.round(performance.now() - started);
    window.__saasDemo = built;
    console.log('[saas demo] ready', { ms: built.bootMs, duckdb: version, tenant: built.tenantId });
  } catch (error) {
    window.__saasDemo = { ready: false, error: String(error?.message ?? error) };
    panel(
      'The dashboard could not be loaded', String(error?.message ?? error),
      'This page runs DuckDB compiled to WebAssembly and reads Parquet files with HTTP range requests. '
      + 'It needs a browser with WebAssembly and a host that answers 206 Partial Content.',
    );
    console.error('[saas demo]', error);
  }
}

start();
