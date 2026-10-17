import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeChatGPT, loadExporter, makeConversation, waitFor, waitForResult } from './helpers/harness.mjs';

function sampleApi(count = 5) {
    const api = new FakeChatGPT();
    for (let i = 0; i < count; i++) api.addConversation(makeConversation(`c${i}`, { updateTime: 1700000000 + (count - i) * 10 }));
    return api;
}

async function openPicker(env) {
    env.window.ChatGPTExporter.showDialog();
    env.click('#select-personal-picker-btn');
    await waitFor(() => env.$$('#conv-list .gre-item').length > 0, { message: '对话列表加载' });
}

function clickRow(env, index, init = {}) {
    const row = env.$$('#conv-list .gre-item')[index];
    row.dispatchEvent(new env.window.MouseEvent('click', { bubbles: true, ...init }));
}

const key = (env, name) => env.document.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: name, bubbles: true }));

test('按 Esc 关闭导出弹窗', () => {
    const env = loadExporter();
    env.window.ChatGPTExporter.showDialog();
    assert.ok(env.$('#export-dialog-overlay'));
    key(env, 'Escape');
    assert.equal(env.$('#export-dialog-overlay'), null);
    env.close();
});

test('选择器支持 Shift 连选，全选按钮显示筛选数量', async () => {
    const env = loadExporter({ api: sampleApi(5) });
    await openPicker(env);
    assert.equal(env.$('#select-all-btn').textContent, '全选筛选结果 (5)');
    clickRow(env, 1);
    clickRow(env, 3, { shiftKey: true });
    assert.equal(env.$('#export-selected-btn').textContent, '导出选中 (3)');
    assert.deepEqual(env.$$('#conv-list .gre-item').map(row => row.querySelector('input').checked), [false, true, true, true, false]);

    env.$('#conv-search').value = 'c4';
    env.$('#conv-search').dispatchEvent(new env.window.Event('input'));
    assert.equal(env.$('#select-all-btn').textContent, '全选筛选结果 (1)');
    env.close();
});

test('已选对话时点击遮罩或按 Esc 需要确认，取消确认则保留选择', async () => {
    const env = loadExporter({ api: sampleApi(2) });
    await openPicker(env);
    clickRow(env, 0);
    env.window.confirm = () => false;
    const overlay = env.$('#export-dialog-overlay');
    overlay.dispatchEvent(new env.window.MouseEvent('mousedown', { bubbles: true }));
    overlay.dispatchEvent(new env.window.MouseEvent('click', { bubbles: true }));
    key(env, 'Escape');
    assert.ok(env.$('#export-dialog-overlay'), '取消确认后弹窗应保留');
    assert.equal(env.$('#export-selected-btn').textContent, '导出选中 (1)');
    env.window.confirm = () => true;
    key(env, 'Escape');
    assert.equal(env.$('#export-dialog-overlay'), null);
    env.close();
});

test('导出期间显示进度面板，可以从面板停止导出', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const api = sampleApi(3).route(/\/conversation\/c1$/, async () => { await gate; });
    const env = loadExporter({ api });
    env.window.ChatGPTExporter.showDialog();
    env.click('#select-personal-btn');
    await waitFor(() => api.detailRequests().includes('c1'), { message: '开始请求 c1' });
    const panel = env.$('#gre-task-panel');
    assert.equal(panel.dataset.state, 'progress');
    assert.match(panel.querySelector('.gre-task-body').textContent, /\(2\/3\)/);
    env.click('#gre-task-panel .gre-task-stop');
    assert.equal(env.confirms.length, 0, '面板上的停止按钮不需要二次确认');
    release();
    const result = await waitForResult(env);
    assert.equal(result.tone, 'warn');
    assert.equal(result.title, '导出已停止');
    assert.equal(env.downloads.length, 1);
    env.close();
});

test('导出完成后在面板显示结果，不再弹出 alert', async () => {
    const env = loadExporter({ api: sampleApi(2) });
    env.window.ChatGPTExporter.showDialog();
    env.click('#select-personal-btn');
    const result = await waitForResult(env);
    assert.equal(result.tone, 'ok');
    assert.match(result.message, /共导出 2 个对话/);
    assert.deepEqual(env.alerts, []);
    env.click('#gre-task-panel .gre-task-close');
    assert.equal(env.$('#gre-task-panel'), null);
    env.close();
});

test('Markdown 带 YAML front matter', async () => {
    const conversation = makeConversation('fm', { updateTime: 1700000000 });
    conversation.title = 'He said "hi"';
    const env = loadExporter({ api: new FakeChatGPT().addConversation(conversation) });
    env.window.ChatGPTExporter.showDialog();
    env.click('#select-personal-btn');
    const zip = await env.readZip();
    const markdown = await zip.text(zip.find(/\.md$/));
    const [, frontMatter] = markdown.split('---\n');
    assert.match(frontMatter, /^title: "He said \\"hi\\""$/m);
    assert.match(frontMatter, /^created: "2023-11-14T22:13:20\.000Z"$/m);
    assert.match(frontMatter, new RegExp(`^url: "https://chatgpt\\.com/c/${conversation.conversation_id}"$`, 'm'));
    assert.match(markdown, /---\n\n# User\n/);
    env.close();
});
