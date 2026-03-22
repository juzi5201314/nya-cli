import { access } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';

import { Language, type Node, Parser } from 'web-tree-sitter';

import type { AppConfig } from '../../types/config';
import { sha256 } from '../../utils/hash';
import { estimateTokens } from '../../utils/text';
import type { ChunkedDocument } from './types';

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.bash': 'bash',
  '.c': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.cs': 'csharp',
  '.css': 'css',
  '.cxx': 'cpp',
  '.dart': 'dart',
  '.el': 'elisp',
  '.elm': 'elm',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.go': 'go',
  '.h': 'c',
  '.hpp': 'cpp',
  '.html': 'html',
  '.htm': 'html',
  '.hxx': 'cpp',
  '.java': 'java',
  '.js': 'javascript',
  '.json': 'json',
  '.jsx': 'javascript',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.lua': 'lua',
  '.mli': 'ocaml',
  '.ml': 'ocaml',
  '.php': 'php',
  '.py': 'python',
  '.ql': 'ql',
  '.rb': 'ruby',
  '.res': 'rescript',
  '.resi': 'rescript',
  '.rs': 'rust',
  '.scala': 'scala',
  '.scss': 'css',
  '.sh': 'bash',
  '.sol': 'solidity',
  '.swift': 'swift',
  '.toml': 'toml',
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.vue': 'vue',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.zig': 'zig',
  '.zsh': 'bash',
};

const WASM_FILENAME_BY_LANGUAGE: Record<string, string> = {
  csharp: 'tree-sitter-c_sharp.wasm',
  objc: 'tree-sitter-objc.wasm',
  objectivec: 'tree-sitter-objc.wasm',
  tsx: 'tree-sitter-tsx.wasm',
};

let parserInitPromise: Promise<void> | null = null;
const languageCache = new Map<string, Promise<Language | null>>();

function normalizeCodeContent(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/^(?:[ \t]*\n)+/, '')
    .replace(/(?:\n[ \t]*)+$/, '');
}

const SYMBOL_NODE_TYPES = new Set([
  'class',
  'class_declaration',
  'class_definition',
  'class_specifier',
  'constructor_declaration',
  'destructor_declaration',
  'enum',
  'enum_declaration',
  'enum_item',
  'enum_specifier',
  'function',
  'function_declaration',
  'function_definition',
  'function_item',
  'interface',
  'interface_declaration',
  'impl_item',
  'method',
  'method_declaration',
  'method_definition',
  'mod_item',
  'module',
  'module_declaration',
  'namespace',
  'namespace_definition',
  'procedure',
  'record_declaration',
  'struct',
  'struct_item',
  'struct_specifier',
  'subroutine_definition',
  'trait_item',
  'type_alias_declaration',
  'type_declaration',
]);

function composeSectionLabel(filePath: string, symbolParts: string[]): string {
  return symbolParts.length > 0
    ? `${basename(filePath)} · ${symbolParts.join(' · ')}`
    : basename(filePath);
}

function readNodeLabel(
  node: Node | null | undefined,
  sourceBytes: Uint8Array
): string | null {
  if (!node) {
    return null;
  }

  const normalized = normalizeCodeContent(
    extractRangeText(sourceBytes, node.startIndex, node.endIndex)
  );
  if (!normalized) {
    return null;
  }

  const tokens = normalized.match(/[\p{L}\p{N}_$]+/gu) ?? [];
  if (tokens.length === 0) {
    return null;
  }

  return tokens[tokens.length - 1] ?? null;
}

function extractDirectSymbolName(
  node: Node,
  sourceBytes: Uint8Array
): string | null {
  if (!SYMBOL_NODE_TYPES.has(node.type)) {
    return null;
  }

  const fieldNames = [
    'name',
    'identifier',
    'declarator',
    'pattern',
    'property',
    'signature',
    'type',
    'value',
  ];

  for (const fieldName of fieldNames) {
    const fieldNode = node.childForFieldName(fieldName);
    const label = readNodeLabel(fieldNode, sourceBytes);
    if (label) {
      return label;
    }
  }

  return readNodeLabel(node, sourceBytes);
}

function extractSymbolName(node: Node, sourceBytes: Uint8Array): string | null {
  const direct = extractDirectSymbolName(node, sourceBytes);
  if (direct) {
    return direct;
  }

  const symbolChild = node.namedChildren.find(
    (child) => extractDirectSymbolName(child, sourceBytes) !== null
  );
  if (symbolChild) {
    return extractDirectSymbolName(symbolChild, sourceBytes);
  }

  if (node.namedChildren.length === 1) {
    const onlyChild = node.namedChildren[0];
    if (onlyChild) {
      return extractSymbolName(onlyChild, sourceBytes);
    }
  }

  return null;
}

