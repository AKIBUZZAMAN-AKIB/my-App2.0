import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// Runtime-test the JavaScript staging helper; it intentionally has no TypeScript declaration surface.
// @ts-expect-error JavaScript implementation module
import { contentRevision } from '../scripts/prepare-web.mjs';

const temporary: string[] = [];
afterEach(() => {
  while (temporary.length) rmSync(temporary.pop()!, { recursive: true, force: true });
});

describe('separately hosted web target', () => {
  it('changes the service-worker cache revision when file content changes', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'nativekit-web-test-'));
    temporary.push(directory);
    const file = path.join(directory, 'index.html');
    writeFileSync(file, '<h1>version one</h1>');
    const first = await contentRevision(directory, ['index.html']);
    writeFileSync(file, '<h1>version two</h1>');
    const second = await contentRevision(directory, ['index.html']);
    expect(second).not.toBe(first);
  });
});
