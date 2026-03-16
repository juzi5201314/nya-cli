import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as sqliteVec from 'sqlite-vec';

import type { EmbeddingFingerprint } from '../providers/types';
import { extractSearchTerms } from '../utils/text';

const SCHEMA_VERSION = '4';

type MetadataKey =
  | 'schema_version'
  | 'embedding_fingerprint'
  | 'last_rebuild_at'
  | 'last_ingest_at';

type StoredMetadata = {
  key: MetadataKey;
  value: string;
  updated_at: string;
};

export type SourceKind = 'local_git' | 'remote_git' | 'web';

export type LearnChunkRow = {
  chunkIndex: number;
  section: string;
  content: string;
  tokenEstimate: number;
  contentHash: string;
};

export type LearnDocumentRow = {
  sourceKey: string;
  sourceKind: SourceKind;
  sourceLocator: string;
  canonicalLocator: string | null;
  path: string;
  language: string;
  title: string;
  contentHash: string;
  content: string;
};

export type SourceManifestRow = {
  sourceKey: string;
  sourceKind: SourceKind;
  provider: string;
  rootLocator: string;
  displayLocator: string;
  reingestPayloadJson: string;
  createdAt: string;
  updatedAt: string;
  lastIngestedAt: string;
  lastRebuildStatus: 'idle' | 'success' | 'failed';
  lastRebuildError: string | null;
  lastRebuildAttempts: number;
  lastRebuildAt: string | null;
  lastRebuildSuccessAt: string | null;
};

export type SourceManifestInput = {
  sourceKey: string;
  sourceKind: SourceKind;
  provider: string;
  rootLocator: string;
  displayLocator: string;
  reingestPayloadJson: string;
};

export type SourceManifestRebuildState = {
  status: 'idle' | 'success' | 'failed';
  error: string | null;
  attempts: number;
  rebuildAt: string | null;
  rebuildSuccessAt: string | null;
};

export type DbStats = {
  documents: number;
  chunks: number;
  hasFts: boolean;
  hasVector: boolean;
  fingerprint: EmbeddingFingerprint | null;
  sourceManifests: number;
  failedSourceManifests: number;
};

export type DbDoctorReport = {
  dbPath: string;
  dbExists: boolean;
  hasFts: boolean;
  hasVector: boolean;
  fingerprint: EmbeddingFingerprint | null;
  sourceManifests: number;
  failedSourceManifests: number;
};

export type IndexState = {
  needsRebuild: boolean;
  reason: string | null;
  fingerprint: EmbeddingFingerprint | null;
  sourceManifests: number;
  hasSearchTables: boolean;
};

type SearchTablesOptions = {
  dimensions: number;
};

function nowIso(): string {
  return new Date().toISOString();
}

function maybeConfigureCustomSqlite(): void {
  if (process.platform !== 'darwin') {
    return;
  }

  const dylib = process.env.NYA_CLI_SQLITE_DYLIB;
  if (dylib) {
    Database.setCustomSQLite(dylib);
  }
}

export async function openDatabase(databasePath: string): Promise<Database> {
  maybeConfigureCustomSqlite();
  await mkdir(dirname(databasePath), { recursive: true });

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const db = new Database(databasePath, {
        create: true,
        strict: true,
        safeIntegers: true,
      });

      db.run('PRAGMA busy_timeout = 5000;');
      db.run('PRAGMA journal_mode = WAL;');
      db.run('PRAGMA foreign_keys = ON;');
      sqliteVec.load(db);
      ensureMetadataTable(db);
      ensureSchema(db);
      ensureSourceManifestTable(db);
      return db;
    } catch (error) {
      lastError = error;
      await Bun.sleep(200 * (attempt + 1));
    }
  }

  throw lastError;
}

export function closeDatabase(db: Database): void {
  db.close(false);
}