function resolveLanguageId(filePath: string): string | null {
  const extension = extname(filePath).toLowerCase();
  if (!extension) {
    return null;
  }

  return LANGUAGE_BY_EXTENSION[extension] ?? extension.slice(1) ?? null;
}

function extractRangeText(
  sourceBytes: Uint8Array,
  startIndex: number,
  endIndex: number
): string {
  return Buffer.from(sourceBytes.subarray(startIndex, endIndex)).toString(
    'utf8'
  );
}

async function firstExistingPath(paths: string[]): Promise<string | null> {
  for (const candidate of paths) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }

  return null;
}

function getWasmFilename(languageId: string): string {
  return (
    WASM_FILENAME_BY_LANGUAGE[languageId] ?? `tree-sitter-${languageId}.wasm`
  );
}

function getRuntimeDirectory(): string | null {
  const entry = process.argv[1];
  if (!entry) {
    return null;
  }

  return dirname(resolve(entry));
}

async function resolveCoreWasmPath(): Promise<string | null> {
  const runtimeDir = getRuntimeDirectory();
  const candidates = [
    ...(runtimeDir
      ? [resolve(runtimeDir, 'tree-sitter', 'web-tree-sitter.wasm')]
      : []),
    resolve(process.cwd(), 'dist', 'tree-sitter', 'web-tree-sitter.wasm'),
    resolve(process.cwd(), 'tree-sitter', 'web-tree-sitter.wasm'),
    resolve(
      process.cwd(),
      'node_modules',
      'web-tree-sitter',
      'web-tree-sitter.wasm'
    ),
  ];

  return firstExistingPath(candidates);
}

async function resolveGrammarWasmPath(
  languageId: string
): Promise<string | null> {
  const runtimeDir = getRuntimeDirectory();
  const wasmFilename = getWasmFilename(languageId);
  const packageName = `tree-sitter-${languageId}`;
  const candidates = [
    ...(runtimeDir ? [resolve(runtimeDir, 'tree-sitter', wasmFilename)] : []),
    resolve(process.cwd(), 'dist', 'tree-sitter', wasmFilename),
    resolve(process.cwd(), 'tree-sitter', wasmFilename),
    resolve(
      process.cwd(),
      'node_modules',
      '@repomix',
      'tree-sitter-wasms',
      'out',
      wasmFilename
    ),
    resolve(process.cwd(), 'node_modules', packageName, wasmFilename),
  ];

  return firstExistingPath(candidates);
}

async function ensureParserRuntime(): Promise<void> {
  if (!parserInitPromise) {
    parserInitPromise = (async () => {
      const wasmPath = await resolveCoreWasmPath();
      if (!wasmPath) {
        throw new Error('未找到 web-tree-sitter.wasm');
      }

      await Parser.init({
        locateFile() {
          return wasmPath;
        },
      });
    })();
  }

  return parserInitPromise;
}

async function loadLanguage(languageId: string): Promise<Language | null> {
  const cached = languageCache.get(languageId);
  if (cached) {
    return cached;
  }

  const promise = (async () => {
    await ensureParserRuntime();
    const wasmPath = await resolveGrammarWasmPath(languageId);
    if (!wasmPath) {
      return null;
    }

    return Language.load(wasmPath);
  })();

  languageCache.set(languageId, promise);
  return promise;
}

function toChunk(value: string, section: string): ChunkedDocument | null {
  const content = normalizeCodeContent(value);
  if (!content) {
    return null;
  }

  return {
    section,
    content,
    tokenEstimate: estimateTokens(content),
    contentHash: sha256(content),
  };
}

function appendContentAsChunks(args: {
  chunks: ChunkedDocument[];
  content: string;
  section: string;
  chunkSize: number;
}): void {
  const normalized = normalizeCodeContent(args.content);
  if (!normalized) {
    return;
  }

  if (normalized.length <= args.chunkSize) {
    const chunk = toChunk(normalized, args.section);
    if (chunk) {
      args.chunks.push(chunk);
    }
    return;
  }

  args.chunks.push(
    ...splitSlidingCode({
      content: normalized,
      section: args.section,
      chunkSize: args.chunkSize,
    })
  );
}

function splitSlidingCode(args: {
  content: string;
  section: string;
  chunkSize: number;
}): ChunkedDocument[] {
  const content = normalizeCodeContent(args.content);
  if (!content) {
    return [];
  }

  if (content.length <= args.chunkSize) {
    const chunk = toChunk(content, args.section);
    return chunk ? [chunk] : [];
  }

  const chunks: ChunkedDocument[] = [];
  let cursor = 0;

  while (cursor < content.length) {
    const idealEnd = Math.min(content.length, cursor + args.chunkSize);
    let end = idealEnd;

    if (idealEnd < content.length) {
      const breakIndex = Math.max(
        content.lastIndexOf('\n', idealEnd),
        content.lastIndexOf(' ', idealEnd)
      );
      if (breakIndex > cursor + Math.floor(args.chunkSize * 0.6)) {
        end = breakIndex;
      }
    }

    const chunk = toChunk(content.slice(cursor, end), args.section);
    if (chunk) {
      chunks.push(chunk);
    }

    if (end >= content.length) {
      break;
    }

    cursor = Math.max(end, cursor + 1);
  }

  return chunks;
}

