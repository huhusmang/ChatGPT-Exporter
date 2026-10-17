import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeChatGPT, loadExporter, makeConversation, waitFor, waitForResult } from './helpers/harness.mjs';

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
});

function startFullExport(env, { incremental = false } = {}) {
    env.window.ChatGPTExporter.showDialog();
    if (incremental) env.click('#incremental-export');
    env.click('#select-personal-btn');
}

test('401 时刷新一次 Token 后重试', async () => {
    const api = new FakeChatGPT().addConversation(makeConversation('a'));
    let rejected = false;
    api.route(/\/conversation\/a$/, request => {
        if (!rejected) {
            rejected = true;
            api.accessToken = 'token-2';
            return json({ detail: 'expired' }, 401);
        }
        assert.equal(request.headers.Authorization, 'Bearer token-2');
    });
    const env = loadExporter({ api });
    startFullExport(env);
    const result = await env.readZip();
    assert.ok(result.find(/Title a.*\.json$/));
    assert.ok(!result.find(/export-error-report/));
    env.close();
});

test('429 时按 Retry-After 退避重试', async () => {
    const api = new FakeChatGPT().addConversation(makeConversation('a'));
    let attempts = 0;
    api.route(/\/conversation\/a$/, () => {
        attempts++;
        if (attempts <= 2) return json({ detail: 'slow down' }, 429, { 'retry-after': '0' });
    });
    const env = loadExporter({ api });
    startFullExport(env);
    const result = await env.readZip();
    assert.equal(attempts, 3);
    assert.ok(result.find(/Title a.*\.json$/));
    env.close();
});

test('持续限流时停止批量导出，并打包已完成的对话', async () => {
    const api = new FakeChatGPT()
        .addConversation(makeConversation('first', { updateTime: 1700000300 }))
        .addConversation(makeConversation('limited', { updateTime: 1700000200 }))
        .addConversation(makeConversation('never', { updateTime: 1700000100 }))
        .route(/\/conversation\/limited$/, () => json({}, 429, { 'retry-after': '0' }));
    const env = loadExporter({ api });
    startFullExport(env);
    const result = await env.readZip();
    assert.ok(result.find(/Title first.*\.json$/));
    assert.ok(!result.find(/Title never/));
    assert.ok(!api.detailRequests().includes('never'), '限流后不应继续请求后面的对话');
    const report = await result.json('export-error-report.json');
    assert.match(report.stopped_reason, /429/);
    env.close();
});

test('个人空间全量导出包含项目对话，所有请求使用同一个账户头', async () => {
    const api = new FakeChatGPT()
        .addProject('g-p-1', 'My Project')
        .addConversation(makeConversation('root'))
        .addConversation(makeConversation('inproj'), { projectId: 'g-p-1' })
        .addConversation(makeConversation('old'), { archived: true });
    const env = loadExporter({ api });
    env.document.cookie = '_account=acct-123';
    startFullExport(env);
    const result = await env.readZip();
    assert.ok(result.find(/^Title root.*\.json$/));
    assert.ok(result.find(/^Title old.*\.json$/), '应包含已归档对话');
    assert.ok(result.find(/^My Project\/Title inproj.*\.json$/), '项目对话应放在项目文件夹中');
    const backend = api.requests.filter(r => r.path.startsWith('/backend-api/'));
    assert.ok(backend.length > 0);
    assert.deepEqual([...new Set(backend.map(r => r.headers['ChatGPT-Account-Id']))], ['acct-123']);
    env.close();
});

test('分页数量小于请求数量时仍能读完全部对话', async () => {
    const api = new FakeChatGPT();
    for (let i = 0; i < 65; i++) api.addConversation(makeConversation(`c${i}`, { nodes: 1, updateTime: 1700000000 + i }));
    api.route(/^\/backend-api\/conversations\?/, (request, url) => {
        const archived = url.searchParams.get('is_archived') === 'true';
        const offset = Number(url.searchParams.get('offset') || 0);
        const all = api.listItems(entry => entry.archived === archived && !entry.projectId);
        return json({ items: all.slice(offset, offset + 28), offset });
    });
    const env = loadExporter({ api });
    startFullExport(env);
    const result = await env.readZip();
    assert.equal(result.files.filter(name => name.endsWith('.json')).length, 65);
    env.close();
});

