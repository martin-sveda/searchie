import type { ParsedSession, SourceId } from './model';
import { type ParseOptions, PARSER_VERSION as VSCODE_PARSER_VERSION, parseVsCodeFile } from './parser-vscode';

/** Parser registry: Phase 2 adds the Copilot CLI parser here without touching the indexer. */

export interface ParsableFile {
  path: string;
  source: SourceId;
  kind: 'jsonl' | 'json';
}

export interface SessionParser {
  readonly id: string;
  readonly version: number;
  supports(file: ParsableFile): boolean;
  parse(file: ParsableFile, opts: ParseOptions): Promise<ParsedSession | null>;
}

export const vscodeParser: SessionParser = {
  id: 'vscode',
  version: VSCODE_PARSER_VERSION,
  supports: (file) => file.source === 'vscode' || file.source === 'vscode-insiders',
  parse: (file, opts) => parseVsCodeFile(file, opts),
};

const registry: SessionParser[] = [vscodeParser];

export function parserFor(file: ParsableFile): SessionParser | undefined {
  return registry.find((p) => p.supports(file));
}

/** Highest parser version, stored in `meta.parserVersion` (R4.7, R5.17). */
export function combinedParserVersion(): number {
  return registry.reduce((m, p) => Math.max(m, p.version), 0);
}

export type { ParseOptions };
