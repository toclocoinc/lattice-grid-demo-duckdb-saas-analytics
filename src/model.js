/**
 * What the data is, and how the grids read it.
 *
 * Three Parquet files, one tenant column. Every view is a relation over them
 * that DuckDB computes on demand: the usage grid is events grouped by feature
 * and week, the invoices grid is the invoices as billed. The tenant scope is
 * the `WHERE tenant_id = ${scope(tenantId)}` that every grid relation
 * carries, and the `tenant_id = ?` every KPI statement binds.
 */
import { AS_OF } from './config.js';

/** DuckDB returns BIGINT counts as BigInt; everything downstream wants a number. */
export const num = (value) => (typeof value === 'bigint' ? Number(value) : (value == null ? null : Number(value)));

const quote = (url) => `'${String(url).replace(/'/g, "''")}'`;

/**
 * The tenant's working set. One statement per table, with the tenant bound as
 * `?`: DuckDB reads only the Parquet row groups that hold that tenant's rows
 * and keeps the (small) result as a temporary table. Every grid, histogram and
 * chart then queries that table, so the tenant scope is not something a filter
 * can remove, and a filter change costs milliseconds, not another Parquet read.
 */
export const EVENTS_TABLE = 'tenant_events';
export const USAGE_TABLE = 'tenant_usage';
export const INVOICES_TABLE = 'tenant_invoices';

/** The one read of the big file: this tenant's events, tenant bound as `?`. */
export const eventsScopeSql = (base) => `CREATE OR REPLACE TEMP TABLE ${EVENTS_TABLE} AS
  SELECT tenant_id, user_id, feature, event_time, duration_ms, status
  FROM read_parquet(${quote(`${base}usage_events.parquet`)})
  WHERE tenant_id = ?`;

/**
 * How many bytes of the events file the working-set read will fetch for one
 * tenant: the compressed size of the six columns it reads, in the row groups
 * whose tenant_id range holds the tenant. Read from the file's footer, which
 * the engine has to fetch anyway; it is what the "n of m MB" line counts to.
 */
export const eventsReadBytesSql = (base) => {
  const file = quote(`${base}usage_events.parquet`);
  return `SELECT CAST(sum(total_compressed_size) AS BIGINT) AS bytes FROM parquet_metadata(${file})
  WHERE path_in_schema IN ('tenant_id', 'user_id', 'feature', 'event_time', 'duration_ms', 'status')
    AND row_group_id IN (SELECT row_group_id FROM parquet_metadata(${file})
      WHERE path_in_schema = 'tenant_id' AND CAST(stats_min_value AS BIGINT) <= ? AND CAST(stats_max_value AS BIGINT) >= ?)`;
};

/** Events per feature per week, from the tenant's own events. */
export const usageScopeSql = () => `CREATE OR REPLACE TEMP TABLE ${USAGE_TABLE} AS
  SELECT tenant_id, feature,
         CAST(date_trunc('week', event_time) AS DATE) AS week,
         CAST(count(*) AS INTEGER) AS events,
         CAST(count(DISTINCT user_id) AS INTEGER) AS active_users,
         CAST(round(avg(duration_ms)) AS INTEGER) AS avg_ms,
         CAST(sum(CASE WHEN status <> 'ok' THEN 1 ELSE 0 END) AS INTEGER) AS failures,
         feature || ' ' || CAST(CAST(date_trunc('week', event_time) AS DATE) AS VARCHAR) AS row_id
  FROM ${EVENTS_TABLE}
  GROUP BY tenant_id, feature, CAST(date_trunc('week', event_time) AS DATE)`;

/** The invoices as billed, with how long the open ones have been overdue as of the data's last day. */
export const invoicesScopeSql = (base) => `CREATE OR REPLACE TEMP TABLE ${INVOICES_TABLE} AS
  SELECT invoice_id, 'INV-' || lpad(CAST(invoice_id AS VARCHAR), 6, '0') AS invoice, tenant_id, period_start, due_date, seats,
         CAST(amount AS DOUBLE) AS amount, status, paid_date,
         CASE WHEN status = 'overdue' THEN CAST(DATE '${AS_OF}' - due_date AS INTEGER) END AS days_overdue
  FROM read_parquet(${quote(`${base}invoices.parquet`)})
  WHERE tenant_id = ?`;

export const USAGE_FIELDS = ['row_id', 'tenant_id', 'feature', 'week', 'events', 'active_users', 'avg_ms', 'failures'];
export const INVOICE_FIELDS = ['invoice_id', 'invoice', 'tenant_id', 'period_start', 'due_date', 'seats', 'amount', 'status', 'paid_date', 'days_overdue'];

