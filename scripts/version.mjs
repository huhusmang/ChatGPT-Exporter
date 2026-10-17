#!/usr/bin/env node
// 版本号的唯一入口。
// 用法：node scripts/version.mjs check [--tag v1.6.0]  检查各处版本号一致（可附带校验发布标签）
//       node scripts/version.mjs set 1.6.0             同步修改所有版本号并重新生成扩展脚本
//       node scripts/version.mjs notes 1.6.0           输出 CHANGELOG.md 中该版本的说明
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildExtensionScript, ROOT, SOURCE_PATH, TARGET_PATH } from './build.mjs';

const MANIFEST_PATH = path.join(ROOT, 'chrome-extension', 'manifest.json');
const CHANGELOG_PATH = path.join(ROOT, 'CHANGELOG.md');
const HEADER_VERSION = /^(\/\/ @version\s+)(\S+)$/m;
const CONSTANT_VERSION = /^(\s*const EXPORTER_VERSION = ')([^']+)(';)$/m;
const SEMVER = /^\d+\.\d+\.\d+$/;

function readVersions() {
    const source = readFileSync(SOURCE_PATH, 'utf8');
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    return {
        'chrome-extension/manifest.json': manifest.version,
        'Tampermonkey.js @version': source.match(HEADER_VERSION)?.[2],
        'Tampermonkey.js EXPORTER_VERSION': source.match(CONSTANT_VERSION)?.[2]
    };
}

function changelogSection(version) {
    const changelog = readFileSync(CHANGELOG_PATH, 'utf8');
    const heading = new RegExp(`^## \\[?v?${version.replace(/\./g, '\\.')}\\]?.*$`, 'm');
    const match = heading.exec(changelog);
    if (!match) return null;
    const rest = changelog.slice(match.index + match[0].length);
    const next = rest.search(/^## /m);
    return (next === -1 ? rest : rest.slice(0, next)).trim();
}

function check(tag) {
    const versions = readVersions();
    const values = new Set(Object.values(versions));
    const problems = [];
    if (values.size !== 1 || values.has(undefined)) {
        problems.push('版本号不一致：\n' + Object.entries(versions).map(([k, v]) => `  ${k}: ${v}`).join('\n'));
    }
    const [version] = values;
    if (tag && tag.replace(/^v/, '') !== version) {
        problems.push(`发布标签 ${tag} 与代码中的版本号 ${version} 不一致`);
    }
    if (tag && !changelogSection(version)) {
        problems.push(`CHANGELOG.md 中缺少 ${version} 的说明`);
    }
    if (problems.length) {
        console.error(problems.join('\n'));
        process.exit(1);
    }
    console.log(`版本号一致：${version}`);
}

function set(version) {
    if (!SEMVER.test(version || '')) {
        console.error('请提供形如 1.6.0 的版本号');
        process.exit(1);
    }
    const manifestText = readFileSync(MANIFEST_PATH, 'utf8');
    writeFileSync(MANIFEST_PATH, manifestText.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`));
    const source = readFileSync(SOURCE_PATH, 'utf8')
        .replace(HEADER_VERSION, `$1${version}`)
        .replace(CONSTANT_VERSION, `$1${version}$3`);
    writeFileSync(SOURCE_PATH, source);
    writeFileSync(TARGET_PATH, buildExtensionScript(source));
    check();
    if (!changelogSection(version)) {
        console.warn(`提醒：CHANGELOG.md 中还没有 ${version} 的说明。`);
    }
}

const [command, arg, ...rest] = process.argv.slice(2);
if (command === 'check') {
    const tagIndex = [arg, ...rest].indexOf('--tag');
    check(tagIndex === -1 ? null : [arg, ...rest][tagIndex + 1]);
} else if (command === 'set') {
    set(arg);
} else if (command === 'notes') {
    const notes = changelogSection(String(arg || '').replace(/^v/, ''));
    if (!notes) {
        console.error(`CHANGELOG.md 中找不到 ${arg} 的说明`);
        process.exit(1);
    }
    console.log(notes);
} else {
    console.error('用法：node scripts/version.mjs <check [--tag vX.Y.Z] | set X.Y.Z | notes X.Y.Z>');
    process.exit(1);
}
