import {
  findDocumentsByPath,
  getDocumentById,
  type StoredDocumentRow,
} from '../db/database';
import {
  closeDatabase,
  loadDbRuntime,
  printOutput,
  resolveDefaultScope,
} from './shared';

function renderDocument(args: {
  scope: 'global' | 'project';
  databasePath: string;
  document: StoredDocumentRow;
}): string {
  const { document } = args;
  const lines = [
    `scope: ${args.scope}`,
    `database: ${args.databasePath}`,
    `document_id: ${document.documentId}`,
    `source_key: ${document.sourceKey}`,
    `source_kind: ${document.sourceKind}`,
    `source_locator: ${document.sourceLocator}`,
    `canonical_locator: ${document.canonicalLocator ?? 'null'}`,
    `path: ${document.path}`,
    `language: ${document.language}`,
    `title: ${document.title}`,
    `content_hash: ${document.contentHash}`,
    '',
    document.content,
  ];

  return lines.join('\n');
}

export async function runGet(args: {
  path: string | undefined;
  documentId: number | undefined;
  sourceKey: string | undefined;
  configPath: string | undefined;
  project: boolean;
  asJson: boolean;
}): Promise<void> {
  if ((args.path ? 1 : 0) + (args.documentId ? 1 : 0) !== 1) {
    throw new Error('get 必须且只能提供一个定位方式：<path> 或 --document-id');
  }

  const scope = resolveDefaultScope(args.project);
  const runtime = await loadDbRuntime({
    configPath: args.configPath,
    scope,
  });

  try {
    const document =
      args.documentId !== undefined
        ? getDocumentById(runtime.db, args.documentId)
        : (() => {
            const matches = findDocumentsByPath(
              runtime.db,
              args.path ?? '',
              args.sourceKey
            );
            if (matches.length === 0) {
              throw new Error(`未找到文档: ${args.path}`);
            }
            if (matches.length > 1) {
              const candidates = matches
                .map(
                  (item) =>
                    `document_id=${item.documentId} source_key=${item.sourceKey} path=${item.path}`
                )
                .join(' | ');
              throw new Error(
                `path 匹配到多个文档，请改用 --source 或 --document-id。候选: ${candidates}`
              );
            }
            return matches[0] ?? null;
          })();

    if (!document) {
      throw new Error(
        args.documentId !== undefined
          ? `未找到 document_id=${args.documentId} 的文档`
          : `未找到文档: ${args.path}`
      );
    }

    const result = {
      scope: runtime.scope,
      databasePath: runtime.scopePaths.databasePath,
      document,
    };

    printOutput(
      args.asJson
        ? result
        : renderDocument({
            scope: runtime.scope,
            databasePath: runtime.scopePaths.databasePath,
            document,
          }),
      args.asJson
    );
  } finally {
    closeDatabase(runtime.db);
  }
}
