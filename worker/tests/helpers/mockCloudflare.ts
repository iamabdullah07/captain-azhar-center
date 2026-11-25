import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Env } from '../../src/types';

export function createMockR2(): R2Bucket & { store: Map<string, { bytes: Uint8Array; httpMetadata?: R2HTTPMetadata }> } {
  const store = new Map<string, { bytes: Uint8Array; httpMetadata?: R2HTTPMetadata }>();

  const toUint8 = async (
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob | null
  ): Promise<Uint8Array> => {
    if (value === null) return new Uint8Array(0);
    if (typeof value === 'string') return new TextEncoder().encode(value);
    if (value instanceof Uint8Array) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    }
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (typeof (value as Blob).arrayBuffer === 'function') {
      return new Uint8Array(await (value as Blob).arrayBuffer());
    }
    const reader = (value as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      if (chunk) {
        chunks.push(chunk);
        total += chunk.byteLength;
      }
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.byteLength;
    }
    return out;
  };

  return {
    store,
    async put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob | null, opts?: R2PutOptions) {
      const bytes = await toUint8(value);
      store.set(key, { bytes, httpMetadata: opts?.httpMetadata as R2HTTPMetadata | undefined });
      return { key, size: bytes.byteLength } as unknown as R2Object;
    },
    async get(key: string, opts?: R2GetOptions) {
      const entry = store.get(key);
      if (!entry) return null;
      let slice = entry.bytes;
      if (opts?.range && typeof opts.range === 'object' && 'offset' in opts.range) {
        const start = opts.range.offset ?? 0;
        const len = opts.range.length ?? slice.byteLength - start;
        slice = slice.subarray(start, start + len);
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(slice);
          controller.close();
        },
      });
      return {
        key,
        size: slice.byteLength,
        body: stream,
        httpMetadata: entry.httpMetadata,
        async arrayBuffer() {
          return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
        },
      } as unknown as R2ObjectBody;
    },
    async delete(keys: string | string[]) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) store.delete(k);
    },
  } as unknown as R2Bucket & { store: Map<string, { bytes: Uint8Array; httpMetadata?: R2HTTPMetadata }> };
}

export function createMockD1(): D1Database {
  const sqlite = new DatabaseSync(':memory:');
  const migrationsDir = resolve(process.cwd(), 'migrations');
  const migrationFiles = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of migrationFiles) {
    sqlite.exec(readFileSync(resolve(migrationsDir, file), 'utf8'));
  }

  const makeStmt = (sql: string, boundArgs: unknown[] = []) => {
    const stmt = sqlite.prepare(sql);
    const runWithArgs = () => {
      const res = stmt.run(...(boundArgs as Array<string | number | null | Uint8Array>));
      return {
        success: true,
        meta: {
          changes: Number(res.changes ?? 0),
          last_row_id: Number(res.lastInsertRowid ?? 0),
        },
      };
    };

    return {
      bind(...args: unknown[]) {
        return makeStmt(sql, args);
      },
      async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
        const row = stmt.get(...(boundArgs as Array<string | number | null | Uint8Array>)) as
          | Record<string, unknown>
          | undefined;
        if (!row) return null;
        if (colName) return (row[colName] as T) ?? null;
        return { ...row } as T;
      },
      async all<T = Record<string, unknown>>() {
        const rows = stmt.all(...(boundArgs as Array<string | number | null | Uint8Array>)) as Array<
          Record<string, unknown>
        >;
        return {
          success: true,
          results: rows.map((r) => ({ ...r })) as T[],
          meta: { changes: 0 },
        };
      },
      async run() {
        return runWithArgs();
      },
      _execSync: runWithArgs,
    };
  };

  return {
    prepare(sql: string) {
      return makeStmt(sql) as unknown as D1PreparedStatement;
    },
    async batch(statements: D1PreparedStatement[]) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const s of statements) {
          results.push(await s.run());
        }
        sqlite.exec('COMMIT');
        return results;
      } catch (err) {
        sqlite.exec('ROLLBACK');
        throw err;
      }
    },
    async exec(sql: string) {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
  } as unknown as D1Database;
}

export function createTestEnv(overrides: Partial<Omit<Env, 'FILES'>> = {}): Env & {
  FILES: ReturnType<typeof createMockR2>;
} {
  return {
    FILES: createMockR2(),
    DB: createMockD1(),
    ADMIN_EMAIL: 'darkjutt7777@gmail.com',
    SESSION_SECRET: 'test-session-secret-0123456789abcdef0123456789abcdef',
    ALLOWED_ORIGINS: 'https://owner.github.io',
    FRONTEND_URL: 'https://owner.github.io/captain-azhar-center',
    APP_NAME: 'Captain Azhar Center',
    EMAIL_PROVIDER: 'resend',
    ...overrides,
  };
}