function ensureMetadataTable(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS index_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function getMetadata(db: Database, key: MetadataKey): StoredMetadata | null {
  const row = db
    .query<StoredMetadata, [string]>(
      'SELECT key, value, updated_at FROM index_metadata WHERE key = ?1'
    )
    .get(key);
  return row ?? null;
}

function setMetadata(db: Database, key: MetadataKey, value: string): void {
  db.query(
    `
      INSERT INTO index_metadata(key, value, updated_at)
      VALUES (?1, ?2, ?3)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `
  ).run(key, value, nowIso());
}

function deleteMetadata(db: Database, key: MetadataKey): void {
  db.query('DELETE FROM index_metadata WHERE key = ?1').run(key);
}

function ensureSchema(db: Database): void {
  const version = getMetadata(db, 'schema_version')?.value;
  if (version === SCHEMA_VERSION) {
    if (columnExists(db, 'documents', 'content')) {
      backfillDocumentContentColumn(db);
    }
    return;
  }

  if (version === '3') {
    migrateSchemaV3ToV4(db);
    return;
  }

  resetManagedState(db);
  setMetadata(db, 'schema_version', SCHEMA_VERSION);
}

function tableExists(db: Database, tableName: string): boolean {
  const row = db
    .query<{ name: string }, [string]>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1"
    )
    .get(tableName);
  return Boolean(row);
}

function columnExists(
  db: Database,
  tableName: string,
  columnName: string
): boolean {
  if (!tableExists(db, tableName)) {
    return false;
  }

  const rows = db
    .query<{ name: string }, []>(`PRAGMA table_info(${tableName})`)
    .all();
  return rows.some((row) => row.name === columnName);
}

function ensureSourceManifestTable(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS source_manifests (
      source_key TEXT PRIMARY KEY,
      source_kind TEXT NOT NULL,
      provider TEXT NOT NULL,
      root_locator TEXT NOT NULL,
      display_locator TEXT NOT NULL,
      reingest_payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_ingested_at TEXT NOT NULL,
      last_rebuild_status TEXT NOT NULL,
      last_rebuild_error TEXT,
      last_rebuild_attempts INTEGER NOT NULL,
      last_rebuild_at TEXT,
      last_rebuild_success_at TEXT
    );
  `);
}

function createSearchTables(db: Database, options: SearchTablesOptions): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_key TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_locator TEXT NOT NULL,
      canonical_locator TEXT,
      path TEXT NOT NULL,
      language TEXT NOT NULL,
      title TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(source_key, path)
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      section TEXT NOT NULL,
      content TEXT NOT NULL,
      token_estimate INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
      content,
      path UNINDEXED,
      section UNINDEXED
    );
  `);

  db.run(
    `CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vec USING vec0(embedding float[${options.dimensions}]);`
  );
}

function dropSearchTables(db: Database): void {
  db.run(`
    DROP TABLE IF EXISTS chunk_vec;
    DROP TABLE IF EXISTS chunk_fts;
    DROP TABLE IF EXISTS chunks;
    DROP TABLE IF EXISTS documents;
  `);
}

function resetManagedState(db: Database): void {
  dropSearchTables(db);
  db.run('DROP TABLE IF EXISTS source_manifests;');
  db.run('DELETE FROM index_metadata;');
}

function mergeChunkContent(base: string, next: string): string {
  if (!base) {
    return next;
  }
  if (!next) {
    return base;
  }

  const maxOverlap = Math.min(base.length, next.length);
  for (let overlap = maxOverlap; overlap >= 8; overlap -= 1) {
    if (base.endsWith(next.slice(0, overlap))) {
      return `${base}${next.slice(overlap)}`;
    }
  }

  return `${base}\n\n${next}`;
}

function reconstructDocumentContents(
  db: Database,
  documentIds: number[]
): Map<number, string> {
  if (documentIds.length === 0 || !tableExists(db, 'chunks')) {
    return new Map();
  }

  const placeholders = documentIds
    .map((_, index) => `?${index + 1}`)
    .join(', ');
  const rows = db
    .query<
      { documentId: number; chunkIndex: number; content: string },
      number[]
    >(
      `
        SELECT
          document_id AS documentId,
          chunk_index AS chunkIndex,
          content
        FROM chunks
        WHERE document_id IN (${placeholders})
        ORDER BY document_id, chunk_index
      `
    )
    .all(...documentIds)
    .map((row) => ({
      ...row,
      documentId: Number(row.documentId),
      chunkIndex: Number(row.chunkIndex),
    }));

  const contentMap = new Map<number, string>();
  for (const row of rows) {
    const current = contentMap.get(row.documentId) ?? '';
    contentMap.set(row.documentId, mergeChunkContent(current, row.content));
  }

  return contentMap;
}

