#!/usr/bin/env node
// 根据 Tampermonkey.js 生成 Chrome 扩展使用的 chrome-extension/exporter.user.js。
// 用法：node scripts/build.mjs          重新生成
//       node scripts/build.mjs --check  只检查生成文件是否最新（CI 使用）
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCE_PATH = path.join(ROOT, 'Tampermonkey.js');
export const TARGET_PATH = path.join(ROOT, 'chrome-extension', 'exporter.user.js');

const BANNER = '// 此文件由 scripts/build.mjs 根据 Tampermonkey.js 生成，请勿直接修改。\n\n';
const HEADER_END = '// ==/UserScript==';
const USERSCRIPT_ONLY = /^[ \t]*\/\/ @build:userscript-only-start\n[\s\S]*?^[ \t]*\/\/ @build:userscript-only-end\n/gm;

export function buildExtensionScript(source) {
    const headerEnd = source.indexOf(HEADER_END);
    if (headerEnd === -1) throw new Error(`Tampermonkey.js 中找不到 "${HEADER_END}"`);
    const body = source
        .slice(source.indexOf('\n', headerEnd) + 1)
        .replace(/^\s*\n/, '')
        .replace(USERSCRIPT_ONLY, '');
    if (body.includes('@build:')) {
        throw new Error('Tampermonkey.js 中的 @build 标记未成对出现');
    }
    return BANNER + body;
}

function main() {
    const expected = buildExtensionScript(readFileSync(SOURCE_PATH, 'utf8'));
    const relativeTarget = path.relative(ROOT, TARGET_PATH);
    if (process.argv.includes('--check')) {
        let actual = '';
        try { actual = readFileSync(TARGET_PATH, 'utf8'); } catch (_) {}
        if (actual !== expected) {
            console.error(`${relativeTarget} 与 Tampermonkey.js 不同步，请运行 npm run build。`);
            process.exit(1);
        }
        console.log(`${relativeTarget} 已是最新。`);
        return;
    }
    writeFileSync(TARGET_PATH, expected);
    console.log(`已生成 ${relativeTarget}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