const integer = { decimals: 0 };

export const USAGE_COLUMNS = [
  { field: 'tenant_id', title: 'Tenant', type: 'number', layout: { width: 90, hidden: true }, allowGroup: false },
  { field: 'week', title: 'Week of', type: 'date', filter: { type: 'date' }, layout: { width: 126, min: 126, flex: 1 }, facet: true },
  { field: 'feature', title: 'Feature', filter: { type: 'set' }, layout: { width: 160, min: 160, flex: 1 }, facet: true },
  { field: 'events', title: 'Events', type: 'number', format: integer, filter: { type: 'number' }, layout: { width: 120, min: 120, flex: 1 }, facet: true },
  { field: 'active_users', title: 'Active users', type: 'number', format: integer, filter: { type: 'number' }, layout: { width: 130, min: 130, flex: 1 }, facet: true },
  { field: 'avg_ms', title: 'Avg ms', type: 'number', format: integer, filter: { type: 'number' }, layout: { width: 110, min: 110, flex: 1 }, facet: true },
  {
    field: 'failures', title: 'Failures', type: 'number', format: integer, filter: { type: 'number' }, layout: { width: 110, min: 110, flex: 1 }, facet: true,
  },
];

export const INVOICE_COLUMNS = [
  { field: 'invoice_id', title: 'Id', type: 'number', layout: { width: 80, hidden: true } },
  { field: 'invoice', title: 'Invoice', filter: { type: 'text' }, layout: { width: 120, min: 120, flex: 1 } },
  { field: 'tenant_id', title: 'Tenant', type: 'number', layout: { width: 90, hidden: true } },
  { field: 'period_start', title: 'Period', type: 'date', filter: { type: 'date' }, layout: { width: 120, min: 120, flex: 1 } },
  { field: 'due_date', title: 'Due', type: 'date', filter: { type: 'date' }, layout: { width: 120, min: 120, flex: 1 } },
  { field: 'seats', title: 'Seats', type: 'number', format: integer, filter: { type: 'number' }, layout: { width: 96, min: 96, flex: 1 } },
  {
    field: 'amount', title: 'Amount (USD)', type: 'number', format: { decimals: 2 }, filter: { type: 'number' }, layout: { width: 150, min: 150, flex: 1 },
  },
  {
    field: 'status', title: 'Status', filter: { type: 'set' }, layout: { width: 116, min: 116, flex: 1 },
    cell: { decoration: 'pill', variant: { when: [{ op: 'eq', value: 'overdue', use: 'danger' }, { op: 'eq', value: 'paid', use: 'success' }], default: 'none' } },
  },
  { field: 'paid_date', title: 'Paid', type: 'date', layout: { width: 120, min: 120, flex: 1 } },
  { field: 'days_overdue', title: 'Days overdue', type: 'number', format: integer, filter: { type: 'number' }, layout: { width: 134, min: 134, flex: 1 } },
];

/** The quantity "events" in the usage grid is a count of rows; the chart sums it. */
export const fmt = {
  int: (n) => (n == null || Number.isNaN(Number(n)) ? '—' : Math.round(Number(n)).toLocaleString('en-US')),
  usd: (n) => (n == null || Number.isNaN(Number(n)) ? '—' : `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`),
  ms: (n) => (n == null ? '—' : `${Math.round(n)} ms`),
};

/** The KPI strip's queries, over the tenant's working set. */
export const KPI_SQL = {
  active: `SELECT CAST(count(DISTINCT user_id) AS INTEGER) AS v FROM ${EVENTS_TABLE}
           WHERE event_time >= TIMESTAMP '${AS_OF}' + INTERVAL 1 DAY - INTERVAL 30 DAY`,
  events: `SELECT CAST(count(*) AS INTEGER) AS v FROM ${EVENTS_TABLE}
           WHERE event_time >= TIMESTAMP '${AS_OF}' + INTERVAL 1 DAY - INTERVAL 30 DAY`,
  mrr: `SELECT CAST(coalesce(sum(amount), 0) AS DOUBLE) AS v FROM ${INVOICES_TABLE}
        WHERE period_start = date_trunc('month', DATE '${AS_OF}')`,
  overdue: `SELECT CAST(count(*) AS INTEGER) AS v, CAST(coalesce(sum(amount), 0) AS DOUBLE) AS total FROM ${INVOICES_TABLE}
            WHERE status = 'overdue'`,
};

/** The tenant list for the switcher. Small: one row per tenant. */
export const TENANTS_SQL = (base) => `SELECT tenant_id, name, plan, region, signup_date, churn_date FROM read_parquet(${quote(`${base}tenants.parquet`)}) ORDER BY name, tenant_id`;