function backfillDocumentContentColumn(db: Database): void {
  if (!columnExists(db, 'documents', 'content')) {
    return;
  }

  const rows = db
    .query<{ documentId: number; content: string | null }, []>(
      `
        SELECT id AS documentId, content
        FROM documents
        WHERE content IS NULL OR content = ''
        ORDER BY id
      `
    )
    .all()
    .map((row) => ({
      ...row,
      documentId: Number(row.documentId),
    }));

  const reconstructed = reconstructDocumentContents(
    db,
    rows.map((row) => row.documentId)
  );
  const updateContent = db.prepare(
    'UPDATE documents SET content = ?2 WHERE id = ?1'
  );

  for (const row of rows) {
    updateContent.run(row.documentId, reconstructed.get(row.documentId) ?? '');
  }
}

function migrateSchemaV3ToV4(db: Database): void {
  if (!tableExists(db, 'documents')) {
    setMetadata(db, 'schema_version', SCHEMA_VERSION);
    return;
  }

  if (!columnExists(db, 'documents', 'content')) {
    db.run('ALTER TABLE documents ADD COLUMN content TEXT;');
  }

  backfillDocumentContentColumn(db);
  setMetadata(db, 'schema_version', SCHEMA_VERSION);
}

export function getStoredFingerprint(
  db: Database
): EmbeddingFingerprint | null {
  const row = getMetadata(db, 'embedding_fingerprint');
  if (!row) {
    return null;
  }

  return JSON.parse(row.value) as EmbeddingFingerprint;
}

function setStoredFingerprint(
  db: Database,
  fingerprint: EmbeddingFingerprint
): void {
  setMetadata(db, 'embedding_fingerprint', JSON.stringify(fingerprint));
}

function fingerprintsEqual(
  left: EmbeddingFingerprint | null,
  right: EmbeddingFingerprint
): boolean {
  if (!left) {
    return false;
  }

  return (
    left.provider === right.provider &&
    left.model === right.model &&
    left.dimensions === right.dimensions &&
    left.taskType === right.taskType &&
    left.chunkingVersion === right.chunkingVersion &&
    left.chunker === right.chunker
  );
}

export function inspectIndexState(
  db: Database,
  fingerprint: EmbeddingFingerprint
): IndexState {
  const storedFingerprint = getStoredFingerprint(db);
  const hasSearchTables =
    tableExists(db, 'documents') &&
    tableExists(db, 'chunks') &&
    tableExists(db, 'chunk_fts') &&
    tableExists(db, 'chunk_vec');
  const sourceManifests = listSourceManifests(db).length;

  if (!hasSearchTables) {
    return {
      needsRebuild: true,
      reason: 'index bootstrap required',
      fingerprint: storedFingerprint,
      sourceManifests,
      hasSearchTables,
    };
  }

  if (!fingerprintsEqual(storedFingerprint, fingerprint)) {
    return {
      needsRebuild: true,
      reason: storedFingerprint
        ? 'embedding fingerprint changed'
        : 'embedding fingerprint missing',
      fingerprint: storedFingerprint,
      sourceManifests,
      hasSearchTables,
    };
  }

  return {
    needsRebuild: false,
    reason: null,
    fingerprint: storedFingerprint,
    sourceManifests,
    hasSearchTables,
  };
}

export function initializeEmptyIndex(
  db: Database,
  fingerprint: EmbeddingFingerprint
): void {
  dropSearchTables(db);
  createSearchTables(db, {
    dimensions: fingerprint.dimensions,
  });
  setStoredFingerprint(db, fingerprint);
  setMetadata(db, 'last_rebuild_at', nowIso());
}

export function clearDatabase(db: Database): void {
  resetManagedState(db);
  ensureMetadataTable(db);
  ensureSchema(db);
  ensureSourceManifestTable(db);
}

