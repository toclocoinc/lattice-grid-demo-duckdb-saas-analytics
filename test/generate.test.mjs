import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DuckDBInstance } from '@duckdb/node-api';
import { generate } from '../tools/generate.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'gen-test-'));
const dirA = join(tmp, 'a');
const dirB = join(tmp, 'b');
const dirC = join(tmp, 'c');
let con;

const sha = (dir) => Object.fromEntries(readdirSync(dir).sort().map((f) => [f, createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')]));
const one = async (sql) => Number((await (await con.runAndReadAll(sql)).getRows())[0][0]);

before(async () => {
  await generate({ seed: 7, scale: 'tiny', out: dirA });
  await generate({ seed: 7, scale: 'tiny', out: dirB });
  await generate({ seed: 8, scale: 'tiny', out: dirC });
  con = await (await DuckDBInstance.create(':memory:')).connect();
  for (const t of ['tenants', 'users', 'usage_events', 'invoices', 'invoice_lines']) {
    await con.run(`CREATE VIEW ${t} AS SELECT * FROM '${join(dirA, t + '.parquet')}'`);
  }
});
after(() => { con?.closeSync(); rmSync(tmp, { recursive: true, force: true }); });

test('same seed gives byte-identical files, different seed differs', () => {
  assert.deepEqual(sha(dirA), sha(dirB));
  assert.notDeepEqual(sha(dirA)['usage_events.parquet'], sha(dirC)['usage_events.parquet']);
});

test('row counts are in the expected range', async () => {
  assert.equal(await one('SELECT count(*) FROM tenants'), 24);
  const ev = await one('SELECT count(*) FROM usage_events');
  assert.ok(Math.abs(ev - 30000) < 100, `events ${ev}`);
  assert.ok(await one('SELECT count(*) FROM users') > 24);
});

test('every event has an existing user of the same tenant, created before the event', async () => {
  assert.equal(await one(`SELECT count(*) FROM usage_events e LEFT JOIN users u USING (user_id)
    WHERE u.user_id IS NULL OR u.tenant_id <> e.tenant_id OR e.event_time < u.created_at`), 0);
  assert.equal(await one('SELECT count(*) FROM usage_events e LEFT JOIN tenants t USING (tenant_id) WHERE t.tenant_id IS NULL'), 0);
  assert.equal(await one('SELECT count(*) FROM users u LEFT JOIN tenants t USING (tenant_id) WHERE t.tenant_id IS NULL'), 0);
});

test('events fall within each tenant lifetime', async () => {
  assert.equal(await one(`SELECT count(*) FROM usage_events e JOIN tenants t USING (tenant_id)
    WHERE e.event_time::DATE < t.signup_date OR (t.churn_date IS NOT NULL AND e.event_time::DATE >= t.churn_date)`), 0);
});

test('events are sorted by tenant then time', async () => {
  assert.equal(await one(`SELECT count(*) FROM (SELECT tenant_id, event_time, lag(tenant_id) OVER w AS pt, lag(event_time) OVER w AS pe
    FROM usage_events WINDOW w AS (ORDER BY event_id)) WHERE pt > tenant_id OR (pt = tenant_id AND pe > event_time)`), 0);
});

test('invoices exist only for paying tenants and lines add up', async () => {
  assert.ok(await one('SELECT count(*) FROM invoices') > 0);
  assert.equal(await one(`SELECT count(*) FROM invoices i JOIN tenants t USING (tenant_id) WHERE t.plan = 'free'`), 0);
  assert.equal(await one('SELECT count(*) FROM invoices i LEFT JOIN tenants t USING (tenant_id) WHERE t.tenant_id IS NULL'), 0);
  assert.equal(await one('SELECT count(*) FROM invoice_lines l LEFT JOIN invoices i USING (invoice_id) WHERE i.invoice_id IS NULL'), 0);
  assert.equal(await one(`SELECT count(*) FROM invoices i JOIN (SELECT invoice_id, sum(amount) a FROM invoice_lines GROUP BY 1) l USING (invoice_id) WHERE l.a <> i.amount`), 0);
  assert.equal(await one(`SELECT count(*) FROM invoices WHERE status NOT IN ('paid','overdue')`), 0);
});

test('no PII-looking values', async () => {
  const cols = [['tenants', 'name'], ['usage_events', 'feature'], ['usage_events', 'status'], ['users', 'role'], ['invoice_lines', 'description']];
  for (const [t, c] of cols) {
    assert.equal(await one(`SELECT count(*) FROM ${t} WHERE ${c} LIKE '%@%' OR regexp_matches(${c}, '[0-9]{3}[- .][0-9]{3,4}')`), 0, `${t}.${c}`);
  }
});
