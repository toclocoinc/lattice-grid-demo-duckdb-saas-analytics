/**
 * DuckDB-Wasm, started in the page.
 *
 * The grid ships no engine. `duckdbAdapter` takes a connection the host made
 * and imports nothing, so everything about DuckDB — which version, where it
 * comes from, what extensions are loaded — is decided here and nowhere else.
 *
 * Two details matter more than the rest:
 *
 *   `LOAD httpfs`. Without it DuckDB's HTTP filesystem is not in play and the
 *   engine reads the whole Parquet file in one GET before it can answer
 *   anything. With it, the file is opened by its footer and read in byte
 *   ranges: the metadata, then only the row groups and column chunks a query
 *   needs. That is the difference between downloading a whole file and reading the
 *   few row groups one tenant's rows sit in.
 *
 *   The absolute URL. DuckDB resolves the path itself, inside a worker, so a
 *   relative path has nothing to resolve against. `new URL(..., location.href)`
 *   is what makes the same code work at the site root and under a project
 *   path on GitHub Pages.
 */

/** Pinned. A CDN import with no version is a demo that breaks on someone else's release day. */
export const DUCKDB_VERSION = '1.32.0';
export const DUCKDB_MODULE = `https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@${DUCKDB_VERSION}/+esm`;

/**
 * Start the engine and open a connection with httpfs loaded.
 *
 * @param {(message: string) => void} [onStatus] progress, for the loading panel
 * @returns {Promise<{duckdb: object, db: object, connection: object, worker: Worker, version: string, close: () => void}>}
 */
export async function startDuckDB(onStatus = () => {}) {
  onStatus(`Loading DuckDB-Wasm ${DUCKDB_VERSION} from jsDelivr...`);
  const duckdb = await import(/* @vite-ignore */ DUCKDB_MODULE);
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());

  onStatus('Starting the engine...');
  const worker = await duckdb.createWorker(bundle.mainWorker);
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.ERROR), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);

  const connection = await db.connect();
  await connection.query('LOAD httpfs;');

  const version = (await readOne(connection, 'SELECT version() AS v'))?.v ?? 'unknown';

  return {
    duckdb,
    db,
    connection,
    worker,
    version: String(version),
    close() {
      try { connection.close?.(); } catch { /* already gone */ }
      try { worker.terminate?.(); } catch { /* already gone */ }
    },
  };
}

/** One row of a one-row query, as a plain object. */
export async function readOne(connection, sql) {
  const result = await connection.query(sql);
  const rows = result.toArray().map((r) => r.toJSON());
  return rows[0] ?? null;
}

/**
 * Wrap a connection so every statement that passes through it is recorded.
 *
 * The adapter is handed the wrapper, never the connection, so there is no way
 * for a statement to reach DuckDB without being seen. This is what fills the
 * push-plan panel: not a reconstruction of what the grid probably asked for,
 * but the text the engine actually ran, with the values that were bound to it
 * and how long it took.
 *
 * It has exactly the two methods `duckdbAdapter` uses. `prepare` matters:
 * filter values are bound, never interpolated, and the recorded `params` are
 * what proves it.
 *
 * @param {object} connection a DuckDB-Wasm connection
 * @param {(entry: {sql: string, params: unknown[], ms: number, rows: number}) => void} record
 */
export function recordingConnection(connection, record) {
  const note = (sql, params, started, result) => {
    const rows = typeof result?.numRows === 'number' ? result.numRows : 0;
    record({ sql, params, ms: Math.round(performance.now() - started), rows });
  };
  return {
    query: async (sql) => {
      const started = performance.now();
      const result = await connection.query(sql);
      note(sql, [], started, result);
      return result;
    },
    prepare: async (sql) => {
      const statement = await connection.prepare(sql);
      return {
        query: async (...params) => {
          const started = performance.now();
          const result = await statement.query(...params);
          note(sql, params, started, result);
          return result;
        },
        close: () => statement.close?.(),
      };
    },
  };
}