export function upsertSourceManifest(
  db: Database,
  manifest: SourceManifestInput
): void {
  const existing = getSourceManifest(db, manifest.sourceKey);
  const createdAt = existing?.createdAt ?? nowIso();
  const updatedAt = nowIso();
  const lastIngestedAt = nowIso();

  db.query(
    `
      INSERT INTO source_manifests(
        source_key,
        source_kind,
        provider,
        root_locator,
        display_locator,
        reingest_payload_json,
        created_at,
        updated_at,
        last_ingested_at,
        last_rebuild_status,
        last_rebuild_error,
        last_rebuild_attempts,
        last_rebuild_at,
        last_rebuild_success_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
      ON CONFLICT(source_key) DO UPDATE SET
        source_kind = excluded.source_kind,
        provider = excluded.provider,
        root_locator = excluded.root_locator,
        display_locator = excluded.display_locator,
        reingest_payload_json = excluded.reingest_payload_json,
        updated_at = excluded.updated_at,
        last_ingested_at = excluded.last_ingested_at
    `
  ).run(
    manifest.sourceKey,
    manifest.sourceKind,
    manifest.provider,
    manifest.rootLocator,
    manifest.displayLocator,
    manifest.reingestPayloadJson,
    createdAt,
    updatedAt,
    lastIngestedAt,
    existing?.lastRebuildStatus ?? 'idle',
    existing?.lastRebuildError ?? null,
    existing?.lastRebuildAttempts ?? 0,
    existing?.lastRebuildAt ?? null,
    existing?.lastRebuildSuccessAt ?? null
  );
}

export function listSourceManifests(db: Database): SourceManifestRow[] {
  if (!tableExists(db, 'source_manifests')) {
    return [];
  }

  return db
    .query<
      {
        sourceKey: string;
        sourceKind: SourceKind;
        provider: string;
        rootLocator: string;
        displayLocator: string;
        reingestPayloadJson: string;
        createdAt: string;
        updatedAt: string;
        lastIngestedAt: string;
        lastRebuildStatus: 'idle' | 'success' | 'failed';
        lastRebuildError: string | null;
        lastRebuildAttempts: number | bigint;
        lastRebuildAt: string | null;
        lastRebuildSuccessAt: string | null;
      },
      []
    >(
      `
        SELECT
          source_key AS sourceKey,
          source_kind AS sourceKind,
          provider AS provider,
          root_locator AS rootLocator,
          display_locator AS displayLocator,
          reingest_payload_json AS reingestPayloadJson,
          created_at AS createdAt,
          updated_at AS updatedAt,
          last_ingested_at AS lastIngestedAt,
          last_rebuild_status AS lastRebuildStatus,
          last_rebuild_error AS lastRebuildError,
          last_rebuild_attempts AS lastRebuildAttempts,
          last_rebuild_at AS lastRebuildAt,
          last_rebuild_success_at AS lastRebuildSuccessAt
        FROM source_manifests
        ORDER BY source_key
      `
    )
    .all()
    .map((row) => ({
      ...row,
      lastRebuildAttempts: Number(row.lastRebuildAttempts),
    }));
}

export function getSourceManifest(
  db: Database,
  sourceKey: string
): SourceManifestRow | null {
  const row = db
    .query<
      {
        sourceKey: string;
        sourceKind: SourceKind;
        provider: string;
        rootLocator: string;
        displayLocator: string;
        reingestPayloadJson: string;
        createdAt: string;
        updatedAt: string;
        lastIngestedAt: string;
        lastRebuildStatus: 'idle' | 'success' | 'failed';
        lastRebuildError: string | null;
        lastRebuildAttempts: number | bigint;
        lastRebuildAt: string | null;
        lastRebuildSuccessAt: string | null;
      },
      [string]
    >(
      `
        SELECT
          source_key AS sourceKey,
          source_kind AS sourceKind,
          provider AS provider,
          root_locator AS rootLocator,
          display_locator AS displayLocator,
          reingest_payload_json AS reingestPayloadJson,
          created_at AS createdAt,
          updated_at AS updatedAt,
          last_ingested_at AS lastIngestedAt,
          last_rebuild_status AS lastRebuildStatus,
          last_rebuild_error AS lastRebuildError,
          last_rebuild_attempts AS lastRebuildAttempts,
          last_rebuild_at AS lastRebuildAt,
          last_rebuild_success_at AS lastRebuildSuccessAt
        FROM source_manifests
        WHERE source_key = ?1
      `
    )
    .get(sourceKey);

  if (!row) {
    return null;
  }

  return {
    ...row,
    lastRebuildAttempts: Number(row.lastRebuildAttempts),
  };
}

