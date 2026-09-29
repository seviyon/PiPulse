import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Committed test certificates (see fixtures/make-fixtures.sh). Test-only keys. */
export const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
export const fixturePath = (name: string): string => join(FIXTURES, name);
export const fixture = (name: string): string => readFileSync(fixturePath(name), 'utf8');
export const tempDir = (): string => mkdtempSync(join(tmpdir(), 'pipulse-tls-'));
