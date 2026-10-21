/**
 * What the data is, and how the grids read it.
 *
 * Three Parquet files, one tenant column. Every view is a relation over them
 * that DuckDB computes on demand: the usage grid is events grouped by feature
 * and week, the invoices grid is the invoices as billed. The tenant scope is
 * not part of any relation here: it is a pinned, bound `WHERE tenant_id = ?`
 * the page adds on top of every one of them (see `scopeTenant`).
 */
import { AS_OF } from './config.js';

/** DuckDB returns BIGINT counts as BigInt; everything downstream wants a number. */
export const num = (value) => (typeof value === 'bigint' ? Number(value) : (value == null ? null : Number(value)));

const quote = (url) => `'${String(url).replace(/'/g, "''")}'`;

/** Events per feature per week, for every tenant. The tenant predicate is applied on top, and pushed below the GROUP BY. */
export const usageFrom = (base) => `(
  SELECT tenant_id, feature,
         CAST(date_trunc('week', event_time) AS DATE) AS week,
         CAST(count(*) AS INTEGER) AS events,
         CAST(count(DISTINCT user_id) AS INTEGER) AS active_users,
         CAST(round(avg(duration_ms)) AS INTEGER) AS avg_ms,
         CAST(sum(CASE WHEN status <> 'ok' THEN 1 ELSE 0 END) AS INTEGER) AS failures,
         feature || ' ' || CAST(CAST(date_trunc('week', event_time) AS DATE) AS VARCHAR) AS row_id
  FROM read_parquet(${quote(`${base}usage_events.parquet`)})
  GROUP BY tenant_id, feature, CAST(date_trunc('week', event_time) AS DATE)
)`;

/** The invoices as billed, with how long the open ones have been overdue as of the data's last day. */
export const invoicesFrom = (base) => `(
  SELECT invoice_id, 'INV-' || lpad(CAST(invoice_id AS VARCHAR), 6, '0') AS invoice, tenant_id, period_start, due_date, seats,
         CAST(amount AS DOUBLE) AS amount, status, paid_date,
         CASE WHEN status = 'overdue' THEN CAST(DATE '${AS_OF}' - due_date AS INTEGER) END AS days_overdue
  FROM read_parquet(${quote(`${base}invoices.parquet`)})
)`;

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

/** The KPI strip's queries. Every one binds the tenant with `?`. */
export const KPI_SQL = (base) => ({
  active: `SELECT CAST(count(DISTINCT user_id) AS INTEGER) AS v
           FROM read_parquet(${quote(`${base}usage_events.parquet`)})
           WHERE tenant_id = ? AND event_time >= TIMESTAMP '${AS_OF}' + INTERVAL 1 DAY - INTERVAL 30 DAY`,
  events: `SELECT CAST(count(*) AS INTEGER) AS v
           FROM read_parquet(${quote(`${base}usage_events.parquet`)})
           WHERE tenant_id = ? AND event_time >= TIMESTAMP '${AS_OF}' + INTERVAL 1 DAY - INTERVAL 30 DAY`,
  mrr: `SELECT CAST(coalesce(sum(amount), 0) AS DOUBLE) AS v
        FROM read_parquet(${quote(`${base}invoices.parquet`)})
        WHERE tenant_id = ? AND period_start = date_trunc('month', DATE '${AS_OF}')`,
  overdue: `SELECT CAST(count(*) AS INTEGER) AS v, CAST(coalesce(sum(amount), 0) AS DOUBLE) AS total
            FROM read_parquet(${quote(`${base}invoices.parquet`)})
            WHERE tenant_id = ? AND status = 'overdue'`,
});

/** The tenant list for the switcher. Small: one row per tenant. */
export const TENANTS_SQL = (base) => `SELECT tenant_id, name, plan, region, signup_date, churn_date FROM read_parquet(${quote(`${base}tenants.parquet`)}) ORDER BY name, tenant_id`;