export function listFailedSourceManifests(db: Database): SourceManifestRow[] {
  return listSourceManifests(db).filter(
    (manifest) => manifest.lastRebuildStatus === 'failed'
  );
}

export function updateSourceManifestRebuildState(
  db: Database,
  sourceKey: string,
  state: SourceManifestRebuildState
): void {
  if (!tableExists(db, 'source_manifests')) {
    return;
  }

  db.query(
    `
      UPDATE source_manifests
      SET
        last_rebuild_status = ?2,
        last_rebuild_error = ?3,
        last_rebuild_attempts = ?4,
        last_rebuild_at = ?5,
        last_rebuild_success_at = ?6
      WHERE source_key = ?1
    `
  ).run(
    sourceKey,
    state.status,
    state.error,
    state.attempts,
    state.rebuildAt,
    state.rebuildSuccessAt
  );
}

function deleteSourceData(db: Database, sourceKey: string): void {
  const deleteChunkVec = db.prepare('DELETE FROM chunk_vec WHERE rowid = ?1');
  const deleteChunkFts = db.prepare('DELETE FROM chunk_fts WHERE rowid = ?1');
  const deleteChunk = db.prepare('DELETE FROM chunks WHERE id = ?1');
  const deleteDocument = db.prepare('DELETE FROM documents WHERE id = ?1');

  const existingDocumentIds = db
    .query<{ id: number }, [string]>(
      'SELECT id FROM documents WHERE source_key = ?1 ORDER BY id'
    )
    .all(sourceKey);

  for (const document of existingDocumentIds) {
    const chunkIds = db
      .query<{ id: number }, [number]>(
        'SELECT id FROM chunks WHERE document_id = ?1 ORDER BY id'
      )
      .all(Number(document.id));

    for (const chunk of chunkIds) {
      deleteChunkVec.run(Number(chunk.id));
      deleteChunkFts.run(Number(chunk.id));
      deleteChunk.run(Number(chunk.id));
    }

    deleteDocument.run(Number(document.id));
  }
}

export function replaceSourceData(args: {
  db: Database;
  sourceKey: string;
  documents: Array<{
    document: LearnDocumentRow;
    chunks: LearnChunkRow[];
    embedding: number[][];
  }>;
}): { documentCount: number; chunkCount: number } {
  const { db, sourceKey, documents } = args;
  const insertDocument = db.prepare(
    `
      INSERT INTO documents(
        source_key,
        source_kind,
        source_locator,
        canonical_locator,
        path,
        language,
        title,
        content_hash,
        content,
        created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
    `
  );
  const insertChunk = db.prepare(
    `
      INSERT INTO chunks(
        document_id,
        chunk_index,
        section,
        content,
        token_estimate,
        content_hash,
        created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    `
  );
  const insertFts = db.prepare(
    'INSERT INTO chunk_fts(rowid, content, path, section) VALUES (?1, ?2, ?3, ?4)'
  );
  const insertVec = db.prepare(
    'INSERT INTO chunk_vec(rowid, embedding) VALUES (?1, ?2)'
  );

  const tx = db.transaction(() => {
    deleteSourceData(db, sourceKey);

    let documentCount = 0;
    let chunkCount = 0;

    for (const entry of documents) {
      const createdAt = nowIso();
      const documentResult = insertDocument.run(
        entry.document.sourceKey,
        entry.document.sourceKind,
        entry.document.sourceLocator,
        entry.document.canonicalLocator,
        entry.document.path,
        entry.document.language,
        entry.document.title,
        entry.document.contentHash,
        entry.document.content,
        createdAt
      );
      const documentId = Number(documentResult.lastInsertRowid);

      for (const [index, chunk] of entry.chunks.entries()) {
        const chunkResult = insertChunk.run(
          documentId,
          chunk.chunkIndex,
          chunk.section,
          chunk.content,
          chunk.tokenEstimate,
          chunk.contentHash,
          createdAt
        );
        const chunkId = Number(chunkResult.lastInsertRowid);
        insertFts.run(
          chunkId,
          chunk.content,
          entry.document.path,
          chunk.section
        );
        insertVec.run(chunkId, new Float32Array(entry.embedding[index] ?? []));
        chunkCount += 1;
      }

      documentCount += 1;
    }

    setMetadata(db, 'last_ingest_at', nowIso());
    return {
      documentCount,
      chunkCount,
    };
  });

  return tx.immediate();
}

