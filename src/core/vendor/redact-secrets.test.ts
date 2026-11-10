import { describe, expect, it } from 'vitest';
import { redactSecrets } from './redact-secrets';

describe('redactSecrets (vendored)', () => {
  it('masks recognisable tokens and assignments', () => {
    const gh = `ghp_${'a'.repeat(36)}`;
    const out = redactSecrets(`token ${gh} and password = "hunter2hunter2" and postgres://user:pw@host/db`);
    expect(out).not.toContain(gh);
    expect(out).toContain('[REDACTED:github-token]');
    expect(out).not.toContain('hunter2hunter2');
    expect(out).toContain('postgres://[REDACTED]@host/db');
  });

  it('keeps ordinary text', () => {
    expect(redactSecrets('refactor parseJsonLine')).toBe('refactor parseJsonLine');
    expect(redactSecrets('')).toBe('');
  });
});
