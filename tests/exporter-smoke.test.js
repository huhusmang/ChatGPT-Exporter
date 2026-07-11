import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('the two runtime entrypoints expose the same incremental export primitives', () => {
    const userscript = read('Tampermonkey.js');
    const extension = read('chrome-extension/exporter.user.js');
    for (const marker of [
        "const EXPORTER_VERSION = '1.5.0'",
        'showDirectoryPicker',
        'manifest.json',
        'failed-conversations.json',
        'fetchWithRetry',
        'exportConversationsDirectory'
    ]) {
        assert.match(userscript, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `Tampermonkey missing ${marker}`);
        assert.match(extension, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `extension missing ${marker}`);
    }
});

test('extension version surfaces stay aligned', () => {
    const manifest = JSON.parse(read('chrome-extension/manifest.json'));
    assert.equal(manifest.version, '1.5.0');
    assert.match(read('chrome-extension/content/auto-export.js'), /EXPECTED_VERSION = '1\.5\.0'/);
    assert.match(read('chrome-extension/content/inject-exporter.js'), /EXPECTED_VERSION = '1\.5\.0'/);
    assert.match(read('chrome-extension/pages/popup.js'), /EXPECTED_EXPORTER_VERSION = '1\.5\.0'/);
});

test('directory writer rejects no explicit path traversal in generated paths', () => {
    const source = read('chrome-extension/exporter.user.js');
    assert.match(source, /path\.split\('\/'\)/);
    assert.match(source, /exportDirectoryName/);
    assert.doesNotMatch(source, /\.\.\/attachments/);
});