export type SearchHitRow = {
  id: number;
  documentId: number;
  sourceKey: string;
  content: string;
  section: string;
  path: string;
  sourceKind: string;
};

export type StoredDocumentRow = {
  documentId: number;
  sourceKey: string;
  sourceKind: SourceKind;
  sourceLocator: string;
  canonicalLocator: string | null;
  path: string;
  language: string;
  title: string;
  contentHash: string;
  content: string;
  createdAt: string;
};

export function searchVector(
  db: Database,
  embedding: number[],
  limit: number,
  pathSuffixes: string[] = []
): Array<{ chunkId: number; rank: number }> {
  if (!tableExists(db, 'chunk_vec')) {
    return [];
  }

  const suffixClause =
    pathSuffixes.length > 0
      ? ` AND (${pathSuffixes
          .map((_, index) => `LOWER(documents.path) LIKE '%' || ?${index + 3}`)
          .join(' OR ')})`
      : '';

  const rows = db
    .query<{ chunkId: number }, [Float32Array, number, ...string[]]>(
      `
        SELECT vec_hits.chunkId AS chunkId
        FROM (
          SELECT rowid AS chunkId, distance
          FROM chunk_vec
          WHERE embedding MATCH ?1
          ORDER BY distance
          LIMIT ?2
        ) AS vec_hits
        JOIN chunks ON chunks.id = vec_hits.chunkId
        JOIN documents ON documents.id = chunks.document_id
        WHERE 1 = 1
        ${suffixClause}
        ORDER BY vec_hits.distance
      `
    )
    .all(new Float32Array(embedding), limit, ...pathSuffixes);

  return rows.map((row, index) => ({
    chunkId: Number(row.chunkId),
    rank: index + 1,
  }));
}

function buildFtsQuery(query: string): string | null {
  const tokens = extractSearchTerms(query);
  if (tokens.length === 0) {
    return null;
  }

  return tokens
    .slice(0, 8)
    .map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(' OR ');
}

export function searchFts(
  db: Database,
  query: string,
  limit: number,
  pathSuffixes: string[] = []
): Array<{ chunkId: number; rank: number }> {
  if (!tableExists(db, 'chunk_fts')) {
    return [];
  }

  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) {
    return [];
  }

  const suffixClause =
    pathSuffixes.length > 0
      ? ` AND (${pathSuffixes
          .map((_, index) => `LOWER(documents.path) LIKE '%' || ?${index + 3}`)
          .join(' OR ')})`
      : '';

  const rows = db
    .query<{ chunkId: number }, [string, number, ...string[]]>(
      `
        SELECT chunk_fts.rowid AS chunkId
        FROM chunk_fts
        JOIN chunks ON chunks.id = chunk_fts.rowid
        JOIN documents ON documents.id = chunks.document_id
        WHERE chunk_fts MATCH ?1
        ${suffixClause}
        ORDER BY bm25(chunk_fts)
        LIMIT ?2
      `
    )
    .all(ftsQuery, limit, ...pathSuffixes);

  return rows.map((row, index) => ({
    chunkId: Number(row.chunkId),
    rank: index + 1,
  }));
}

