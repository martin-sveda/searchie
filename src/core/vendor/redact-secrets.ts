/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See THIRD_PARTY_NOTICES.md in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Adapted from Searchie prototype: src/core/redact-secrets.ts
// Changes for Searchie: none (verbatim copy); used for snippets and preview (R6.11, R10.4).

/**
 * Best-effort masking of credential-shaped substrings before local analytics data
 * is shared with a language model. The patterns intentionally target recognisable
 * token formats and explicit credential assignments rather than ordinary code.
 */

const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----|$)/g;
const GITHUB_TOKEN = /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,255}\b/g;
const AWS_ACCESS_KEY_ID = /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g;
const SLACK_TOKEN = /\b(?:xox[baprs]-|xapp-[0-9]-)[A-Za-z0-9-]{10,250}\b/g;
const GOOGLE_API_KEY = /\bAIza[0-9A-Za-z_-]{35}\b/g;
const NPM_TOKEN = /\bnpm_[A-Za-z0-9]{36}\b/g;
const GITLAB_PAT = /\bglpat-[A-Za-z0-9_-]{20,80}\b/g;
const CONTEXT7_KEY = /\bctx7sk-[A-Za-z0-9_-]{10,250}\b/g;
const GENERIC_API_KEY = /\bsk-[A-Za-z0-9_-]{20,250}\b/g;
const CONNECTION_STRING_CREDS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const AUTH_HEADER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,512}/gi;
const SECRET_KEY_NAME = String.raw`(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?key|secret|token|password|passwd|credentials?)`;
const QUOTED_SECRET_ASSIGNMENT = new RegExp(
  String.raw`\b(${SECRET_KEY_NAME})(["']{0,2}\s*[:=]\s*)(["']{1,2})((?:(?!\3).){4,512})\3`, 'gi');
const SECRET_ASSIGNMENT = new RegExp(
  String.raw`\b(${SECRET_KEY_NAME})(["']{0,2}\s*[:=]\s*)(["']{0,2})[^\s"'\`;,]{8,512}\3`, 'gi');

/** Mask likely credentials while preserving surrounding content for useful analysis. */
export function redactSecrets(text: string): string {
  if (!text) return text;
  return text
    .replaceAll(PRIVATE_KEY_BLOCK, '[REDACTED:private-key]')
    .replaceAll(GITHUB_TOKEN, '[REDACTED:github-token]')
    .replaceAll(AWS_ACCESS_KEY_ID, '[REDACTED:aws-key-id]')
    .replaceAll(SLACK_TOKEN, '[REDACTED:slack-token]')
    .replaceAll(GOOGLE_API_KEY, '[REDACTED:google-api-key]')
    .replaceAll(NPM_TOKEN, '[REDACTED:npm-token]')
    .replaceAll(GITLAB_PAT, '[REDACTED:gitlab-token]')
    .replaceAll(CONTEXT7_KEY, '[REDACTED:api-key]')
    .replaceAll(GENERIC_API_KEY, '[REDACTED:api-key]')
    .replaceAll(JWT, '[REDACTED:jwt]')
    .replaceAll(CONNECTION_STRING_CREDS, '$1[REDACTED]@')
    .replaceAll(AUTH_HEADER, '$1 [REDACTED]')
    .replaceAll(QUOTED_SECRET_ASSIGNMENT, '$1$2$3[REDACTED]$3')
    .replaceAll(SECRET_ASSIGNMENT, '$1$2$3[REDACTED]$3');
}
