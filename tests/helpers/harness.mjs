// 在 jsdom 中加载完整的导出脚本，并用内存中的假 ChatGPT 接口驱动真实的导出流程。
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { JSDOM, VirtualConsole } from 'jsdom';
import { buildExtensionScript } from '../../scripts/build.mjs';

const require = createRequire(import.meta.url);
const JSZip = require('../../chrome-extension/jszip.min.js');
const SOURCE = readFileSync(new URL('../../Tampermonkey.js', import.meta.url), 'utf8');

export { JSZip };

export function makeConversation(id, { nodes = 4, title = `Title ${id}`, updateTime = 1700000000 } = {}) {
    const mapping = { root: { id: 'root', parent: null, children: [], message: null } };
    let previous = 'root';
    for (let i = 0; i < nodes; i++) {
        const nodeId = `${id}-n${i}`;
        mapping[nodeId] = {
            id: nodeId,
            parent: previous,
            children: [],
            message: {
                id: nodeId,
                author: { role: i % 2 === 0 ? 'user' : 'assistant' },
                create_time: updateTime + i,
                content: { content_type: 'text', parts: [`message ${i} of ${id}`] },
                metadata: {}
            }
        };
        mapping[previous].children.push(nodeId);
        previous = nodeId;
    }
    return {
        title,
        conversation_id: `00000000-0000-0000-0000-${id.padStart(12, '0')}`.slice(-36),
        id,
        create_time: updateTime,
        update_time: updateTime,
        current_node: previous,
        mapping
    };
}

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
});

export class FakeChatGPT {
    constructor() {
        this.conversations = new Map();
        this.projects = new Map();
        this.requests = [];
        this.routes = [];
        this.accessToken = 'token-1';
    }

    addConversation(conversation, { archived = false, projectId = null } = {}) {
        this.conversations.set(conversation.id, { conversation, archived, projectId });
        return this;
    }

    addProject(id, name) {
        this.projects.set(id, { id, name });
        return this;
    }

    // 拦截匹配的请求；handler 返回 Response 时生效，返回 undefined 则继续走默认逻辑。
    route(pattern, handler) {
        this.routes.push({ pattern, handler });
        return this;
    }

    listItems(filter) {
        return [...this.conversations.values()]
            .filter(filter)
            .map(({ conversation, archived }) => ({
                id: conversation.id,
                title: conversation.title,
                create_time: conversation.create_time,
                update_time: conversation.update_time,
                is_archived: archived
            }));
    }

    async fetch(input, init = {}) {
        const url = new URL(String(input?.url || input), 'https://chatgpt.com/');
        const request = { path: url.pathname, search: url.searchParams, headers: init.headers || {} };
        this.requests.push(request);
        for (const { pattern, handler } of this.routes) {
            if (pattern.test(url.pathname + url.search)) {
                const response = await handler(request, url);
                if (response) return response;
            }
        }

        if (url.pathname === '/api/auth/session') return json({ accessToken: this.accessToken });

        if (url.pathname === '/backend-api/conversations') {
            const archived = url.searchParams.get('is_archived') === 'true';
            const offset = Number(url.searchParams.get('offset') || 0);
            const limit = Number(url.searchParams.get('limit') || 28);
            const all = this.listItems(entry => entry.archived === archived && !entry.projectId);
            return json({ items: all.slice(offset, offset + limit), total: all.length, limit, offset });
        }

        if (url.pathname === '/backend-api/gizmos/snorlax/sidebar') {
            return json({
                items: [...this.projects.values()].map(project => ({
                    gizmo: { gizmo: { id: project.id, display: { name: project.name } } },
                    conversations: { items: [] }
                })),
                cursor: null
            });
        }

        const projectMatch = url.pathname.match(/^\/backend-api\/gizmos\/([^/]+)\/conversations$/);
        if (projectMatch) {
            return json({ items: this.listItems(entry => entry.projectId === projectMatch[1]), cursor: null });
        }

        const detailMatch = url.pathname.match(/^\/backend-api\/conversation\/([^/]+)$/);
        if (detailMatch) {
            const entry = this.conversations.get(detailMatch[1]);
            return entry ? json(structuredClone(entry.conversation)) : json({ detail: 'not found' }, 404);
        }

        return json({ detail: `unhandled ${url.pathname}` }, 404);
    }

    detailRequests() {
        return this.requests
            .filter(r => r.path.startsWith('/backend-api/conversation/'))
            .map(r => r.path.split('/').pop());
    }
}

export async function waitFor(predicate, { timeout = 10000, message = 'condition' } = {}) {
    const started = Date.now();
    for (;;) {
        const value = await predicate();
        if (value) return value;
        if (Date.now() - started > timeout) throw new Error(`等待超时：${message}`);
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

export function loadExporter({ api = new FakeChatGPT(), extension = false } = {}) {
    const virtualConsole = new VirtualConsole();
    const logs = [];
    virtualConsole.on('jsdomError', error => {
        if (!/Not implemented: navigation/.test(error.message)) logs.push(['jsdomError', error]);
    });
    for (const level of ['error', 'warn']) {
        virtualConsole.on(level, (...args) => logs.push([level, ...args]));
    }

    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
        url: 'https://chatgpt.com/',
        runScripts: 'outside-only',
        pretendToBeVisual: true,
        virtualConsole
    });
    const { window } = dom;
    const alerts = [];
    const confirms = [];
    const downloads = [];

    window.document.cookie = 'oai-did=test-device';
    window.JSZip = JSZip;
    window.Headers = Headers;
    window.Response = Response;
    window.alert = message => alerts.push(String(message));
    window.confirm = message => {
        confirms.push(String(message));
        return true;
    };
    window.fetch = (input, init) => api.fetch(input, init);
    window.URL.createObjectURL = blob => {
        downloads.push(blob);
        return `blob:https://chatgpt.com/${downloads.length}`;
    };
    window.URL.revokeObjectURL = () => {};
    // 脚本里的节流等待只影响速度，测试中统一压缩为 0。
    const realSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = (fn, _ms, ...args) => realSetTimeout(fn, 0, ...args);

    window.eval(extension ? buildExtensionScript(SOURCE) : SOURCE);

    const $ = selector => window.document.querySelector(selector);
    return {
        window,
        document: window.document,
        api,
        alerts,
        confirms,
        downloads,
        logs,
        $,
        $$: selector => [...window.document.querySelectorAll(selector)],
        click(selector) {
            const element = $(selector);
            if (!element) throw new Error(`找不到元素 ${selector}`);
            element.click();
        },
        async readZip(index = 0) {
            const blob = await waitFor(() => downloads[index], { message: `第 ${index + 1} 个下载` });
            const zip = await JSZip.loadAsync(await blob.arrayBuffer());
            const files = Object.keys(zip.files).filter(name => !zip.files[name].dir).sort();
            return {
                zip,
                files,
                text: name => zip.file(name).async('string'),
                json: async name => JSON.parse(await zip.file(name).async('string')),
                find: pattern => files.find(name => pattern.test(name))
            };
        },
        close() {
            window.close();
        }
    };
}
