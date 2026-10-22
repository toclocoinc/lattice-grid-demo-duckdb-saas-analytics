/**
 * The dashboard: one tenant's view of the product, served from Parquet.
 *
 * The idea the page demonstrates: an application with many customers keeps one
 * Parquet set, and each customer's dashboard is a set of queries over it with
 * that customer's `tenant_id` bound into every one. Here that is:
 *
 *   the grids      each runs over the tenant's working set: one `CREATE TEMP TABLE
 *                  ... WHERE tenant_id = ?` per Parquet file, tenant bound, reading
 *                  only that tenant's row groups, once. Each filter, sort, quick
 *                  search, group and page the grid pushes into DuckDB is then
 *                  scoped to the tenant by construction; "clear filters" cannot
 *                  widen it.
 *   the KPI strip  four statements over the same working set.
 *   the charts     `source.aggregate()` over each grid's own source and current
 *                  filters, so a chart always shows what its grid shows.
 *
 * Switching tenant changes one value and re-runs the views.
 */
import { FILES, OPENING_TENANT_ID, dataBase } from './config.js';
import { megabytes, slot } from './loading.js';
import {
  INVOICES_TABLE, INVOICE_COLUMNS, INVOICE_FIELDS, KPI_SQL, USAGE_TABLE, TENANTS_SQL, USAGE_COLUMNS, USAGE_FIELDS,
  eventsReadBytesSql, eventsScopeSql, fmt, invoicesScopeSql, num, usageScopeSql,
} from './model.js';

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

const TOP_FEATURES = 6;
const VIEWS = ['usage', 'invoices'];

