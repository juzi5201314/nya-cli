import { basename, extname } from 'node:path';

import type { AppConfig } from '../../types/config';
import { sha256 } from '../../utils/hash';
import { estimateTokens, normalizeWhitespace } from '../../utils/text';

export type ChunkedDocument = {
  section: string;
  content: string;
  tokenEstimate: number;
  contentHash: string;
};

function isMarkdownFile(filePath: string): boolean {
  return ['.md', '.mdx', '.markdown'].includes(extname(filePath).toLowerCase());
}

function splitMarkdownSections(
  filePath: string,
  content: string
): Array<{
  section: string;
  content: string;
}> {
  const lines = content.split('\n');
  const sections: Array<{ section: string; content: string }> = [];
  let currentTitle = basename(filePath);
  let buffer: string[] = [];

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const text = normalizeWhitespace(buffer.join('\n'));
      if (text) {
        sections.push({
          section: currentTitle,
          content: text,
        });
      }
      currentTitle = (heading[2] ?? basename(filePath)).trim();
      buffer = [];
      continue;
    }
    buffer.push(line);
  }

  const tail = normalizeWhitespace(buffer.join('\n'));
  if (tail) {
    sections.push({
      section: currentTitle,
      content: tail,
    });
  }

  return sections.length > 0
    ? sections
    : [
        {
          section: basename(filePath),
          content: normalizeWhitespace(content),
        },
      ];
}

function splitSlidingWindows(args: {
  section: string;
  content: string;
  chunkSize: number;
  chunkOverlap: number;
}): ChunkedDocument[] {
  const { section, chunkSize, chunkOverlap } = args;
  const content = normalizeWhitespace(args.content);
  if (!content) {
    return [];
  }

  if (content.length <= chunkSize) {
    return [
      {
        section,
        content,
        tokenEstimate: estimateTokens(content),
        contentHash: sha256(content),
      },
    ];
  }

  const chunks: ChunkedDocument[] = [];
  let cursor = 0;

  while (cursor < content.length) {
    const idealEnd = Math.min(content.length, cursor + chunkSize);
    let end = idealEnd;

    if (idealEnd < content.length) {
      const breakIndex = Math.max(
        content.lastIndexOf('\n', idealEnd),
        content.lastIndexOf(' ', idealEnd)
      );
      if (breakIndex > cursor + Math.floor(chunkSize * 0.6)) {
        end = breakIndex;
      }
    }

    const value = normalizeWhitespace(content.slice(cursor, end));
    if (value) {
      chunks.push({
        section,
        content: value,
        tokenEstimate: estimateTokens(value),
        contentHash: sha256(value),
      });
    }

    if (end >= content.length) {
      break;
    }

    cursor = Math.max(end - chunkOverlap, cursor + 1);
  }

  return chunks;
}

export function chunkTextDocument(args: {
  filePath: string;
  content: string;
  config: AppConfig;
}): ChunkedDocument[] {
  const sections = isMarkdownFile(args.filePath)
    ? splitMarkdownSections(args.filePath, args.content)
    : [
        {
          section: basename(args.filePath),
          content: normalizeWhitespace(args.content),
        },
      ];

  return sections.flatMap((section) =>
    splitSlidingWindows({
      section: section.section,
      content: section.content,
      chunkSize: args.config.index.chunk_size,
      chunkOverlap: args.config.index.chunk_overlap,
    })
  );
}