function materializeGroups(args: {
  node: Node;
  content: string;
  sourceBytes: Uint8Array;
  filePath: string;
  sectionParts: string[];
  section: string;
  chunkSize: number;
}): ChunkedDocument[] {
  const {
    node,
    content,
    sourceBytes,
    filePath,
    sectionParts,
    section,
    chunkSize,
  } = args;
  const children = node.namedChildren.filter(
    (child) => child.endIndex > child.startIndex
  );

  if (children.length === 0) {
    return splitSlidingCode({
      content: extractRangeText(sourceBytes, node.startIndex, node.endIndex),
      section,
      chunkSize,
    });
  }

  const groups: Array<{ start: number; end: number; children: Node[] }> = [];
  let current: { start: number; end: number; children: Node[] } | null = null;

  for (const child of children) {
    if (!current) {
      current = {
        start: child.startIndex,
        end: child.endIndex,
        children: [child],
      };
      continue;
    }

    const firstChild = current.children[0];
    if (!firstChild) {
      continue;
    }

    const candidateStart = firstChild.startIndex;
    const candidateEnd = child.endIndex;
    const candidateText = normalizeCodeContent(
      extractRangeText(sourceBytes, candidateStart, candidateEnd)
    );
    if (candidateText.length <= chunkSize) {
      current.end = candidateEnd;
      current.children.push(child);
      continue;
    }

    groups.push(current);
    current = {
      start: child.startIndex,
      end: child.endIndex,
      children: [child],
    };
  }

  if (current) {
    groups.push(current);
  }

  const chunks: ChunkedDocument[] = [];

  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    if (!group) {
      continue;
    }

    const previousGroup = index === 0 ? null : groups[index - 1];
    const nextGroup = index === groups.length - 1 ? null : groups[index + 1];
    const previousEnd = previousGroup ? previousGroup.end : node.startIndex;
    const nextStart = nextGroup ? nextGroup.start : node.endIndex;
    const expandedSource = extractRangeText(
      sourceBytes,
      previousEnd,
      nextStart
    );
    const firstChild = group.children[0];
    const groupSymbolName =
      group.children.length === 1 && firstChild
        ? extractSymbolName(firstChild, sourceBytes)
        : null;
    const groupSectionParts = groupSymbolName
      ? [...sectionParts, groupSymbolName]
      : sectionParts;
    const groupSection = composeSectionLabel(filePath, groupSectionParts);

    if (
      group.children.length === 1 &&
      firstChild &&
      group.end - group.start > chunkSize
    ) {
      chunks.push(
        ...splitNode({
          node: firstChild,
          content,
          sourceBytes,
          filePath,
          sectionParts,
          chunkSize,
        })
      );
      continue;
    }

    appendContentAsChunks({
      chunks,
      content: expandedSource,
      section: groupSection,
      chunkSize,
    });
  }

  return chunks;
}

function splitNode(args: {
  node: Node;
  content: string;
  sourceBytes: Uint8Array;
  filePath: string;
  sectionParts: string[];
  chunkSize: number;
}): ChunkedDocument[] {
  const content = extractRangeText(
    args.sourceBytes,
    args.node.startIndex,
    args.node.endIndex
  );
  const symbolName = extractSymbolName(args.node, args.sourceBytes);
  const sectionParts = symbolName
    ? [...args.sectionParts, symbolName]
    : args.sectionParts;
  const section = composeSectionLabel(args.filePath, sectionParts);
  if (normalizeCodeContent(content).length <= args.chunkSize) {
    const chunk = toChunk(content, section);
    return chunk ? [chunk] : [];
  }

  return materializeGroups({
    ...args,
    sectionParts,
    section,
  });
}

export async function chunkCodeWithTreeSitter(args: {
  filePath: string;
  content: string;
  config: AppConfig;
}): Promise<ChunkedDocument[] | null> {
  const languageId = resolveLanguageId(args.filePath);
  if (!languageId) {
    return null;
  }

  const language = await loadLanguage(languageId);
  if (!language) {
    return null;
  }

  const parser = new Parser();
  try {
    parser.setLanguage(language);
    const normalized = args.content.replace(/\r\n/g, '\n');
    const sourceBytes = Buffer.from(normalized, 'utf8');
    const tree = parser.parse(normalized);
    if (!tree) {
      return null;
    }

    return splitNode({
      node: tree.rootNode,
      content: normalized,
      sourceBytes,
      filePath: args.filePath,
      sectionParts: [],
      chunkSize: args.config.index.chunk_size,
    });
  } finally {
    parser.delete();
  }
}
