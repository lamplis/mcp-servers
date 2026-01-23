export interface Chunk {
  readonly content: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly tokenCount?: number;
}

const CODE_MAX_CHARS = 1400;
const CODE_MIN_CHARS = 700;
const CODE_OVERLAP_LINES = 3;
const DOC_MAX_CHARS = 1200;
const DOC_OVERLAP = 150;

export function chunkCode(text: string): readonly Chunk[] {
  if (!text.trim()) {
    return [];
  }

  const lines = text.split(/\r?\n/);
  const ranges: Array<{ start: number; end: number }> = [];
  let start = 0;

  while (start < lines.length) {
    let end = start;
    let acc = '';
    let hasContent = false;

    for (let i = start; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) {
        continue; // Should never happen, but satisfies TypeScript
      }

      const candidate = hasContent ? `${acc}\n${line}` : line;

      // Check if adding this line would exceed the limit
      if (candidate.length > CODE_MAX_CHARS && hasContent) {
        break;
      }

      // Add the line to accumulator
      acc = candidate;
      end = i + 1;

      // Track if we have any non-empty content
      if (line.trim()) {
        hasContent = true;
      }

      // Check if we should break at a natural boundary
      if (
        hasContent &&
        acc.length >= CODE_MIN_CHARS &&
        (line.trim() === '' || /\}\s*$/.test(line))
      ) {
        break;
      }
    }

    // Handle case where we couldn't fit any content
    if (!hasContent && start < lines.length) {
      // Take at least one line, even if it's too long
      acc = lines[start] ?? '';
      end = start + 1;
      hasContent = true;
    }

    // Add chunk if we have content
    if (hasContent && acc.trim()) {
      ranges.push({ start, end });
    }

    // Ensure we always make progress
    start = Math.max(start + 1, end);
  }

  return ranges.map((range, index) => {
    const overlapStart =
      index === 0 ? range.start : Math.max(0, range.start - CODE_OVERLAP_LINES);
    const content = lines.slice(overlapStart, range.end).join('\n');
    return {
      content,
      startLine: overlapStart + 1,
      endLine: range.end,
      tokenCount: approxTokens(content),
    };
  });
}

export function chunkDoc(text: string): readonly Chunk[] {
  if (!text.trim()) {
    return [];
  }

  const chunks: Chunk[] = [];
  let i = 0;

  while (i < text.length) {
    const end = Math.min(text.length, i + DOC_MAX_CHARS);
    const slice = text.slice(i, end);

    chunks.push({
      content: slice,
      tokenCount: approxTokens(slice),
    });

    if (end === text.length) {
      break;
    }
    i = Math.max(i + 1, end - DOC_OVERLAP); // Ensure progress
  }

  return chunks;
}

export function chunkPdf(text: string): readonly Chunk[] {
  if (!text.trim()) {
    return [];
  }

  // Clean up PDF text: normalize whitespace, remove excessive line breaks
  const cleanedText = text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();

  return chunkDoc(cleanedText);
}

export function addChunkHeader(chunks: readonly Chunk[], header: string): readonly Chunk[] {
  const trimmedHeader = header.trim();
  if (!trimmedHeader) {
    return chunks;
  }

  const prefix = `${trimmedHeader}\n\n`;
  return chunks.map((chunk) => {
    const content = `${prefix}${chunk.content}`;
    return {
      ...chunk,
      content,
      tokenCount: approxTokens(content),
    };
  });
}

function approxTokens(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.round(words * 1.05 + 5);
}