export function searchLike(
  db: Database,
  query: string,
  limit: number,
  pathSuffixes: string[] = []
): Array<{ chunkId: number; rank: number }> {
  if (!tableExists(db, 'chunks')) {
    return [];
  }

  const tokens = extractSearchTerms(query);
  if (tokens.length === 0) {
    return [];
  }

  const uniqueTokens = [
    ...new Set(tokens.map((token) => token.toLowerCase())),
  ].slice(0, 8);
  const suffixOffset = uniqueTokens.length + 1;
  const conditions = uniqueTokens
    .map((_, index) => `LOWER(chunks.content) LIKE ?${index + 1}`)
    .join(' OR ');
  const suffixClause =
    pathSuffixes.length > 0
      ? ` AND (${pathSuffixes
          .map(
            (_, index) =>
              `LOWER(documents.path) LIKE '%' || ?${suffixOffset + index}`
          )
          .join(' OR ')})`
      : '';
  const statement = db.query<{ chunkId: number }, string[]>(
    `
      SELECT chunks.id AS chunkId
      FROM chunks
      JOIN documents ON documents.id = chunks.document_id
      WHERE ${conditions}
      ${suffixClause}
      ORDER BY chunks.id
      LIMIT ${limit}
    `
  );
  const rows = statement.all(
    ...uniqueTokens.map((token) => `%${token}%`),
    ...pathSuffixes
  );

  return rows.map((row, index) => ({
    chunkId: Number(row.chunkId),
    rank: index + 1,
  }));
}

export function searchMetadataLike(
  db: Database,
  query: string,
  limit: number,
  pathSuffixes: string[] = []
): number[] {
  if (!tableExists(db, 'chunks') || !tableExists(db, 'documents')) {
    return [];
  }

  const tokens = extractSearchTerms(query);
  if (tokens.length === 0) {
    return [];
  }

  const placeholders = tokens
    .map(
      (_, index) =>
        `(LOWER(documents.path) LIKE ?${index + 1} OR LOWER(chunks.section) LIKE ?${index + 1})`
    )
    .join(' OR ');
  const suffixOffset = tokens.length + 1;
  const suffixClause =
    pathSuffixes.length > 0
      ? ` AND (${pathSuffixes
          .map(
            (_, index) =>
              `LOWER(documents.path) LIKE '%' || ?${suffixOffset + index}`
          )
          .join(' OR ')})`
      : '';

  const statement = db.query<{ chunkId: number }, string[]>(
    `
      SELECT chunks.id AS chunkId
      FROM chunks
      JOIN documents ON documents.id = chunks.document_id
      WHERE ${placeholders}
      ${suffixClause}
      ORDER BY chunks.id
      LIMIT ${limit}
    `
  );
  const rows = statement.all(
    ...tokens.map((token) => `%${token}%`),
    ...pathSuffixes
  );

  return rows.map((row) => Number(row.chunkId));
}