test('增量导出只导出新增或更新过的对话', async () => {
    const a = makeConversation('a', { updateTime: 1700000100 });
    const b = makeConversation('b', { updateTime: 1700000200 });
    const api = new FakeChatGPT().addConversation(a).addConversation(b);
    const env = loadExporter({ api });

    startFullExport(env, { incremental: true });
    const first = await env.readZip(0);
    assert.equal(first.files.filter(name => name.endsWith('.json')).length, 2);
    await waitForResult(env, 1);

    b.update_time = 1700000900;
    api.addConversation(makeConversation('c', { updateTime: 1700000500 }));
    startFullExport(env, { incremental: true });
    const second = await env.readZip(1);
    const names = second.files.filter(name => name.endsWith('.json'));
    assert.equal(names.length, 2);
    assert.ok(second.find(/Title b/));
    assert.ok(second.find(/Title c/));
    assert.match(env.downloadNames[0], /^chatgpt_personal_incremental_\d{4}-\d{2}-\d{2}\.zip$/);
    assert.match((await waitForResult(env, 2)).message, /跳过了 1 个/);

    startFullExport(env, { incremental: true });
    assert.equal((await waitForResult(env, 3)).title, '没有需要导出的对话');
    assert.equal(env.downloads.length, 2, '没有变化时不应生成 ZIP');
    env.close();
});

test('导出进行中不能再启动第二个导出', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const api = new FakeChatGPT().addConversation(makeConversation('a'));
    api.route(/\/conversation\/a$/, async () => { await gate; });
    const env = loadExporter({ api });
    startFullExport(env);
    await waitFor(() => api.detailRequests().includes('a'), { message: '开始请求对话' });
    startFullExport(env);
    assert.match(env.$('#gre-toast')?.textContent || '', /已有导出任务正在进行/);
    release();
    await env.readZip();
    assert.equal(api.detailRequests().length, 1);
    env.close();
});

test('点击悬浮球可以取消导出，已完成的对话照常打包', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const api = new FakeChatGPT()
        .addConversation(makeConversation('a', { updateTime: 1700000300 }))
        .addConversation(makeConversation('b', { updateTime: 1700000200 }))
        .addConversation(makeConversation('c', { updateTime: 1700000100 }));
    api.route(/\/conversation\/b$/, async () => { await gate; });
    const env = loadExporter({ api });
    startFullExport(env);
    await waitFor(() => api.detailRequests().includes('b'), { message: '开始请求对话 b' });
    env.click('#gpt-rescue-btn');
    assert.equal(env.confirms.length, 1);
    release();
    const result = await env.readZip();
    assert.ok(result.find(/Title a.*\.json$/));
    assert.ok(!result.find(/Title c/));
    assert.ok(!api.detailRequests().includes('c'));
    const report = await result.json('export-error-report.json');
    assert.match(report.stopped_reason, /取消/);
    env.close();
});

test('选择器加载失败时显示错误信息', async () => {
    const api = new FakeChatGPT().route(/^\/backend-api\/conversations\?/, () => json({}, 500));
    const env = loadExporter({ api });
    env.window.ChatGPTExporter.showDialog();
    env.click('#select-personal-picker-btn');
    const status = await waitFor(() => {
        const text = env.$('#conv-status')?.textContent || '';
        return text.includes('加载失败') && text;
    }, { message: '错误提示' });
    assert.match(status, /500/);
    env.close();
});

test('附件下载到对话文件夹，并在 Markdown 中引用', async () => {
    const conversation = makeConversation('att', { nodes: 2 });
    conversation.mapping['att-n0'].message.metadata.attachments = [{ id: 'file-abc', name: 'photo.png', mime_type: 'image/png' }];
    const api = new FakeChatGPT()
        .addConversation(conversation)
        .route(/\/backend-api\/files\/download\/file-abc/, () => json({ download_url: '/blob/abc', file_name: 'photo.png' }))
        .route(/^\/blob\/abc$/, () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } }));
    const env = loadExporter({ api });
    env.window.ChatGPTExporter.showDialog();
    env.click('#include-attachments');
    env.click('#select-personal-btn');
    const result = await env.readZip();
    const image = result.find(/_files\/photo\.png$/);
    assert.ok(image, '应包含附件');
    assert.match(await result.text(result.find(/\.md$/)), /!\[photo\.png\]\(.*_files\/photo\.png\)/);
    const report = await result.json('attachment-export-report.json');
    assert.equal(report.downloaded, 1);
    assert.equal(report.failed, 0);
    env.close();
});
