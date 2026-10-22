/**
 * Load the page in headless Chrome against the local data and check what it says.
 *
 * Every figure the page shows is recomputed here by a second DuckDB (Node), over
 * the same Parquet files, with the SQL written out independently:
 *
 *   - the four KPI tiles for the opening tenant;
 *   - the usage grid's match count and first row, the invoices grid's count;
 *   - a header click that sorts, a quick search, a column filter, a grouping,
 *     the histogram counts: each compared with Node's answer;
 *   - the charts drew marks;
 *   - switching tenant (a real change event on the select): KPIs and counts
 *     are the new tenant's, no row of the old tenant remains, every statement
 *     carries the new tenant bound, and the switch time is printed;
 *   - clearing the filters does not widen the tenant scope;
 *   - no console errors, no NaN/undefined text, no watermark.
 *
 * Needs data in data/: `npm run build-data -- --scale small`.
 *
 *   node tools/verify.mjs [--shots <dir>]
 */
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';
import { OPENING_TENANT_ID } from '../src/config.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const shotIndex = args.indexOf('--shots');
const shotDir = shotIndex >= 0 ? resolve(args[shotIndex + 1]) : null;
const AS_OF = '2026-09-30';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

async function findChrome() {
  for (const path of CHROME_CANDIDATES) {
    try { await access(path); return path; } catch { /* next */ }
  }
  throw new Error(`No browser found. Tried:\n  ${CHROME_CANDIDATES.join('\n  ')}\nSet CHROME_PATH.`);
}

