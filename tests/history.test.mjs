import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeChatGPT, loadExporter, makeConversation, waitFor, waitForResult } from './helpers/harness.mjs';

// 测试页面没有 _account Cookie，记录落在 default 账户下。
const HISTORY_KEY = 'chatgpt-exporter-history-v1:default';

function exportAll(env, { incremental = true } = {}) {
    env.window.ChatGPTExporter.showDialog();
    if (incremental) env.click('#incremental-export');
    env.click('#export-all-btn');
}

const historyText = env => env.$('#gre-history-text').textContent;

test('打开增量导出后显示导出记录，可以清除当前账户的记录', async () => {
    const api = new FakeChatGPT()
        .addConversation(makeConversation('a', { updateTime: 1700000100 }))
        .addConversation(makeConversation('b', { updateTime: 1700000200 }));
    const env = loadExporter({ api });
    env.window.localStorage.setItem('chatgpt-exporter-history-v1:other', JSON.stringify({ items: { x: 1 }, lastExportAt: 1 }));

    env.window.ChatGPTExporter.showDialog();
    assert.equal(env.$('#gre-history-row').hidden, true, '未开启增量导出时不显示记录');
    env.click('#incremental-export');
    assert.equal(env.$('#gre-history-row').hidden, false);
    assert.equal(historyText(env), '还没有导出记录，这次会导出全部对话');
    assert.equal(env.$('#clear-history-btn').hidden, true);
    env.click('#export-all-btn');
    await waitForResult(env);

    exportAll(env, { incremental: false });
    await waitForResult(env, 2);
    env.window.ChatGPTExporter.showDialog();
    env.click('#incremental-export');
    assert.match(historyText(env), /^已记录 2 个对话 · 上次导出 \d{1,2}\/\d{1,2} \d{2}:\d{2}$/);
    assert.equal(env.$('#clear-history-btn').hidden, false);

    env.click('#clear-history-btn');
    assert.equal(env.confirms.length, 1);
    assert.equal(historyText(env), '还没有导出记录，这次会导出全部对话');
    assert.equal(env.window.localStorage.getItem(HISTORY_KEY), null);
    assert.ok(env.window.localStorage.getItem('chatgpt-exporter-history-v1:other'), '其他账户的记录不受影响');
    env.close();
});

test('选择器标出未导出和有更新的对话，并可以按导出状态筛选', async () => {
    const a = makeConversation('a', { updateTime: 1700000300 });
    const b = makeConversation('b', { updateTime: 1700000200 });
    const api = new FakeChatGPT().addConversation(a).addConversation(b);
    const env = loadExporter({ api });

    env.window.ChatGPTExporter.showDialog();
    env.click('#open-picker-btn');
    await waitFor(() => env.$$('#conv-list .gre-item').length === 2, { message: '对话列表加载' });
    assert.equal(env.$('#filter-export-status'), null, '没有导出记录时不显示导出状态筛选');
    assert.equal(env.$$('#conv-list .gre-item-meta').length, 0);
    env.window.confirm = () => true;
    env.document.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    exportAll(env, { incremental: false });
    await waitForResult(env);
    b.update_time = 1700000900;
    api.addConversation(makeConversation('c', { updateTime: 1700000500 }));

    env.window.ChatGPTExporter.showDialog();
    env.click('#open-picker-btn');
    await waitFor(() => env.$$('#conv-list .gre-item').length === 3, { message: '对话列表加载' });
    const rows = () => env.$$('#conv-list .gre-item').map(row => [
        row.querySelector('.gre-item-title').textContent,
        row.querySelector('.gre-item-meta')?.textContent || ''
    ]);
    assert.deepEqual(rows(), [['Title b', '有更新'], ['Title c', '未导出'], ['Title a', '']]);

    env.click('#filter-export-status');
    env.click('#export-dialog .gre-menu [data-value="changed"]');
    assert.deepEqual(rows().map(([title]) => title), ['Title b', 'Title c']);
    env.click('#filter-export-status');
    env.click('#export-dialog .gre-menu [data-value="exported"]');
    assert.deepEqual(rows().map(([title]) => title), ['Title a']);
    env.close();
});

test('兼容旧版本保存的导出记录', async () => {
    const api = new FakeChatGPT()
        .addConversation(makeConversation('a', { updateTime: 1700000100 }))
        .addConversation(makeConversation('b', { updateTime: 1700000200 }));
    const env = loadExporter({ api });
    env.window.localStorage.setItem(HISTORY_KEY, JSON.stringify({ a: 1700000100 }));

    env.window.ChatGPTExporter.showDialog();
    env.click('#incremental-export');
    assert.equal(historyText(env), '已记录 1 个对话');
    env.click('#export-all-btn');
    const zip = await env.readZip();
    assert.deepEqual(zip.files.filter(name => name.endsWith('.json')).map(name => /Title (\w)/.exec(name)[1]), ['b']);
    await waitForResult(env);

    const saved = JSON.parse(env.window.localStorage.getItem(HISTORY_KEY));
    assert.deepEqual(Object.keys(saved.items).sort(), ['a', 'b']);
    assert.equal(typeof saved.lastExportAt, 'number');
    env.close();
});