function normalizeDocumentLookupPath(path: string): string {
  if (/^[a-z]+:\/\//i.test(path)) {
    return path;
  }

  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

type StoredDocumentQueryRow = {
  documentId: number;
  sourceKey: string;
  sourceKind: SourceKind;
  sourceLocator: string;
  canonicalLocator: string | null;
  path: string;
  language: string;
  title: string;
  contentHash: string;
  content: string | null;
  createdAt: string;
};

function hydrateStoredDocuments(
  db: Database,
  rows: StoredDocumentQueryRow[]
): StoredDocumentRow[] {
  const missingContentIds = rows
    .filter((row) => !row.content)
    .map((row) => Number(row.documentId));
  const reconstructed = reconstructDocumentContents(db, missingContentIds);

  return rows.map((row) => ({
    ...row,
    documentId: Number(row.documentId),
    content: row.content ?? reconstructed.get(Number(row.documentId)) ?? '',
  }));
}

export function getDocumentById(
  db: Database,
  documentId: number
): StoredDocumentRow | null {
  if (!tableExists(db, 'documents')) {
    return null;
  }

  const row = db
    .query<StoredDocumentQueryRow, [number]>(
      `
        SELECT
          id AS documentId,
          source_key AS sourceKey,
          source_kind AS sourceKind,
          source_locator AS sourceLocator,
          canonical_locator AS canonicalLocator,
          path,
          language,
          title,
          content_hash AS contentHash,
          content,
          created_at AS createdAt
        FROM documents
        WHERE id = ?1
      `
    )
    .get(documentId);

  if (!row) {
    return null;
  }

  return hydrateStoredDocuments(db, [row])[0] ?? null;
}

export function findDocumentsByPath(
  db: Database,
  path: string,
  sourceKey?: string
): StoredDocumentRow[] {
  if (!tableExists(db, 'documents')) {
    return [];
  }

  const normalizedPath = normalizeDocumentLookupPath(path);

  const rows = sourceKey
    ? db
        .query<StoredDocumentQueryRow, [string, string]>(
          `
            SELECT
              id AS documentId,
              source_key AS sourceKey,
              source_kind AS sourceKind,
              source_locator AS sourceLocator,
              canonical_locator AS canonicalLocator,
              path,
              language,
              title,
              content_hash AS contentHash,
              content,
              created_at AS createdAt
            FROM documents
            WHERE path = ?1 AND source_key = ?2
            ORDER BY id
          `
        )
        .all(normalizedPath, sourceKey)
    : db
        .query<StoredDocumentQueryRow, [string]>(
          `
            SELECT
              id AS documentId,
              source_key AS sourceKey,
              source_kind AS sourceKind,
              source_locator AS sourceLocator,
              canonical_locator AS canonicalLocator,
              path,
              language,
              title,
              content_hash AS contentHash,
              content,
              created_at AS createdAt
            FROM documents
            WHERE path = ?1
            ORDER BY id
          `
        )
        .all(normalizedPath);

  return hydrateStoredDocuments(db, rows);
}

export function getSearchHits(
  db: Database,
  chunkIds: number[]
): SearchHitRow[] {
  if (chunkIds.length === 0) {
    return [];
  }

  const placeholders = chunkIds.map((_, index) => `?${index + 1}`).join(', ');
  const statement = db.query<SearchHitRow, number[]>(
    `
      SELECT
        chunks.id AS id,
        documents.id AS documentId,
        documents.source_key AS sourceKey,
        chunks.content AS content,
        chunks.section AS section,
        documents.path AS path,
        documents.source_kind AS sourceKind
      FROM chunks
      JOIN documents ON documents.id = chunks.document_id
      WHERE chunks.id IN (${placeholders})
    `
  );

  return statement.all(...chunkIds).map((row) => ({
    ...row,
    id: Number(row.id),
    documentId: Number(row.documentId),
  }));
}

export function getDbStats(db: Database): DbStats {
  const manifests = listSourceManifests(db);
  const documents = tableExists(db, 'documents')
    ? Number(
        db
          .query<{ count: bigint }, []>(
            'SELECT COUNT(*) AS count FROM documents'
          )
          .get()?.count ?? 0n
      )
    : 0;
  const chunks = tableExists(db, 'chunks')
    ? Number(
        db
          .query<{ count: bigint }, []>('SELECT COUNT(*) AS count FROM chunks')
          .get()?.count ?? 0n
      )
    : 0;

  return {
    documents,
    chunks,
    hasFts: tableExists(db, 'chunk_fts'),
    hasVector: tableExists(db, 'chunk_vec'),
    fingerprint: getStoredFingerprint(db),
    sourceManifests: manifests.length,
    failedSourceManifests: manifests.filter(
      (manifest) => manifest.lastRebuildStatus === 'failed'
    ).length,
  };
}

export function getDoctorReport(dbPath: string, db: Database): DbDoctorReport {
  const stats = getDbStats(db);
  return {
    dbPath,
    dbExists: existsSync(dbPath),
    hasFts: stats.hasFts,
    hasVector: stats.hasVector,
    fingerprint: stats.fingerprint,
    sourceManifests: stats.sourceManifests,
    failedSourceManifests: stats.failedSourceManifests,
  };
}

export function deleteSourceManifest(db: Database, sourceKey: string): void {
  if (!tableExists(db, 'source_manifests')) {
    return;
  }
  db.query('DELETE FROM source_manifests WHERE source_key = ?1').run(sourceKey);
}

export function setLastRebuildAt(db: Database): void {
  setMetadata(db, 'last_rebuild_at', nowIso());
}

export function clearFingerprint(db: Database): void {
  deleteMetadata(db, 'embedding_fingerprint');
}
