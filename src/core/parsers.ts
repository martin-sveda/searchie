import type { ParsedSession, SourceId } from './model';
import { CLI_PARSER_VERSION, parseCliFile } from './parser-cli';
import { type ParseOptions, PARSER_VERSION as VSCODE_PARSER_VERSION, parseVsCodeFile } from './parser-vscode';

/** Parser registry: one parser per source family; the indexer picks by `supports`. */

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

export const cliParser: SessionParser = {
  id: 'copilot-cli',
  version: CLI_PARSER_VERSION,
  supports: (file) => file.source === 'copilot-cli',
  parse: (file, opts) => parseCliFile(file, opts),
};

const registry: SessionParser[] = [vscodeParser, cliParser];

export function parserFor(file: ParsableFile): SessionParser | undefined {
  return registry.find((p) => p.supports(file));
}

/** Highest parser version, stored in `meta.parserVersion` (R4.7, R5.17). */
/** Stored in `meta.parserVersion`; a bump of any parser's version changes it and triggers a rebuild (R4.7, R4.16, R5.17). */
export function parserSignature(): string {
  return registry.map((p) => `${p.id}@${p.version}`).join(',');
}

export type { ParseOptions };