export async function buildDashboard({ root, LG, createChart, createKPI, connection, recordSql, duckdbVersion, reads, status }) {
  const base = dataBase();
  const built = {
    ready: false,
    base,
    tenantId: null,
    tenants: [],
    kpi: null,
    kpis: null,
    charts: {},
    chartGrids: {},
    grids: {},
    sources: {},
    timings: {},
    lastSwitchMs: null,
    duckdbVersion,
    files: FILES,
  };

  /* ------------------------------------------------------------------ */
  /* The tenant list                                                     */
  /* ------------------------------------------------------------------ */

  const tenantRows = (await connection.query(TENANTS_SQL(base))).toArray().map((r) => {
    const row = r.toJSON();
    return {
      tenant_id: num(row.tenant_id), name: String(row.name), plan: String(row.plan), region: String(row.region),
      churned: row.churn_date != null,
    };
  });
  built.tenants = tenantRows;
  /* The account to open on: a mid-size tenant (see config.js), or the first listed. */
  const startTenant = (tenantRows.find((t) => t.tenant_id === OPENING_TENANT_ID) ?? tenantRows[0]).tenant_id;

  /* ------------------------------------------------------------------ */
  /* The frame                                                           */
  /* ------------------------------------------------------------------ */

  root.textContent = '';
  root.className = 'app';

  const header = el('header', 'masthead');
  const titleRow = el('div', 'title-row');
  titleRow.append(el('h1', null, 'Your customers’ dashboards, served from Parquet'));
  const themeButton = el('button', 'theme-toggle', 'Dark mode');
  themeButton.type = 'button';
  themeButton.dataset.themeToggle = '';
  titleRow.append(themeButton);
  header.append(titleRow);
  header.append(el(
    'p', 'lede',
    'Every account in a SaaS product shares one set of Parquet files. Pick a customer and each view below '
    + 'runs a query with that customer’s id bound into the WHERE clause, inside DuckDB in your browser: '
    + 'usage, invoices and charts, scoped to one tenant and re-scoped in about a second when you switch.',
  ));
  root.append(header);
  root.append(status.el);

  const tenantBar = el('section', 'tenant-bar');
  tenantBar.setAttribute('aria-label', 'Tenant');
  const switchLabel = el('label', 'tenant-label', 'Customer');
  switchLabel.htmlFor = 'tenant-select';
  const select = el('select', 'tenant-select');
  select.id = 'tenant-select';
  select.dataset.tenant = '';
  for (const t of tenantRows) {
    const option = el('option', null, `${t.name} · ${t.plan} · ${t.region}${t.churned ? ' · churned' : ''}`);
    option.value = String(t.tenant_id);
    select.append(option);
  }
  const scopeNote = el('p', 'scope-note');
  scopeNote.dataset.scope = '';
  const switchTiming = el('p', 'switch-timing');
  switchTiming.dataset.switchTiming = '';
  tenantBar.append(switchLabel, select, scopeNote, switchTiming);
  root.append(tenantBar);

  const kpiHost = el('section', 'kpi-strip');
  kpiHost.setAttribute('aria-label', 'Key figures for this tenant');
  const kpiSlot = slot(kpiHost, 'Waiting for the usage data, then the key figures');
  root.append(kpiSlot.el);

  const chartSection = el('section', 'charts');
  chartSection.setAttribute('aria-label', 'Charts');
  const chartBoxes = {};
  const chartSlots = {};
  for (const id of ['adoption', 'mrr']) {
    const box = el('div', 'chart-box');
    box.dataset.chart = id;
    const covered = slot(box, 'Waiting for the usage data, then this chart');
    chartSection.append(covered.el);
    chartBoxes[id] = box;
    chartSlots[id] = covered;
  }
  root.append(chartSection);

  const viewSection = (id, title, blurb) => {
    const section = el('section', 'view');
    section.dataset.view = id;
    const head = el('div', 'view-head');
    head.append(el('h2', null, title));
    const stat = el('p', 'view-stat');
    stat.dataset.viewStat = id;
    head.append(stat);
    section.append(head, el('p', 'view-note', blurb));
    const host = el('div', 'grid-host');
    host.dataset.grid = id;
    const covered = slot(host, 'Waiting for the usage data, then these rows');
    section.append(covered.el);
    root.append(section);
    return { host, stat, covered };
  };
  const views = {
    usage: viewSection('usage', 'Usage', 'Events by feature by week. Type in the search box, filter a column, click a histogram bar, or group by feature: each of those becomes SQL.'),
    invoices: viewSection('invoices', 'Invoices', 'One invoice per month for paying tenants. Free-plan tenants have none.'),
  };

  const sqlPanel = el('details', 'sql-panel');
  sqlPanel.dataset.sqlPanel = '';
  const sqlPre = el('pre', 'plan-sql');
  sqlPre.dataset.planSql = '';
  sqlPanel.append(el('summary', null, 'The queries behind these views'), sqlPre);
  root.append(sqlPanel);

  const footer = el('footer', 'colophon');
  footer.append(
    'Synthetic data: ', el('strong', null, 'no real customers or people'),
    '. DuckDB-Wasm reads the Parquet files over HTTP range requests; only the row groups holding the '
    + 'selected tenant’s rows are fetched. ',
  );
  const code = el('a', null, 'Source and data dictionary');
  code.href = 'https://github.com/toclocoinc/lattice-grid-demo-duckdb-saas-analytics';
  footer.append(code, '.');
  root.append(footer);

  /* ------------------------------------------------------------------ */
  /* The queries the page ran, recorded                                  */
  /* ------------------------------------------------------------------ */

  const sqlLog = [];
  const latest = new Map();
  const labelled = (label) => recordSql(connection, (entry) => {
    sqlLog.push({ ...entry, label });
    if (sqlLog.length > 200) sqlLog.splice(0, sqlLog.length - 200);
    const kind = entry.sql.includes('GROUP BY ROLLUP') ? 'chart' : /\bLIMIT\b/.test(entry.sql) ? 'rows' : entry.sql.includes('__lattice_total') ? 'count' : 'other';
    latest.set(`${label}:${kind === 'other' ? entry.sql : kind}`, { ...entry, label });
    renderSql();
  });

  function renderSql() {
    sqlPre.textContent = [...latest.values()].map((e) => {
      const sql = e.sql.replace(/\s+/g, ' ').replace(/ (FROM|WHERE|GROUP BY|ORDER BY|LIMIT|OFFSET) /g, '\n$1 ');
      const bound = e.params?.length ? `\n-- bound: ${JSON.stringify(e.params.map((p) => (typeof p === 'bigint' ? Number(p) : p)))}` : '';
      return `-- ${e.label} · ${e.ms} ms · ${fmt.int(e.rows)} rows back\n${sql}${bound}`;
    }).join('\n\n');
  }

  /* ------------------------------------------------------------------ */
  /* The tenant scope                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * The tenant scope for the grids and charts lives inside each grid's
   * relation (`WHERE tenant_id = <id>`), so it is not a filter the visitor can
   * clear, and DuckDB prunes row groups with it. Switching tenant builds each
   * grid over the new relation. `epoch` counts switches, so an answer that
   * arrives from the previous tenant is never taken for the new one.
   */
  let epoch = 0;

  /* ------------------------------------------------------------------ */
  /* Grids                                                               */
  /* ------------------------------------------------------------------ */

  const notify = (id) => built.timings[id].listeners?.forEach((fn) => fn());

  function renderStat(id) {
    const state = built.timings[id];
    const stat = views[id].stat;
    stat.textContent = state.matches == null ? '' : `${fmt.int(state.matches)} rows match · last page query ${state.ms} ms`;
  }

  function mountGrid(id, { from, fields, columns, rowKey, facets, sort }) {
    const adapter = LG.duckdbAdapter({ connection: labelled(id), from, fields });
    const source = LG.createPushdownSource({
      adapter,
      compute: LG,
      pageSize: 100,
      aggregates: { default: 'engine-if-identical' },
    });
    const state = (built.timings[id] ||= { matches: null, ms: null, filters: null, epoch: -1, chartsDone: 0, chartsBefore: 0, listeners: [] });
    state.matches = null;
    state.signature = null;
    /* The adapter's own execute is where a filter, sort, search or page lands:
       watching it is how the page learns what the grid just asked for. */
    const inner = adapter.execute.bind(adapter);
    adapter.execute = async (query, request) => {
      const started = performance.now();
      const startedEpoch = epoch;
      const result = await inner(query, request);
      state.ms = Math.round(performance.now() - started);
      if (typeof result.total === 'number') state.matches = result.total;
      state.epoch = startedEpoch;
      renderStat(id);
      /* The charts follow the grid's own filter and search, not the request in
         flight: a group being expanded asks a narrower question than the grid shows. */
      const grid = built.grids[id];
      const signature = JSON.stringify([startedEpoch, grid?.filters.get() ?? null, grid?.filters.quickState().text ?? '']);
      if (signature !== state.signature) {
        state.signature = signature;
        void refreshCharts(id);
      }
      notify(id);
      requestAnimationFrame(() => views[id].covered.hide());
      return result;
    };
    built.grids[id]?.destroy?.();
    views[id].host.textContent = '';
    const grid = LG.createGrid(views[id].host, {
      rowKey,
      columns,
      source,
      ...(facets ? { facets } : {}),
      toolPanel: { side: 'right', panels: ['filters', 'columns'] },
      showTotalInHeader: true,
    });
    built.grids[id] = grid;
    built.sources[id] = source;
    if (sort) grid.sort.set(sort);
  }

  /* ------------------------------------------------------------------ */
  /* Charts, fed by the grids' own sources                               */
  /* ------------------------------------------------------------------ */

  const request = (filters, groupBy, quick) => ({ filters, sort: [], range: null, groupBy, ...(quick ? { quick } : {}) });
  const realGroups = (groups) => (groups ?? []).filter((g) => !g.grouping?.some((flag) => flag));
  const dayOf = (key) => (key instanceof Date ? key : new Date(num(key))).toISOString().slice(0, 10);

  function feed(id, columns, rows, spec) {
    if (built.chartGrids[id]) {
      built.chartGrids[id].rows.load(rows);
      built.charts[id]?.refresh?.();
      chartSlots[id].hide();
      return;
    }
    const grid = LG.createHeadlessGrid({ rowKey: 'id', columns, rows });
    built.chartGrids[id] = grid;
    built.charts[id] = createChart({ grid, container: chartBoxes[id], legend: true, ...spec });
    chartSlots[id].hide();
  }

  const sequences = { usage: 0, invoices: 0 };

  async function refreshCharts(id) {
    const state = built.timings[id];
    const source = built.sources[id];
    if (!source || state.epoch !== epoch) return;
    const sequence = ++sequences[id];
    const filters = built.grids[id].filters.get() ?? null;
    const quick = built.grids[id].filters.quickState().text;
    state.filters = filters;
    try {
      if (id === 'usage') {
        const result = await source.aggregate(request(filters, ['feature', 'week'], quick), [{ id: 'events', col: 'events', fn: 'sum' }]);
        if (sequence !== sequences.usage) return;
        const groups = realGroups(result.groups);
        const totals = new Map();
        for (const g of groups) totals.set(g.keys[0], (totals.get(g.keys[0]) ?? 0) + num(g.values.events));
        const top = new Set([...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_FEATURES).map(([f]) => f));
        const cells = new Map();
        for (const g of groups) {
          const feature = top.has(g.keys[0]) ? String(g.keys[0]) : 'other';
          const week = dayOf(g.keys[1]);
          const key = `${feature}|${week}`;
          cells.set(key, { id: key, feature, week, events: (cells.get(key)?.events ?? 0) + num(g.values.events) });
        }
        const rows = [...cells.values()].sort((a, b) => a.week.localeCompare(b.week) || a.feature.localeCompare(b.feature));
        feed('adoption', [{ field: 'id' }, { field: 'feature' }, { field: 'week' }, { field: 'events', type: 'number' }], rows, {
          type: 'bar', x: 'week', y: 'events', series: 'feature', stack: true,
          title: 'Feature adoption over time',
          subtitle: `Events per week, top ${TOP_FEATURES} features; follows the usage grid’s filters`,
          axis: { x: { labels: true, every: 52 }, y: 'Events' },
        });
      } else {
        const result = await source.aggregate(request(filters, ['period_start'], quick), [{ id: 'amount', col: 'amount', fn: 'sum' }]);
        if (sequence !== sequences.invoices) return;
        const rows = realGroups(result.groups)
          .map((g) => ({ id: dayOf(g.keys[0]).slice(0, 7), month: dayOf(g.keys[0]).slice(0, 7), amount: num(g.values.amount) }))
          .filter((r) => r.amount != null)
          .sort((a, b) => a.month.localeCompare(b.month));
        feed('mrr', [{ field: 'id' }, { field: 'month' }, { field: 'amount', type: 'number' }], rows, {
          type: 'bar', x: 'month', y: 'amount',
          title: 'MRR by month',
          subtitle: 'Invoiced amount in USD; follows the invoices grid’s filters',
          axis: { x: { labels: true, every: 12 }, y: 'USD' },
        });
      }
      state.chartsDone += 1;
      notify(id);
    } catch (error) {
      console.error('[saas demo] chart', id, error);
    }
  }

  /* ------------------------------------------------------------------ */
  /* The KPI strip                                                       */
  /* ------------------------------------------------------------------ */

  built.kpi = createKPI(kpiHost, {
    rows: [],
    rowKey: 'id',
    columns: 4,
    ariaLabel: 'Key figures for this tenant',
    nullText: '—',
    tiles: [
      { id: 'active', label: 'Active users, last 30 days', aggregation: 'max', field: 'active', format: { type: 'number', decimals: 0 } },
      { id: 'events', label: 'Events, last 30 days', aggregation: 'max', field: 'events', format: { type: 'number', decimals: 0 } },
      { id: 'mrr', label: 'MRR, September 2026', aggregation: 'max', field: 'mrr', format: { type: 'currency', currency: 'USD', decimals: 0 } },
      {
        id: 'overdue', label: 'Overdue invoices', aggregation: 'max', field: 'overdue', format: { type: 'number', decimals: 0 },
        thresholds: { warn: 1, critical: 3, direction: 'lowerIsBetter' },
      },
    ],
  });

  const kpiConnection = labelled('kpi');

  async function loadKpis() {
    const one = async (key) => {
      return (await kpiConnection.query(KPI_SQL[key])).toArray()[0].toJSON();
    };
    const [active, events, mrr, overdue] = await Promise.all([one('active'), one('events'), one('mrr'), one('overdue')]);
    built.kpis = {
      active: num(active.v), events: num(events.v), mrr: num(mrr.v), overdue: num(overdue.v), overdueAmount: num(overdue.total),
    };
    built.kpi.setRows([{ id: 'now', ...built.kpis }]);
    kpiSlot.hide();
  }

  /* ------------------------------------------------------------------ */
  /* Switching                                                           */
  /* ------------------------------------------------------------------ */

  /** Resolves when both grids have answered for this tenant and their charts have followed. */
  const settledFor = (tenantId) => new Promise((resolve) => {
    const check = () => {
      if (VIEWS.every((id) => built.timings[id].epoch === epoch && built.timings[id].chartsDone > built.timings[id].chartsBefore)) resolve();
    };
    for (const id of VIEWS) built.timings[id].listeners = [check];
    check();
  });

  const describe = (tenantId) => `Every query below is scoped to tenant_id = ${tenantId}.`;

  async function switchTenant(tenantId) {
    const started = performance.now();
    built.tenantId = tenantId;
    const t = tenantRows.find((x) => x.tenant_id === tenantId);
    select.value = String(tenantId);
    scopeNote.textContent = describe(tenantId);
    switchTiming.textContent = 'Loading…';
    status.show();
    for (const id of VIEWS) {
      const s = built.timings[id];
      s.chartsBefore = s.chartsDone;
    }
    epoch += 1;
    await loadScope(tenantId);
    mountViews(tenantId);
    status.set(`Building ${t?.name ?? 'the tenant'}’s grids, charts and key figures`);
    const settled = settledFor(tenantId);
    await Promise.all([loadKpis(), settled]);
    status.hide();
    built.lastSwitchMs = Math.round(performance.now() - started);
    switchTiming.textContent = `${t?.name ?? 'Tenant'} loaded in ${built.lastSwitchMs} ms: working set, 4 KPIs, 2 grids, 2 charts.`;
    return built.lastSwitchMs;
  }

  select.addEventListener('change', () => { void switchTenant(Number(select.value)); });

  /* ------------------------------------------------------------------ */
  /* Start                                                               */
  /* ------------------------------------------------------------------ */

  const scopeConnection = labelled('scope');
  const bind = async (sql, tenantId) => {
    if (!Number.isInteger(tenantId)) throw new Error(`not a tenant id: ${tenantId}`);
    const statement = await scopeConnection.prepare(sql);
    try { await statement.query(tenantId); } finally { statement.close(); }
  };
  /** Show every panel's loading state: nothing is blank while the working set is read. */
  const coverPanels = (name) => {
    kpiSlot.show(`Reading ${name} usage, then the key figures`);
    for (const id of Object.keys(chartSlots)) chartSlots[id].show(`Reading ${name} usage, then this chart`);
    for (const id of VIEWS) views[id].covered.show(`Reading ${name} ${id}…`);
  };

  /**
   * How many bytes the events read will fetch for this tenant (null when the
   * file carries no statistics to say), so the status line can show a bar.
   */
  const expectedBytes = async (tenantId) => {
    try {
      const statement = await connection.prepare(eventsReadBytesSql(base));
      try {
        const row = (await statement.query(tenantId, tenantId)).toArray()[0]?.toJSON();
        return num(row?.bytes) || null;
      } finally { statement.close(); }
    } catch { return null; }
  };

  /** Build the tenant's working set: the one place the tenant id is bound. */
  const loadScope = async (tenantId) => {
    const name = tenantRows.find((x) => x.tenant_id === tenantId)?.name ?? 'the tenant’s';
    for (const id of VIEWS) { built.grids[id]?.destroy?.(); built.grids[id] = null; views[id].host.textContent = ''; }
    coverPanels(name);
    status.set(`Looking up where ${name} usage sits in the file`);
    const expected = await expectedBytes(tenantId);
    const before = reads.bytes;
    const line = (read) => {
      const total = Math.max(expected ?? 0, read);
      return expected
        ? [`Reading ${name} usage (${megabytes(read)} of ${megabytes(total)})`, read / total]
        : [`Reading ${name} usage (${megabytes(read)} so far)`, null];
    };
    status.set(...line(0));
    const stop = reads.onRead((total) => status.set(...line(total - before)));
    try {
      await Promise.all([bind(eventsScopeSql(base), tenantId), bind(invoicesScopeSql(base), tenantId)]);
    } finally { stop(); }
    status.set(`Summing ${name} usage by feature and week`);
    await scopeConnection.query(usageScopeSql());
  };

  const mountViews = (tenantId) => {
    mountGrid('usage', {
      from: USAGE_TABLE, fields: USAGE_FIELDS, columns: USAGE_COLUMNS, rowKey: 'row_id',
      facets: { enabled: true }, sort: [{ col: 'week', dir: 'desc' }],
    });
    mountGrid('invoices', {
      from: INVOICES_TABLE, fields: INVOICE_FIELDS, columns: INVOICE_COLUMNS, rowKey: 'invoice_id',
    });
  };

  built.tenantId = startTenant;
  select.value = String(startTenant);
  scopeNote.textContent = describe(startTenant);
  await loadScope(startTenant);
  mountViews(startTenant);
  status.set(`Building ${tenantRows.find((x) => x.tenant_id === startTenant).name}’s grids, charts and key figures`);
  const opening = settledFor(startTenant);
  built.switchTenant = (id) => switchTenant(Number(id));
  built.group = (ids) => built.grids.usage.columns.group(ids);
  built.destroy = () => { for (const g of Object.values(built.grids)) g.destroy?.(); };

  const t0 = tenantRows.find((x) => x.tenant_id === startTenant);
  await Promise.all([loadKpis(), opening]);
  status.hide();
  switchTiming.textContent = `${t0.name} loaded.`;
  return built;
}
