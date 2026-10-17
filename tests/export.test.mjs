import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeChatGPT, loadExporter, makeConversation, waitFor } from './helpers/harness.mjs';

async function exportSelected(env, ids) {
    env.window.ChatGPTExporter.showDialog();
    env.click('#select-personal-picker-btn');
    await waitFor(() => env.$$('#conv-list .gre-item').length > 0, { message: '对话列表加载' });
    if (ids) {
        // 列表按更新时间倒序，按标题匹配勾选
        for (const row of env.$$('#conv-list .gre-item')) {
            if (ids.some(id => row.textContent.includes(`Title ${id}`))) row.querySelector('input').click();
        }
    } else {
        env.click('#select-all-btn');
    }
    env.click('#export-selected-btn');
    return env.readZip();
}

test('超长对话可以导出 Markdown，不会栈溢出', async () => {
    const api = new FakeChatGPT().addConversation(makeConversation('deep', { nodes: 50000 }));
    const env = loadExporter({ api });
    const result = await exportSelected(env);
    const markdownName = result.find(/Title deep.*\.md$/);
    assert.ok(markdownName, '应生成 Markdown');
    const markdown = await result.text(markdownName);
    assert.match(markdown, /message 49999 of deep/);
    env.close();
});

test('Markdown 只包含当前分支，JSON 保留完整对话树', async () => {
    const conversation = makeConversation('branch', { nodes: 4 });
    conversation.mapping['branch-alt'] = {
        id: 'branch-alt', parent: 'branch-n0', children: [],
        message: { id: 'branch-alt', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['old answer'] }, metadata: {} }
    };
    conversation.mapping['branch-n0'].children.push('branch-alt');
    const env = loadExporter({ api: new FakeChatGPT().addConversation(conversation) });
    const result = await exportSelected(env);
    const markdown = await result.text(result.find(/\.md$/));
    const exported = await result.json(result.find(/Title branch.*\.json$/));
    assert.doesNotMatch(markdown, /old answer/);
    assert.ok(exported.mapping['branch-alt'], 'JSON 应保留其他分支');
    env.close();
});

test('单个对话失败不影响其他对话，错误写入报告', async () => {
    const api = new FakeChatGPT()
        .addConversation(makeConversation('ok', { updateTime: 1700000300 }))
        .addConversation(makeConversation('gone', { updateTime: 1700000200 }))
        .addConversation(makeConversation('last', { updateTime: 1700000100 }))
        .route(/\/conversation\/gone$/, () => new Response('{}', { status: 500 }));
    const env = loadExporter({ api });
    const result = await exportSelected(env);
    assert.ok(result.find(/Title ok.*\.json$/));
    assert.ok(result.find(/Title last.*\.json$/));
    assert.ok(!result.find(/Title gone/));
    const report = await result.json('export-error-report.json');
    assert.equal(report.failed, 1);
    assert.deepEqual(report.issues.map(issue => [issue.conversation_id, issue.stage]), [['gone', 'fetch']]);
    env.close();
});

test('扩展版脚本可以正常加载并导出', async () => {
    const env = loadExporter({ api: new FakeChatGPT().addConversation(makeConversation('ext')), extension: true });
    assert.equal(env.$('#gpt-rescue-btn'), null, '扩展版不应常驻悬浮按钮');
    const result = await exportSelected(env);
    assert.ok(result.find(/Title ext.*\.md$/));
    env.close();
});