const failures = [];
function check(ok, description, detail) {
  const line = `${description}${detail !== undefined ? ` (${detail})` : ''}`;
  if (!ok) failures.push(line);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${line}`);
}

/* ------------------------------------------------------------------ */
/* The independent answer                                               */
/* ------------------------------------------------------------------ */

async function openNode() {
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const db = await DuckDBInstance.create(':memory:');
  const conn = await db.connect();
  const file = (n) => join(root, 'data', `${n}.parquet`).replaceAll("'", "''");
  const rows = async (sql) => (await conn.runAndReadAll(sql)).getRowObjects();
  const n = (v) => (typeof v === 'bigint' ? Number(v) : (v == null ? null : Number(v)));
  const ev = `read_parquet('${file('usage_events')}')`;
  const inv = `read_parquet('${file('invoices')}')`;
  const ten = `read_parquet('${file('tenants')}')`;
  const weekly = (t) => `(SELECT feature, CAST(date_trunc('week', event_time) AS DATE) AS week, count(*) AS events
                          FROM ${ev} WHERE tenant_id = ${t} GROUP BY 1, 2)`;
  return {
    async tenants() { return rows(`SELECT tenant_id, plan, churn_date FROM ${ten} ORDER BY tenant_id`); },
    async opening() { return OPENING_TENANT_ID; },
    async kpis(t) {
      const since = `TIMESTAMP '${AS_OF}' + INTERVAL 1 DAY - INTERVAL 30 DAY`;
      const a = (await rows(`SELECT count(DISTINCT user_id) AS u, count(*) AS e FROM ${ev} WHERE tenant_id = ${t} AND event_time >= ${since}`))[0];
      const m = (await rows(`SELECT coalesce(sum(amount),0) AS v FROM ${inv} WHERE tenant_id = ${t} AND period_start = DATE '2026-09-01'`))[0];
      const o = (await rows(`SELECT count(*) AS c FROM ${inv} WHERE tenant_id = ${t} AND status = 'overdue'`))[0];
      return { active: n(a.u), events: n(a.e), mrr: n(m.v), overdue: n(o.c) };
    },
    async usageCount(t, where = 'true') { return n((await rows(`SELECT count(*) AS c FROM ${weekly(t)} WHERE ${where}`))[0].c); },
    async usageMaxWeek(t) { return String((await rows(`SELECT strftime(max(week), '%Y-%m-%d') AS w FROM ${weekly(t)}`))[0].w); },
    async usageMinEvents(t) { return n((await rows(`SELECT min(events) AS v FROM ${weekly(t)}`))[0].v); },
    async features(t) { return (await rows(`SELECT feature, sum(events) AS e FROM ${weekly(t)} GROUP BY 1`)).map((r) => ({ feature: r.feature, events: n(r.e) })); },
    async totalEvents(t) { return n((await rows(`SELECT sum(events) AS v FROM ${weekly(t)}`))[0].v); },
    async invoiceCount(t) { return n((await rows(`SELECT count(*) AS c FROM ${inv} WHERE tenant_id = ${t}`))[0].c); },
    async mrrMonths(t) { return n((await rows(`SELECT count(DISTINCT period_start) AS c FROM ${inv} WHERE tenant_id = ${t}`))[0].c); },
    close() { conn.closeSync(); },
  };
}

/* ------------------------------------------------------------------ */
/* The browser                                                          */
/* ------------------------------------------------------------------ */

let browser = null;
let profile = null;
let served = null;
const cleanup = async () => {
  if (browser?.pid) { try { process.kill(-browser.pid, 'SIGKILL'); } catch { /* gone */ } }
  served?.server?.close();
  if (profile) await rm(profile, { recursive: true, force: true }).catch(() => {});
};

async function run() {
  if (typeof WebSocket === 'undefined') throw new Error(`This check needs Node 22 or newer. You are on ${process.version}.`);
  try { await access(join(root, 'data', 'usage_events.parquet')); } catch {
    throw new Error('No data in data/. Run: npm run build-data -- --scale small');
  }
  const chromePath = await findChrome();
  const truth = await openNode();
  served = await startServer(0);
  const origin = `http://127.0.0.1:${served.port}`;
  console.log(`Browser: ${chromePath}\nServing: ${origin}`);

  profile = await mkdtemp(join(tmpdir(), 'saas-verify-'));
  const port = await new Promise((ok, fail) => {
    import('node:net').then(({ createServer }) => {
      const probe = createServer();
      probe.on('error', fail);
      probe.listen(0, '127.0.0.1', () => { const { port: p } = probe.address(); probe.close(() => ok(p)); });
    });
  });
  browser = spawn(chromePath, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars',
    '--window-size=1440,1000', 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  browser.stderr.on('data', () => {});

  let wsUrl;
  for (let i = 0; i < 150 && !wsUrl; i += 1) {
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl; } catch { await sleep(200); }
  }
  if (!wsUrl) throw new Error('the browser never opened its debugging port');
  const socket = new WebSocket(wsUrl);
  await new Promise((ok, fail) => { socket.onopen = ok; socket.onerror = () => fail(new Error('could not attach to the browser')); });

  let nextId = 0;
  const pending = new Map();
  const consoleErrors = [];
  let sessionId = null;
  socket.onmessage = (event) => {
    const m = JSON.parse(event.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
    if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(`exception: ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') consoleErrors.push(`${m.params.entry.text} ${m.params.entry.url ?? ''}`);
  };
  const send = (method, params = {}, withSession = true) => new Promise((ok) => {
    const id = ++nextId;
    pending.set(id, ok);
    socket.send(JSON.stringify({ id, method, params, ...(withSession && sessionId ? { sessionId } : {}) }));
  });
  const { result: { targetInfos } } = await send('Target.getTargets', {}, false);
  const target = targetInfos.find((t) => t.type === 'page');
  sessionId = (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, false)).result.sessionId;
  for (const domain of ['Runtime', 'Page', 'Log', 'Network']) await send(`${domain}.enable`);

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(`${r.result.exceptionDetails.text} ${r.result.exceptionDetails.exception?.description ?? ''}`);
    return r.result?.result?.value;
  };
  const waitFor = async (expression, ms, what) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      try { if (await evaluate(expression)) return; } catch { /* busy */ }
      await sleep(250);
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  const shoot = async (name) => {
    if (!shotDir) return;
    await mkdir(shotDir, { recursive: true });
    const { result: { data } } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    await writeFile(join(shotDir, `${name}.png`), Buffer.from(data, 'base64'));
  };
  const D = 'window.__saasDemo';
  /** Rows the usage grid holds, as plain objects. */
  const loaded = (id) => evaluate(`(() => { const g = ${D}.grids.${id}; const out = []; for (let i = 0; i < g.rows.count(); i++) { const r = g.rows.get(i); const d = r && r.data; if (d && d.tenant_id != null) out.push({ tenant_id: Number(d.tenant_id), week: new Date(Number(d.week)).toISOString().slice(0, 10), feature: d.feature, events: Number(d.events) }); } return out; })()`);
  const settled = (id, expected) => waitFor(`${D}.timings.${id}.matches === ${expected} && ${D}.grids.${id}.rows.count() > 0 || (${expected} === 0 && ${D}.timings.${id}.matches === 0)`, 30000, `${id} to settle on ${expected} rows`);

  /* ---------------------------------------------------------------- */
  console.log('\nOpen the page');
  await send('Page.navigate', { url: `${origin}/?data=local` });
  await waitFor(`!!${D}`, 180000, 'the page to report in');
  const state = await evaluate(`({ ready: ${D}.ready, error: ${D}.error || null })`);
  if (!state.ready) throw new Error(`the page reported a failure: ${state.error}`);
  const start = await truth.opening();
  const tenants = await truth.tenants();
  check(await evaluate(`${D}.tenantId`) === start, 'opens on the mid-size tenant named in src/config.js', start);
  check(await evaluate(`${D}.tenants.length`) === tenants.length, 'the switcher lists every tenant', tenants.length);

  console.log('\nKPI strip');
  const expectedKpis = await truth.kpis(start);
  const kpis = await evaluate(`${D}.kpis`);
  for (const key of ['active', 'events', 'mrr', 'overdue']) check(Math.abs(kpis[key] - expectedKpis[key]) < 0.01, `KPI ${key}`, `${kpis[key]} vs ${expectedKpis[key]}`);
  const tileText = await evaluate("document.querySelector('.kpi-strip').innerText");
  check(tileText.includes(expectedKpis.events.toLocaleString('en-US')), 'the events tile shows the figure', expectedKpis.events);

  console.log('\nUsage grid');
  const usageTotal = await truth.usageCount(start);
  await settled('usage', usageTotal);
  check(await evaluate(`${D}.timings.usage.matches`) === usageTotal, 'usage rows match', usageTotal);
  const firstRows = await loaded('usage');
  check(firstRows[0]?.week === await truth.usageMaxWeek(start), 'first row is the latest week', firstRows[0]?.week);
  check(firstRows.every((r) => r.tenant_id === start), 'every loaded row belongs to the tenant', `${firstRows.length} rows`);
  const invoiceTotal = await truth.invoiceCount(start);
  await settled('invoices', invoiceTotal);
  check(await evaluate(`${D}.timings.invoices.matches`) === invoiceTotal, 'invoice rows match', invoiceTotal);

  console.log('\nCharts');
  const marks = (id) => evaluate(`document.querySelectorAll('[data-chart=${id}] svg rect, [data-chart=${id}] svg path').length`);
  check(await marks('adoption') > 10, 'adoption chart drew marks', await marks('adoption'));
  check(await marks('mrr') > 10, 'MRR chart drew marks', await marks('mrr'));
  check(await evaluate(`${D}.chartGrids.mrr.rows.count()`) === await truth.mrrMonths(start), 'MRR chart has one bar per invoiced month', await truth.mrrMonths(start));

  console.log('\nHistograms');
  const facetOf = (col) => evaluate(`(() => { const f = ${D}.grids.usage.facets.get('${col}'); return f && f.bounds ? { n: f.bounds.buckets.length, sum: Array.from(f.counts || []).reduce((a, b) => a + b, 0) } : null; })()`);
  await waitFor(`${D}.grids.usage.facets.get('feature') && ${D}.grids.usage.facets.get('feature').counts`, 20000, 'the feature histogram');
  const feats = await truth.features(start);
  const fh = await facetOf('feature');
  check(fh?.n === feats.length && fh.sum === usageTotal, 'feature histogram: one bar per feature, counts sum to the rows', JSON.stringify(fh));
  await waitFor(`${D}.grids.usage.facets.get('events') && ${D}.grids.usage.facets.get('events').counts`, 20000, 'the events histogram');
  const eh = await facetOf('events');
  check(eh?.sum === usageTotal, 'events histogram counts sum to the rows', eh?.sum);
  await shoot('opened');

  console.log('\nSort by header click');
  const clickAt = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const headerBox = await evaluate(`(() => { const h = [...document.querySelectorAll('[data-view=usage] [role=columnheader]')].find((c) => c.innerText.trim().startsWith('Events')); if (!h) return null; h.scrollIntoView({ block: 'center' }); const r = h.getBoundingClientRect(); return { x: r.left + 20, y: r.top + 12 }; })()`);
  check(!!headerBox, 'the Events header is on the page');
  await clickAt(headerBox.x, headerBox.y);
  const minEvents = await truth.usageMinEvents(start);
  await waitFor(`(() => { const g = ${D}.grids.usage; const r = g.rows.get(0); return r && r.data && Number(r.data.events) === ${minEvents}; })()`, 20000, 'the ascending sort');
  check(true, 'ascending sort puts the smallest weekly count first', minEvents);

  console.log('\nQuick search, filter, grouping');
  const sharing = await truth.usageCount(start, "feature LIKE '%sharing%'");
  await evaluate(`${D}.grids.usage.filters.quick('sharing')`);
  await settled('usage', sharing);
  check(await evaluate(`${D}.timings.usage.matches`) === sharing, 'quick search "sharing" matches Node', sharing);
  await evaluate(`${D}.grids.usage.filters.quick('')`);
  await settled('usage', usageTotal);
  const big = await truth.usageCount(start, 'events >= 100');
  await evaluate(`${D}.grids.usage.filters.set({ col: 'events', op: 'gte', value: 100 })`);
  await settled('usage', big);
  check(await evaluate(`${D}.timings.usage.matches`) === big, 'events >= 100 matches Node', big);
  const chartFollows = await evaluate(`${D}.chartGrids.adoption.rows.count()`);
  check(chartFollows > 0, 'the adoption chart follows the grid filter', chartFollows);
  await evaluate(`${D}.grids.usage.filters.clear()`);
  await settled('usage', usageTotal);
  check(await evaluate(`${D}.timings.usage.matches`) === usageTotal, 'clearing the filters keeps the tenant scope (same rows, not every tenant)', usageTotal);
  await evaluate(`${D}.group(['feature'])`);
  const groupRows = `(() => { const g = ${D}.grids.usage; let n = 0; for (let i = 0; i < g.rows.count(); i++) { const r = g.rows.get(i); if (r && r.group && r.level === 0) n += 1; } return n; })()`;
  await waitFor(`${groupRows} > 0`, 30000, 'the grouped rows');
  const grouped = await evaluate(groupRows);
  check(grouped === feats.length, 'grouping by feature shows one group row per feature', `${grouped} vs ${feats.length}`);
  await shoot('grouped');
  await evaluate(`${D}.group([])`);
  await settled('usage', usageTotal);

  console.log('\nSwitch tenant');
  const other = tenants.find((t) => t.plan === 'free' && t.churn_date == null) ?? tenants.find((t) => t.plan === 'team');
  const otherId = Number(other.tenant_id);
  const t0 = Date.now();
  await evaluate(`(() => { const s = document.querySelector('[data-tenant]'); s.value = '${otherId}'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor(`${D}.lastSwitchMs != null && ${D}.tenantId === ${otherId} && /loaded in/.test(document.querySelector('[data-switch-timing]').textContent)`, 30000, 'the switch to finish');
  const wall = Date.now() - t0;
  const reported = await evaluate(`${D}.lastSwitchMs`);
  console.log(`  switch: ${reported} ms measured by the page, ${wall} ms wall clock`);
  check(reported < 5000, 'a switch re-scopes every view in a few seconds', `${reported} ms`);
  const k2 = await truth.kpis(otherId);
  const kk = await evaluate(`${D}.kpis`);
  for (const key of ['active', 'events', 'mrr', 'overdue']) check(Math.abs(kk[key] - k2[key]) < 0.01, `KPI ${key} after the switch`, `${kk[key]} vs ${k2[key]}`);
  const u2 = await truth.usageCount(otherId);
  await settled('usage', u2);
  check(await evaluate(`${D}.timings.usage.matches`) === u2, 'usage rows are the new tenant\'s', u2);
  const rows2 = await loaded('usage');
  check(rows2.length > 0 && rows2.every((r) => r.tenant_id === otherId), 'no row of the previous tenant remains', `${rows2.length} rows`);
  const i2 = await truth.invoiceCount(otherId);
  await settled('invoices', i2);
  check(await evaluate(`${D}.timings.invoices.matches`) === i2, 'invoice rows are the new tenant\'s', i2);
  const sql = await evaluate("document.querySelector('[data-plan-sql]').textContent");
  check((sql.match(new RegExp(`-- bound: \\[${otherId}\\]`, 'g')) || []).length === 2, 'the working-set statements carry the new tenant bound', 'tenant_id = ?');
  check(sql.includes('CREATE OR REPLACE TEMP TABLE tenant_events') && !/tenant_id = \d/.test(sql), 'the tenant working set is built with the tenant bound as ?, never a literal');
  await shoot('switched');

  console.log('\nTheme');
  const before = await evaluate('document.documentElement.dataset.theme');
  const toggle = await evaluate(`(() => { window.scrollTo(0, 0); const b = document.querySelector('[data-theme-toggle]'); const r = b.getBoundingClientRect(); return { x: r.left + 8, y: r.top + 8 }; })()`);
  await clickAt(toggle.x, toggle.y);
  await sleep(300);
  const after = await evaluate('document.documentElement.dataset.theme');
  check(before !== after, 'the theme button flips the theme', `${before} -> ${after}`);
  await shoot('theme-flipped');

  console.log('\nHygiene');
  const text = await evaluate('document.body.innerText');
  check(!/\bNaN\b|\bundefined\b|\[object Object\]/.test(text), 'no NaN / undefined / [object Object] text');
  check(await evaluate(`${D}.grids.usage.licence.watermark() === false`), 'no watermark');
  check(consoleErrors.length === 0, 'no console errors', consoleErrors.slice(0, 3).join(' | '));

  truth.close();
}

try {
  await run();
} catch (error) {
  failures.push(String(error?.message ?? error));
  console.log(`\nERROR: ${error?.stack ?? error}`);
} finally {
  await cleanup();
}
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('\nAll checks passed.');
process.exit(0);
