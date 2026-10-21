#!/usr/bin/env node
// Builds the Parquet set the page reads into data/ (default: full scale).
//
// There is nothing to download: the data is synthetic and every row comes from
// tools/generate.mjs, seeded, so the set is reproducible from this repository
// alone. Files are sorted by tenant (then time) and written with zstd and
// ROW_GROUP_SIZE 100000 so a per-tenant read touches only a few row groups.
//
//   node tools/build-parquet.mjs                  # full scale -> data/*.parquet
//   node tools/build-parquet.mjs --scale small    # ~1M events -> data/*.parquet (development, verify)
//   node tools/build-parquet.mjs --seed 42 --out some/dir
//
// Upload data/*.parquet to https://data.latticegrid.dev/duckdb/lattice-grid-demo-duckdb-saas-analytics/
// The row counts and sizes printed at the end are what data/README.md records.
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from './generate.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };

const scale = opt('scale', 'full');
const out = resolve(opt('out', resolve(root, 'data')));
const result = await generate({ seed: Number(opt('seed', 42)), scale, out, log: (m) => console.log(m) });

const mb = (n) => (n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
console.log(`\nscale=${scale}  dir=${result.dir}`);
for (const [name, f] of Object.entries(result.files)) {
  console.log(`  ${name}.parquet  ${f.rows.toLocaleString('en-US')} rows  ${f.bytes} bytes (${mb(f.bytes)})`);
}
