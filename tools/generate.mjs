#!/usr/bin/env node
// Deterministic multi-tenant SaaS usage generator for the embedded-analytics demo.
// Everything is synthetic: seeded hash-based PRNG inside DuckDB, no real people, no PII-looking values.
//
//   node tools/generate.mjs [--scale tiny|small|full] [--seed 42] [--out dir]
//
// The same seed + scale gives byte-identical Parquet files.
import { DuckDBInstance } from '@duckdb/node-api';
import { mkdirSync, statSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCALES = {
  tiny: { tenants: 24, events: 30_000 },
  small: { tenants: 120, events: 1_000_000 },
  full: { tenants: 500, events: 20_000_000 },
};

export const DATA_START = '2023-01-01';
export const DATA_END = '2026-09-30';
export const FEATURES = [
  ['dashboards', 400], ['reports', 900], ['search', 250], ['exports', 2500], ['api_calls', 120],
  ['alerts', 300], ['integrations', 1500], ['workflows', 1100], ['sharing', 350], ['comments', 200],
  ['audit_log', 600], ['sso_login', 700], ['data_import', 4000], ['custom_fields', 280], ['ai_assistant', 3200],
];
const ADJ = ['Northwind', 'Bluefin', 'Quartz', 'Harbor', 'Juniper', 'Copper', 'Meridian', 'Falcon', 'Lumen', 'Cobalt',
  'Willow', 'Summit', 'Ember', 'Tidal', 'Orchid', 'Granite', 'Nimbus', 'Saffron', 'Vertex', 'Alder'];
const NOUN = ['Labs', 'Systems', 'Works', 'Analytics', 'Cloud', 'Logistics', 'Health', 'Robotics', 'Media', 'Capital',
  'Foods', 'Energy', 'Studio', 'Networks', 'Software', 'Freight', 'Learning', 'Retail', 'Mobility', 'Dynamics'];
const SUFFIX = ['Inc', 'Co', 'Group', 'Ltd', 'Partners', 'Holdings', 'Collective', 'Ventures', 'Global', 'Works'];

const q = (s) => `'${s}'`;

/** SQL that builds every table in the connected in-memory database. */
function buildSql({ tenants, events, seed }) {
  const S = Number(seed) | 0;
  // rnd(...) -> uniform double in [0,1), pure function of seed and its arguments
  const rnd = `CREATE MACRO rnd(a, b, c) AS (hash(${S}, a, b, c) >> 11) / 9007199254740992.0;`;
  const featList = `[${FEATURES.map((f) => q(f[0])).join(',')}]`;
  const featBase = `[${FEATURES.map((f) => f[1]).join(',')}]`;
  const nameList = (a) => `[${a.map(q).join(',')}]`;
  return [
    rnd,
    `CREATE TABLE plans AS SELECT * FROM (VALUES
      ('free',       0, 0.0, 0.0,   3,  12, 6,  0.30),
      ('team',       1, 49.0, 12.0, 8,  40, 10, 1.00),
      ('business',   2, 199.0, 24.0, 40, 160, 13, 1.20),
      ('enterprise', 3, 999.0, 40.0, 250, 650, 15, 1.50)
    ) t(plan, plan_rank, base_fee, seat_price, min_users, max_users, n_features, activity)`,
    `CREATE TABLE regions AS SELECT * FROM (VALUES
      ('us-east', -5), ('us-west', -8), ('eu-west', 0), ('eu-central', 1), ('ap-southeast', 8), ('ap-northeast', 9)
    ) t(region, utc_offset)`,
    // tenants
    `CREATE TABLE tenants AS
     WITH base AS (
       SELECT i AS tenant_id,
         rnd(1, i, 0) AS r_plan, rnd(2, i, 0) AS r_region, rnd(3, i, 0) AS r_signup,
         rnd(4, i, 0) AS r_churn, rnd(5, i, 0) AS r_churn_d, rnd(6, i, 0) AS r_users
       FROM range(1, ${tenants + 1}) t(i)
     ), p AS (
       SELECT *, CASE WHEN r_plan < 0.40 THEN 'free' WHEN r_plan < 0.70 THEN 'team' WHEN r_plan < 0.90 THEN 'business' ELSE 'enterprise' END AS plan,
         DATE '${DATA_START}' + CAST(floor(pow(r_signup, 0.75) * (date_diff('day', DATE '${DATA_START}', DATE '${DATA_END}') - 45)) AS INTEGER) AS signup_date
       FROM base
     )
     SELECT tenant_id,
       ${nameList(ADJ)}[1 + (idx7 % 20)] || ' ' || ${nameList(NOUN)}[1 + ((idx7 // 20) % 20)] || ' ' || ${nameList(SUFFIX)}[1 + ((idx7 // 400) % 10)] AS name,
       plan,
       ['ap-northeast','ap-southeast','eu-central','eu-west','us-east','us-west'][1 + CAST(floor(r_region * 6) AS INTEGER)] AS region,
       signup_date,
       CASE WHEN r_churn < (CASE WHEN plan = 'free' THEN 0.50 WHEN plan = 'team' THEN 0.35 WHEN plan = 'business' THEN 0.20 ELSE 0.08 END)
            AND signup_date + 120 < DATE '${DATA_END}'
         THEN signup_date + 90 + CAST(floor(r_churn_d * LEAST(date_diff('day', signup_date, DATE '${DATA_END}') - 100, 700)) AS INTEGER)
       END AS churn_date,
       min_users + CAST(floor(r_users * (max_users - min_users + 1)) AS INTEGER) AS n_users
     FROM (SELECT p.*, (tenant_id * 7919) % 4000 AS idx7 FROM p) p JOIN plans USING (plan)`,
    // users: ids contiguous per tenant
    `CREATE TABLE users AS
     SELECT row_number() OVER (ORDER BY t.tenant_id, u.k) AS user_id, t.tenant_id, u.k AS user_idx,
       CASE WHEN u.k = 0 THEN 'owner'
            WHEN rnd(10, t.tenant_id, u.k) < 0.12 THEN 'admin'
            WHEN rnd(10, t.tenant_id, u.k) < 0.72 THEN 'member' ELSE 'viewer' END AS role,
       CASE WHEN u.k = 0 THEN CAST(t.signup_date AS TIMESTAMP) + to_seconds(CAST(rnd(11, t.tenant_id, 0) * 3600 AS INTEGER))
         ELSE CAST(t.signup_date AS TIMESTAMP) + to_seconds(CAST(floor(pow(rnd(11, t.tenant_id, u.k), 1.5) * 0.7 *
              (date_diff('day', t.signup_date, COALESCE(t.churn_date, DATE '${DATA_END}')) ) * 86400) AS BIGINT)) END AS created_at
     FROM tenants t, LATERAL (SELECT unnest(range(t.n_users)) AS k) u
     ORDER BY t.tenant_id, u.k`,
    // hourly weights (local time), cumulative per region in UTC hours
    `CREATE TABLE hour_cdf AS
     WITH h AS (
       SELECT r.region, hr AS utc_hour,
         (0.04 + 1.0 * exp(-pow(((hr + r.utc_offset + 24) % 24) - 10.5, 2) / 8.0)
               + 0.8 * exp(-pow(((hr + r.utc_offset + 24) % 24) - 15.0, 2) / 8.0)) AS w
       FROM regions r, range(24) t(hr)
     )
     SELECT region, utc_hour, w, COALESCE(sum(w) OVER (PARTITION BY region ORDER BY utc_hour ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) / sum(w) OVER (PARTITION BY region) AS cum_frac,
       sum(w) OVER (PARTITION BY region) AS total
     FROM h`,
    // per-tenant per-day activity weights: weekly seasonality, ramp-up after signup, decay before churn
    `CREATE TABLE tenant_days AS
     WITH d AS (
       SELECT t.tenant_id, t.plan, CAST(g AS DATE) AS day, t.signup_date, t.churn_date, a.activity
       FROM tenants t JOIN plans a USING (plan),
         LATERAL (SELECT unnest(generate_series(t.signup_date, COALESCE(t.churn_date, DATE '${DATA_END}') - IF(t.churn_date IS NULL, 0, 1), INTERVAL 1 DAY)) AS g)
     ), w AS (
       SELECT tenant_id, day,
         (0.15 + 0.85 * (1 - exp(-date_diff('day', signup_date, day) / 45.0))) * (1 + date_diff('day', signup_date, day) / 1200.0)
         * (CASE WHEN churn_date IS NULL THEN 1.0 ELSE 0.08 + 0.92 * LEAST(1.0, date_diff('day', day, churn_date) / 60.0) END)
         * (CASE isodow(day) WHEN 6 THEN (CASE WHEN plan = 'free' THEN 0.45 ELSE 0.18 END) WHEN 7 THEN (CASE WHEN plan = 'free' THEN 0.40 ELSE 0.12 END) ELSE 1.0 END)
         * (CASE WHEN (month(day) = 12 AND dayofmonth(day) >= 23) OR (month(day) = 1 AND dayofmonth(day) <= 2) THEN 0.5 ELSE 1.0 END)
         * (0.8 + 0.4 * rnd(20, tenant_id, CAST(day - DATE '2000-01-01' AS INTEGER))) * activity AS w
       FROM d
     )
     SELECT tenant_id, day, w, COALESCE(sum(w) OVER (PARTITION BY tenant_id ORDER BY day ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS cum_start,
       sum(w) OVER (PARTITION BY tenant_id) AS total
     FROM w`,
    // event budget per tenant
    `CREATE TABLE tenant_budget AS
     SELECT t.tenant_id, t.n_users, t.plan, t.region, p.n_features, max(d.total) AS total,
       CAST(round(${events} * (t.n_users * max(d.total)) / sum(t.n_users * max(d.total)) OVER ()) AS BIGINT) AS n_events
     FROM tenants t JOIN plans p USING (plan) JOIN tenant_days d USING (tenant_id)
     GROUP BY t.tenant_id, t.n_users, t.plan, t.region, p.n_features`,
    `CREATE TABLE ev_raw AS
     WITH e AS (
       SELECT b.tenant_id, unnest(range(b.n_events)) AS seq FROM tenant_budget b
     ), e1 AS (
       SELECT e.tenant_id, e.seq, b.n_users, b.n_features, b.region,
         rnd(30, e.tenant_id, e.seq) * b.total AS target,
         CAST(floor(pow(rnd(31, e.tenant_id, e.seq), 1.6) * b.n_users) AS INTEGER) AS user_idx,
         CAST(floor(pow(rnd(32, e.tenant_id, e.seq), 1.8) * b.n_features) AS INTEGER) AS feat_idx,
         rnd(33, e.tenant_id, e.seq) AS r_hour, rnd(34, e.tenant_id, e.seq) AS r_ms,
         rnd(35, e.tenant_id, e.seq) AS r_status, rnd(36, e.tenant_id, e.seq) AS r_z1, rnd(37, e.tenant_id, e.seq) AS r_z2
       FROM e JOIN tenant_budget b USING (tenant_id)
     )
     SELECT e1.*, d.day FROM e1 ASOF JOIN tenant_days d ON e1.tenant_id = d.tenant_id AND e1.target >= d.cum_start`,
    `CREATE TABLE ev_timed AS
     SELECT r.tenant_id, r.seq, r.feat_idx, r.r_ms, r.r_status, r.r_z1, r.r_z2, r.day, r.r_hour, r.region, u.user_id, u.created_at
     FROM ev_raw r JOIN users u ON u.tenant_id = r.tenant_id AND u.user_idx = r.user_idx`,
    `DROP TABLE ev_raw`,
    `CREATE TABLE ev_final AS
     WITH h AS (
       SELECT r.*, hc.utc_hour
       FROM ev_timed r ASOF JOIN hour_cdf hc ON hc.region = r.region AND r.r_hour >= hc.cum_frac
     ), t AS (
       SELECT *, GREATEST(CAST(day AS TIMESTAMP) + to_hours(utc_hour) + to_milliseconds(CAST(floor(r_ms * 3600000) AS BIGINT)),
                          created_at + to_milliseconds(CAST(floor(r_ms * 600000) AS BIGINT))) AS event_time,
         CASE WHEN r_status < 0.945 THEN 'ok' WHEN r_status < 0.975 THEN 'error' WHEN r_status < 0.99 THEN 'timeout' ELSE 'rate_limited' END AS status,
         ${featList}[feat_idx + 1] AS feature,
         ${featBase}[feat_idx + 1] AS base_ms,
         sqrt(-2 * ln(1 - r_z1)) * cos(2 * pi() * r_z2) AS z
       FROM h
     )
     SELECT tenant_id, user_id, feature, event_time,
       CAST(CASE status WHEN 'timeout' THEN 30000 WHEN 'rate_limited' THEN 3 + floor(r_ms * 10)
         WHEN 'error' THEN least(30000, round(base_ms * 1.6 * exp(0.55 * z))) ELSE least(30000, round(base_ms * exp(0.55 * z))) END AS INTEGER) AS duration_ms,
       status, seq
     FROM t`,
    `DROP TABLE ev_timed`,
    `CREATE TABLE usage_events AS
     SELECT row_number() OVER (ORDER BY tenant_id, event_time, user_id, seq) AS event_id, tenant_id, user_id, feature, event_time, duration_ms, status
     FROM ev_final ORDER BY tenant_id, event_time, user_id, seq`,
    `DROP TABLE ev_final`,
    // invoices: one per paying tenant per month, billed in advance, seats = users created by month end
    `CREATE TABLE inv_base AS
     SELECT t.tenant_id, t.plan, t.churn_date, CAST(m AS DATE) AS period_start,
       CAST(CAST(m AS DATE) + INTERVAL 1 MONTH - INTERVAL 1 DAY AS DATE) AS period_end,
       (SELECT count(*) FROM users u WHERE u.tenant_id = t.tenant_id AND u.created_at < CAST(m AS DATE) + INTERVAL 1 MONTH) AS users_billed
     FROM tenants t,
       LATERAL (SELECT unnest(generate_series(date_trunc('month', t.signup_date), date_trunc('month', COALESCE(t.churn_date, DATE '${DATA_END}')), INTERVAL 1 MONTH)) AS m)
     WHERE t.plan <> 'free'`,
    `CREATE TABLE inv_ids AS
     SELECT row_number() OVER (ORDER BY tenant_id, period_start) AS invoice_id, b.*, GREATEST(b.users_billed, 1) AS seats,
       rnd(40, tenant_id, CAST(period_start - DATE '2000-01-01' AS INTEGER)) AS r_pay,
       rnd(41, tenant_id, CAST(period_start - DATE '2000-01-01' AS INTEGER)) AS r_days,
       rnd(42, tenant_id, CAST(period_start - DATE '2000-01-01' AS INTEGER)) AS r_a,
       rnd(43, tenant_id, CAST(period_start - DATE '2000-01-01' AS INTEGER)) AS r_b
     FROM inv_base b`,
    `CREATE TABLE invoice_lines AS
     WITH l AS (
       SELECT i.invoice_id, i.tenant_id, v.line_type, v.description, v.quantity, v.unit_price, v.ord
       FROM inv_ids i JOIN plans p USING (plan),
       LATERAL (VALUES
         (1, 'platform_fee', 'Platform fee', 1.0, p.base_fee),
         (2, 'seats', 'Seats', CAST(i.seats AS DOUBLE), p.seat_price),
         (3, 'storage_addon', 'Extra storage (100 GB blocks)', CAST(1 + floor(i.r_a * 8) AS DOUBLE), 20.0),
         (4, 'api_overage', 'API calls over plan (per 1k)', CAST(1 + floor(i.r_b * 400) AS DOUBLE), 0.45),
         (5, 'premium_support', 'Premium support', 1.0, 500.0)
       ) v(ord, line_type, description, quantity, unit_price)
       WHERE v.ord <= 2
          OR (v.ord = 3 AND i.plan IN ('business','enterprise') AND i.r_a < 0.5)
          OR (v.ord = 4 AND i.r_b < 0.35)
          OR (v.ord = 5 AND i.plan = 'enterprise')
     )
     SELECT row_number() OVER (ORDER BY invoice_id, ord) AS line_id, invoice_id, line_type, description,
       quantity, CAST(unit_price AS DECIMAL(10,2)) AS unit_price,
       CAST(round(quantity * unit_price, 2) AS DECIMAL(12,2)) AS amount
     FROM l ORDER BY invoice_id, ord`,
    `CREATE TABLE invoices AS
     WITH s AS (
       SELECT i.*, (SELECT sum(amount) FROM invoice_lines l WHERE l.invoice_id = i.invoice_id) AS amount,
         -- last two invoices of a churned tenant are more likely to go unpaid
         CASE WHEN churn_date IS NOT NULL AND churn_date - period_start < 70 THEN 0.30 ELSE 0.03 END AS p_overdue
       FROM inv_ids i
     )
     SELECT invoice_id, tenant_id, period_start, period_end,
       period_start AS issue_date, period_start + 30 AS due_date,
       seats, CAST(amount AS DECIMAL(12,2)) AS amount, 'USD' AS currency,
       CASE WHEN r_pay < p_overdue THEN 'overdue' ELSE 'paid' END AS status,
       CASE WHEN r_pay < p_overdue THEN NULL ELSE period_start + CAST(floor(r_days * 31) AS INTEGER) END AS paid_date
     FROM s ORDER BY invoice_id`,
    `ALTER TABLE users DROP COLUMN user_idx`,
    `CREATE TABLE tenants_out AS SELECT tenant_id, name, plan, region, signup_date, churn_date FROM tenants ORDER BY tenant_id`,
  ];
}

const TABLES = [
  ['tenants_out', 'tenants', 'tenant_id', 100_000],
  ['users', 'users', 'user_id', 100_000],
  ['usage_events', 'usage_events', 'event_id', 100_000],
  ['invoices', 'invoices', 'invoice_id', 100_000],
  ['invoice_lines', 'invoice_lines', 'line_id', 100_000],
];

/**
 * Generate the dataset as Parquet files.
 * @param {{seed?: number, scale?: string, out?: string, log?: (m: string) => void}} opts
 * @returns {Promise<{dir: string, files: Record<string, {rows: number, bytes: number}>}>}
 */
export async function generate({ seed = 42, scale = 'full', out, log = () => {} } = {}) {
  const preset = SCALES[scale];
  if (!preset) throw new Error(`unknown scale "${scale}" (use ${Object.keys(SCALES).join(', ')})`);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'data');
  const dir = resolve(out ?? (scale === 'full' ? root : resolve(root, scale)));
  mkdirSync(dir, { recursive: true });
  const instance = await DuckDBInstance.create(':memory:');
  const con = await instance.connect();
  await con.run('SET preserve_insertion_order = true');
  const t0 = Date.now();
  const steps = buildSql({ ...preset, seed });
  for (const sql of steps) {
    await con.run(sql);
    const m = /CREATE TABLE (\w+)/.exec(sql);
    if (m) log(`${m[1]} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
  const files = {};
  for (const [table, name, order, rg] of TABLES) {
    const path = resolve(dir, `${name}.parquet`);
    rmSync(path, { force: true });
    await con.run(`COPY (SELECT * FROM ${table} ORDER BY ${order}) TO '${path.replace(/'/g, "''")}' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE ${rg}, WRITE_BLOOM_FILTER false)`);
    const rows = Number((await (await con.runAndReadAll(`SELECT count(*) FROM ${table}`)).getRows())[0][0]);
    files[name] = { rows, bytes: statSync(path).size };
    log(`wrote ${name}.parquet: ${rows} rows, ${files[name].bytes} bytes`);
  }
  con.closeSync();
  return { dir, files };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
  if (args.includes('--help')) {
    console.log('usage: node tools/generate.mjs [--scale tiny|small|full] [--seed 42] [--out dir]');
  } else {
    const r = await generate({ seed: Number(opt('seed', 42)), scale: opt('scale', 'full'), out: opt('out'), log: (m) => console.log(m) });
    console.log(`done: ${r.dir}`);
  }
}
