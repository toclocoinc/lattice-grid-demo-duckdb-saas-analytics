/**
 * The entry point: starts DuckDB, builds the dashboard, reports readiness.
 * Nothing is awaited at the top level (a pending top-level await keeps the
 * document in its loading state); `start()` is called and the module finishes.
 */
import * as LG from './node_modules/@toclocoinc/lattice-grid/lattice-grid.esm.min.js';
import { createChart } from './node_modules/@toclocoinc/lattice-grid/modules/charts.esm.min.js';
import { createKPI } from './node_modules/@toclocoinc/lattice-grid/modules/kpi.esm.min.js';
import { DEMO_LICENCE } from './src/licence.js';
import { startDuckDB, recordingConnection } from './src/duckdb.js';
import { buildDashboard } from './src/dashboard.js';

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
  return (next) => { p.textContent = next; };
}

async function start() {
  const started = performance.now();
  const update = panel(TITLE, 'Starting DuckDB in your browser...');
  try {
    const { connection, version, close } = await startDuckDB(update);
    update('Opening the Parquet files...');
    const built = await buildDashboard({
      root, LG, createChart, createKPI, connection, recordSql: recordingConnection, duckdbVersion: version,
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
