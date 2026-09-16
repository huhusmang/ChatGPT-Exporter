// ==UserScript==
// @name         ChatGPT Universal Exporter (Markdown Support)
// @version      1.6.0
// @description  Export ChatGPT conversations with visible uploads and generated files as JSON+Markdown ZIP backups.
// @author       huhu
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// @grant        none
// @license      MIT
// @source       https://greasyfork.org/scripts/538495-chatgpt-universal-exporter
// @namespace    https://github.com/huhusmang/ChatGPT-Exporter
// @homepageURL  https://greasyfork.org/zh-CN/scripts/556233-chatgpt-universal-exporter-markdown-support
// @downloadURL  https://update.greasyfork.org/scripts/556233/ChatGPT%20Universal%20Exporter%20(Markdown%20Support).user.js
// @updateURL    https://update.greasyfork.org/scripts/556233/ChatGPT%20Universal%20Exporter%20(Markdown%20Support).meta.js
// ==/UserScript==

/* ============================================================
    v1.6.0 变更 (速率限制 + 断点续传)
    ------------------------------------------------------------
    • 所有 backend-api 请求统一限速（最小间隔 1s）并串行化，降低触发 429 概率
    • 遇到 429/5xx 自动按 Retry-After 或指数退避重试（最多 5 次）
    • 已完成对话实时缓存到 IndexedDB；导出中断后可断点续传，仅补抓剩余部分
    • 单个对话失败不再中断整个导出，失败部分可在下次导出时自动补抓
    ========================================================== */

/* ============================================================
    v1.5.0 变更 (悬浮按钮重设计)
    ------------------------------------------------------------
    • 宽文字按钮改为 44px 紧凑悬浮球，竖屏不再遮挡发送按钮
    • 支持拖动到任意位置（localStorage 记忆），拖近左右边缘自动吸附
    • 贴边后空闲 2.5 秒半隐藏为侧边把手，hover/点按展开
    • 导出进度以环形进度 + 百分比显示在悬浮球上，明细显示在旁边状态气泡
    • 适配深色模式；右键点击可重置位置
    ========================================================== */

/* ============================================================
    v1.4.0 变更 (新增附件与多模态导出)
    ------------------------------------------------------------
    • 仅导出用户上传附件、可见图片和最终回复中的生成文件
    • 使用 Uint8Array 写入 ZIP，避免 Blob 兼容问题
    • 启用附件下载时生成 attachment-export-report.json 便于诊断
    ========================================================== */

(function () {
    'use strict';

    // --- 配置与全局变量 ---
    const BASE_DELAY = 600;
    const JITTER = 400;
    const PAGE_LIMIT = 100;
    const PROJECT_SIDEBAR_PREVIEW = 5;
    const PROJECT_SIDEBAR_LIMIT = 50;
    let accessToken = null;
    let capturedWorkspaceIds = new Set(); // 使用Set存储网络拦截到的ID，确保唯一性

    // --- 核心：网络拦截与信息捕获 ---
    (function interceptNetwork() {
        const rawFetch = window.fetch;
        window.fetch = async function (resource, options) {
            tryCaptureToken(options?.headers);
            if (options?.headers?.['ChatGPT-Account-Id']) {
                const id = options.headers['ChatGPT-Account-Id'];
                if (id && !capturedWorkspaceIds.has(id)) {
                    console.log('🎯 [Fetch] 捕获到 Workspace ID:', id);
                    capturedWorkspaceIds.add(id);
                }
            }
            return rawFetch.apply(this, arguments);
        };

        const rawOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function () {
            this.addEventListener('readystatechange', () => {
                if (this.readyState === 4) {
                    try {
                        tryCaptureToken(this.getRequestHeader('Authorization'));
                        const id = this.getRequestHeader('ChatGPT-Account-Id');
                        if (id && !capturedWorkspaceIds.has(id)) {
                            console.log('🎯 [XHR] 捕获到 Workspace ID:', id);
                            capturedWorkspaceIds.add(id);
                        }
                    } catch (_) {}
                }
            });
            return rawOpen.apply(this, arguments);
        };
    })();

    function tryCaptureToken(header) {
        if (!header) return;
        const h = typeof header === 'string' ? header : header instanceof Headers ? header.get('Authorization') : header.Authorization || header.authorization;
        if (h?.startsWith('Bearer ')) {
        const token = h.slice(7);
        // [v8.2.0 修复] 在捕获源头增加验证，拒绝已知的无效占位符Token
        if (token && token.toLowerCase() !== 'dummy') {
            accessToken = token;
        }
        }
    }

    async function ensureAccessToken() {
        if (accessToken) return accessToken;
        try {
            const session = await (await fetch('/api/auth/session?unstable_client=true')).json();
            if (session.accessToken) {
                accessToken = session.accessToken;
                return accessToken;
            }
        } catch (_) {}
        alert('无法获取 Access Token。请刷新页面或打开任意一个对话后再试。');
        return null;
    }

    // --- 辅助函数 ---
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const jitter = () => BASE_DELAY + Math.random() * JITTER;

    // --- 速率限制：backend-api 请求统一经 apiFetch 串行限速，遇 429/5xx 自动退避重试 ---
    const RATE_LIMIT_MIN_INTERVAL = 1000;   // 相邻两次 API 请求的最小间隔（毫秒）
    const RATE_LIMIT_MAX_RETRIES = 5;       // 遇到 429/可重试状态码时的最大重试次数
    const RATE_LIMIT_BASE_BACKOFF = 2000;   // 首次重试的基础等待（毫秒）
    const RATE_LIMIT_MAX_BACKOFF = 60000;   // 指数退避的等待上限（毫秒）

    let rateLimitNextSlotAt = 0;            // 下一个可用的请求时间槽
    let rateLimitChain = Promise.resolve(); // 串行化所有 API 请求，避免并发触发限流

    // 预约下一个请求时间槽，返回需要等待的毫秒数
    function reserveRateLimitSlot() {
        const now = Date.now();
        const slot = Math.max(now, rateLimitNextSlotAt);
        rateLimitNextSlotAt = slot + RATE_LIMIT_MIN_INTERVAL;
        return slot - now;
    }

    function isRetryableStatus(status) {
        return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
    }

    function parseRetryAfter(response) {
        const raw = response?.headers?.get('retry-after');
        if (!raw) return null;
        const seconds = Number(raw);
        if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
        const date = Date.parse(raw);
        return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
    }

    function backoffDelay(retry) {
        const exp = Math.min(RATE_LIMIT_BASE_BACKOFF * 2 ** retry, RATE_LIMIT_MAX_BACKOFF);
        return exp / 2 + Math.random() * (exp / 2);
    }

    // 串行 + 限速地执行一次 GET/fetch；429 优先遵循 Retry-After，否则指数退避
    function apiFetch(url, options = {}, label = 'API 请求') {
        const attempt = async () => {
            await sleep(reserveRateLimitSlot());
            for (let retry = 0; ; retry++) {
                let response;
                try {
                    response = await fetch(url, options);
                } catch (error) {
                    if (retry >= RATE_LIMIT_MAX_RETRIES) throw error;
                    console.warn(`⏳ [速率限制] ${label} 网络异常，${Math.round(backoffDelay(retry) / 1000)}s 后重试 (${retry + 1}/${RATE_LIMIT_MAX_RETRIES})`);
                    await sleep(backoffDelay(retry));
                    continue;
                }
                if (response.ok || !isRetryableStatus(response.status) || retry >= RATE_LIMIT_MAX_RETRIES) {
                    if (retry > 0) response.__rateLimitRetries = retry;
                    return response;
                }
                const retryAfter = parseRetryAfter(response);
                const waitMs = retryAfter !== null ? retryAfter : backoffDelay(retry);
                console.warn(`⏳ [速率限制] ${label} 返回 ${response.status}，等待 ${Math.round(waitMs / 1000)}s 后重试 (${retry + 1}/${RATE_LIMIT_MAX_RETRIES})`);
                await sleep(waitMs);
            }
        };
        const result = rateLimitChain.then(attempt, attempt);
        // 失败不阻断后续请求的排队
        rateLimitChain = result.then(() => {}, () => {});
        return result;
    }

    // --- 断点续传：已完成的对话写入 IndexedDB，中断后重新导出可跳过已缓存部分 ---
    const RESUME_DB_NAME = 'chatgpt-exporter-resume';
    const RESUME_DB_VERSION = 1;
    const RESUME_RECORD_STORE = 'records';

    function openResumeDb() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(RESUME_DB_NAME, RESUME_DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(RESUME_RECORD_STORE)) {
                    db.createObjectStore(RESUME_RECORD_STORE);
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    function idbRequest(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async function resumeDb(mode, run) {
        const db = await openResumeDb();
        try {
            const tx = db.transaction(RESUME_RECORD_STORE, mode);
            const result = await run(tx.objectStore(RESUME_RECORD_STORE));
            await new Promise((resolve, reject) => {
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error);
            });
            return result;
        } finally {
            db.close();
        }
    }

    const resumeRecordKey = (sessionKey, convId) => `${sessionKey}|${convId}`;
    const resumeRecordRange = (sessionKey) => IDBKeyRange.bound(`${sessionKey}|`, `${sessionKey}|\uffff`, false, false);

    // 缓存按“空间+是否含附件”隔离，避免不同导出类型互相污染
    function getSessionKey(mode, workspaceId, includeAttachments) {
        return `${mode}:${workspaceId || 'personal'}:${includeAttachments ? 'att' : 'plain'}`;
    }

    function resumeGetRecord(sessionKey, convId) {
        return resumeDb('readonly', store => idbRequest(store.get(resumeRecordKey(sessionKey, convId))));
    }

    function resumeSaveRecord(sessionKey, record) {
        return resumeDb('readwrite', store => idbRequest(store.put(record, resumeRecordKey(sessionKey, record.id))));
    }

    function resumeCountRecords(sessionKey) {
        return resumeDb('readonly', store => idbRequest(store.count(resumeRecordRange(sessionKey))));
    }

    function resumeClearSession(sessionKey) {
        return resumeDb('readwrite', store => idbRequest(store.delete(resumeRecordRange(sessionKey))));
    }
    const sanitizeFilename = (name) => name.replace(/[\/\\?%*:|"<>]/g, '-').trim();
    const normalizeEpochSeconds = (value) => {
        if (!value) return 0;
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value > 1e12 ? Math.floor(value / 1000) : value;
        }
        if (typeof value === 'string') {
            const parsed = Date.parse(value);
            if (!Number.isNaN(parsed)) {
                return Math.floor(parsed / 1000);
            }
        }
        return 0;
    };
    const formatTimestamp = (value) => {
        const seconds = normalizeEpochSeconds(value);
        if (!seconds) return '';
        const date = new Date(seconds * 1000);
        return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
    };
    const parseDateInputToEpoch = (value, isEnd = false) => {
        if (!value) return null;
        const parts = value.split('-').map(Number);
        if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
        const [year, month, day] = parts;
        const date = isEnd
            ? new Date(year, month - 1, day, 23, 59, 59, 999)
            : new Date(year, month - 1, day, 0, 0, 0, 0);
        const epochMs = date.getTime();
        return Number.isNaN(epochMs) ? null : Math.floor(epochMs / 1000);
    };

    /**
     * [新增] 从Cookie中获取 oai-device-id
     * @returns {string|null} - 返回设备ID或null
     */
    function getOaiDeviceId() {
        const cookieString = document.cookie;
        const match = cookieString.match(/oai-did=([^;]+)/);
        return match ? match[1] : null;
    }

    function generateUniqueFilename(convData) {
        const convId = convData.conversation_id || '';
        const shortId = convId.includes('-') ? convId.split('-').pop() : (convId || Date.now().toString(36));
        let baseName = convData.title;
        if (!baseName || baseName.trim().toLowerCase() === 'new chat') {
            baseName = 'Untitled Conversation';
        }
        return `${sanitizeFilename(baseName)}_${shortId}.json`;
    }

    function generateMarkdownFilename(convData) {
        const jsonName = generateUniqueFilename(convData);
        return jsonName.endsWith('.json')
            ? `${jsonName.slice(0, -5)}.md`
            : `${jsonName}.md`;
    }

    const ATTACHMENT_EXPORT_VERSION = '1.6.0';
    const EXPORT_BUTTON_LABEL = `Export Conversations v${ATTACHMENT_EXPORT_VERSION}`;
    const MIME_EXTENSIONS = {
        'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
        'application/pdf': '.pdf', 'application/zip': '.zip', 'application/json': '.json',
        'text/plain': '.txt', 'text/csv': '.csv',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx'
    };

    function safeAttachmentName(value) {
        let name = String(value || 'attachment');
        try { name = decodeURIComponent(name); } catch (_) {}
        name = name.split(/[\\/]/).pop() || 'attachment';
        return name
            .replace(/[\u0000-\u001f\u007f]/g, '')
            .replace(/[\\/:*?"<>|]/g, '-')
            .replace(/^[. ]+|[. ]+$/g, '')
            .slice(0, 180) || 'attachment';
    }

    function addMimeExtension(filename, mimeType) {
        if (/\.[a-z0-9]{1,10}$/i.test(filename)) return filename;
        const mime = String(mimeType || '').split(';')[0].trim().toLowerCase();
        return filename + (MIME_EXTENSIONS[mime] || '');
    }

    function uniqueAttachmentName(filename, usedNames) {
        const safe = safeAttachmentName(filename);
        if (!usedNames.has(safe)) {
            usedNames.add(safe);
            return safe;
        }
        const dot = safe.lastIndexOf('.');
        const base = dot > 0 ? safe.slice(0, dot) : safe;
        const extension = dot > 0 ? safe.slice(dot) : '';
        let index = 2;
        while (usedNames.has(`${base}_${index}${extension}`)) index++;
        const result = `${base}_${index}${extension}`;
        usedNames.add(result);
        return result;
    }

    function extractFileId(pointer) {
        if (typeof pointer !== 'string') return null;
        const match = pointer.match(/file[-_][a-z0-9]+/i);
        return match ? match[0] : null;
    }

    function collectVisibleAttachments(convData) {
        const references = new Map();
        const add = (reference) => {
            const key = reference.kind === 'sandbox'
                ? `sandbox:${reference.messageId}:${reference.sandboxPath}`
                : `file:${reference.fileId}`;
            if (!references.has(key)) references.set(key, reference);
        };

        Object.values(convData?.mapping || {}).forEach(node => {
            const message = node?.message;
            if (!message) return;
            const role = message.author?.role;
            if (role !== 'user' && role !== 'assistant' && role !== 'tool') return;
            if (message.metadata?.is_visually_hidden_from_conversation) return;

            if (role === 'user') {
                (message.metadata?.attachments || []).forEach(attachment => {
                    const fileId = attachment?.id || attachment?.file_id;
                    if (!fileId) return;
                    add({
                        kind: 'file', fileId, messageId: message.id,
                        ownerRole: role,
                        name: attachment.name || fileId,
                        mimeType: attachment.mime_type || '',
                        isImage: /^image\//i.test(attachment.mime_type || '')
                    });
                });
            }

            (message.content?.parts || []).forEach(part => {
                if (part && typeof part === 'object' && part.asset_pointer && /image|canvas|audio|video/i.test(part.content_type || '')) {
                    const isGeneratedToolImage = role === 'tool' && Boolean(part.metadata?.dalle || part.metadata?.generation);
                    if (role === 'tool' && !isGeneratedToolImage) return;
                    const fileId = extractFileId(part.asset_pointer);
                    if (fileId) {
                        add({
                            kind: 'file', fileId, messageId: message.id,
                            ownerRole: role,
                            name: isGeneratedToolImage ? 'generated_image' : (/image/i.test(part.content_type || '') ? 'image' : fileId),
                            mimeType: '', isImage: /image/i.test(part.content_type || '')
                        });
                    }
                }
                const text = typeof part === 'string' ? part : part?.text;
                if (role !== 'assistant' || typeof text !== 'string') return;
                for (const match of text.matchAll(/\]\((sandbox:[^)]+)\)/gi)) {
                    const sandboxPath = match[1];
                    add({
                        kind: 'sandbox', sandboxPath, messageId: message.id,
                        ownerRole: role,
                        name: sandboxPath.split('/').pop() || 'generated_file',
                        mimeType: '', isImage: /\.(?:png|jpe?g|gif|webp|svg)$/i.test(sandboxPath)
                    });
                }
            });
        });
        return Array.from(references.values());
    }

    function attachmentHeaders(workspaceId) {
        const headers = {
            'Authorization': `Bearer ${accessToken}`,
            'oai-device-id': getOaiDeviceId()
        };
        const resolvedWorkspaceId = resolveWorkspaceId(workspaceId);
        if (resolvedWorkspaceId) headers['ChatGPT-Account-Id'] = resolvedWorkspaceId;
        return headers;
    }

    async function fetchAttachmentBinary(reference, convData, workspaceId) {
        const headers = attachmentHeaders(workspaceId);
        let metadataUrl;
        if (reference.kind === 'sandbox') {
            const conversationId = convData?.conversation_id || convData?.id;
            if (!conversationId || !reference.messageId) throw new Error('missing conversation/message id');
            const query = new URLSearchParams({
                message_id: reference.messageId,
                sandbox_path: reference.sandboxPath.replace(/^sandbox:/i, '')
            });
            metadataUrl = `/backend-api/conversation/${encodeURIComponent(conversationId)}/interpreter/download?${query}`;
        } else {
            metadataUrl = `/backend-api/files/download/${encodeURIComponent(reference.fileId)}?inline=false`;
        }

        const metadataResponse = await apiFetch(metadataUrl, { credentials: 'include', headers }, `附件元数据 ${reference.fileId || reference.sandboxPath}`);
        if (!metadataResponse.ok) throw new Error(`metadata HTTP ${metadataResponse.status}`);
        const contentType = metadataResponse.headers.get('content-type') || '';
        if (!contentType.includes('json')) {
            const directName = addMimeExtension(reference.name, contentType);
            return { data: new Uint8Array(await metadataResponse.arrayBuffer()), filename: directName };
        }

        const metadata = await metadataResponse.json();
        const downloadUrl = metadata.download_url || metadata.url;
        if (!downloadUrl) throw new Error('download_url missing or expired');
        const parsedUrl = new URL(downloadUrl, location.origin);
        const sameOrigin = parsedUrl.origin === location.origin;
        const response = await fetch(parsedUrl.href, sameOrigin
            ? { credentials: 'include', headers }
            : {});
        if (!response.ok) throw new Error(`binary HTTP ${response.status}`);
        const mimeType = response.headers.get('content-type') || reference.mimeType || '';
        const filename = addMimeExtension(
            safeAttachmentName(metadata.file_name || metadata.filename || reference.name),
            mimeType
        );
        return { data: new Uint8Array(await response.arrayBuffer()), filename };
    }

    function encodeRelativePath(path) {
        return path.split('/').map(segment => encodeURIComponent(segment)).join('/');
    }

    function zipFolderName(convData) {
        return generateUniqueFilename(convData).replace(/\.json$/i, '') + '_files';
    }

    async function appendAttachmentsToZip(target, convData, workspaceId) {
        const references = collectVisibleAttachments(convData);
        const failures = [];
        const files = [];
        const sandboxPaths = new Map();
        const usedNames = new Set();
        const folderName = zipFolderName(convData);

        for (const reference of references) {
            try {
                const downloaded = await fetchAttachmentBinary(reference, convData, workspaceId);
                const filename = uniqueAttachmentName(downloaded.filename, usedNames);
                target.folder(folderName).file(filename, downloaded.data);
                const relativePath = encodeRelativePath(`${folderName}/${filename}`);
                files.push({
                    name: filename,
                    path: relativePath,
                    kind: reference.kind,
                    isImage: reference.isImage,
                    messageId: reference.messageId,
                    ownerRole: reference.ownerRole,
                    data: downloaded.data
                });
                if (reference.kind === 'sandbox') {
                    sandboxPaths.set(`${reference.messageId}|${reference.sandboxPath}`, relativePath);
                }
            } catch (error) {
                failures.push({
                    kind: reference.kind,
                    file_id: reference.fileId || null,
                    sandbox_path: reference.sandboxPath || null,
                    message_id: reference.messageId || null,
                    name: reference.name,
                    error: error?.message || String(error)
                });
            }
            await sleep(150);
        }
        return { detected: references.length, files, failures, sandboxPaths };
    }

    function replaceDownloadedSandboxLinks(text, sandboxPaths, messageId) {
        if (!text || !sandboxPaths) return text;
        return text.replace(/\]\((sandbox:[^)]+)\)/gi, (match, sandboxPath) => {
            const localPath = sandboxPaths.get(`${messageId}|${sandboxPath}`);
            return localPath ? `](${localPath})` : match;
        });
    }

    function cleanMessageContent(text) {
        if (!text) return '';
        return text
            .replace(/\uE200cite(?:\uE202turn\d+(?:search|view)\d+)+\uE201/gi, '')
            .replace(/cite(?:turn\d+(?:search|view)\d+)+/gi, '')
            .trim();
    }

    function processContentReferences(text, contentReferences) {
        if (!text || !Array.isArray(contentReferences) || contentReferences.length === 0) {
            return { text, footnotes: [] };
        }

        const references = contentReferences.filter(ref => ref && typeof ref.matched_text === 'string' && ref.matched_text.length > 0);
        if (references.length === 0) {
            return { text, footnotes: [] };
        }

        const getReferenceInfo = (ref) => {
            const item = Array.isArray(ref.items) ? ref.items[0] : null;
            const url = item?.url || (Array.isArray(ref.safe_urls) ? ref.safe_urls[0] : '') || '';
            const title = item?.title || '';
            let label = item?.attribution || '';
            if (!label && typeof ref.alt === 'string') {
                const match = ref.alt.match(/\[([^\]]+)\]\([^)]+\)/);
                if (match) label = match[1];
            }
            if (!label) label = title || url;
            return { url, title, label };
        };

        const footnotes = [];
        const footnoteIndexByKey = new Map();
        const citationRefs = references
            .filter(ref => ref.type === 'grouped_webpages')
            .sort((a, b) => {
                const aIdx = Number.isFinite(a.start_idx) ? a.start_idx : Number.MAX_SAFE_INTEGER;
                const bIdx = Number.isFinite(b.start_idx) ? b.start_idx : Number.MAX_SAFE_INTEGER;
                return aIdx - bIdx;
            });

        citationRefs.forEach(ref => {
            const info = getReferenceInfo(ref);
            if (!info.url) return;
            const key = `${info.url}|${info.title}`;
            if (footnoteIndexByKey.has(key)) return;
            const index = footnotes.length + 1;
            footnoteIndexByKey.set(key, index);
            footnotes.push({ index, url: info.url, title: info.title, label: info.label });
        });

        const sortedByReplacement = references
            .slice()
            .sort((a, b) => {
                const aIdx = Number.isFinite(a.start_idx) ? a.start_idx : -1;
                const bIdx = Number.isFinite(b.start_idx) ? b.start_idx : -1;
                if (aIdx !== -1 || bIdx !== -1) {
                    return bIdx - aIdx;
                }
                return (b.matched_text?.length || 0) - (a.matched_text?.length || 0);
            });

        let output = text;
        sortedByReplacement.forEach(ref => {
            if (!ref?.matched_text || ref.type === 'sources_footnote') return;
            let replacement = '';
            if (ref.type === 'grouped_webpages') {
                const info = getReferenceInfo(ref);
                if (info.url) {
                    const key = `${info.url}|${info.title}`;
                    const index = footnoteIndexByKey.get(key);
                    replacement = index ? `([${info.label}][${index}])` : (ref.alt || '');
                } else {
                    replacement = ref.alt || '';
                }
            } else {
                replacement = ref.alt || '';
            }

            if (Number.isFinite(ref.start_idx) && Number.isFinite(ref.end_idx)) {
                if (output.slice(ref.start_idx, ref.end_idx) === ref.matched_text) {
                    output = output.slice(0, ref.start_idx) + replacement + output.slice(ref.end_idx);
                    return;
                }
            }
            output = output.split(ref.matched_text).join(replacement);
        });

        return { text: output, footnotes };
    }

    function extractConversationMessages(convData, attachmentResult = null) {
        const mapping = convData?.mapping;
        if (!mapping) return [];

        const messages = [];
        const mappingKeys = Object.keys(mapping);
        const rootId = mapping['client-created-root']
            ? 'client-created-root'
            : mappingKeys.find(id => !mapping[id]?.parent) || mappingKeys[0];
        const visited = new Set();

        const traverse = (nodeId) => {
            if (!nodeId || visited.has(nodeId)) return;
            visited.add(nodeId);
            const node = mapping[nodeId];
            if (!node) return;

            const msg = node.message;
            if (msg) {
                const author = msg.author?.role;
                const isHidden = msg.metadata?.is_visually_hidden_from_conversation ||
                    msg.metadata?.is_contextual_answers_system_message;
                if ((author === 'user' || author === 'assistant') && !isHidden) {
                    const content = msg.content;
                    if ((content?.content_type === 'text' || content?.content_type === 'multimodal_text') && Array.isArray(content.parts)) {
                        const rawText = content.parts
                            .map(part => typeof part === 'string' ? part : (part?.text ?? ''))
                            .filter(Boolean)
                            .join('\n');
                        const contentReferences = msg.metadata?.content_references || [];
                        let processedText = rawText;
                        let footnotes = [];
                        if (Array.isArray(contentReferences) && contentReferences.length > 0) {
                            const processed = processContentReferences(rawText, contentReferences);
                            processedText = processed.text;
                            footnotes = processed.footnotes;
                        }
                        const cleaned = cleanMessageContent(
                            replaceDownloadedSandboxLinks(processedText, attachmentResult?.sandboxPaths, msg.id)
                        );
                        const attachmentLines = (attachmentResult?.files || [])
                            .filter(file => file.messageId === msg.id && file.kind !== 'sandbox')
                            .map(file => {
                                const label = file.name.replace(/[\[\]]/g, '\\$&');
                                return file.isImage ? `![${label}](${file.path})` : `📎 [${label}](${file.path})`;
                            });
                        const renderedContent = [cleaned, ...attachmentLines].filter(Boolean).join('\n\n');
                        if (renderedContent) {
                            messages.push({
                                role: author,
                                content: renderedContent,
                                messageId: msg.id,
                                create_time: msg.create_time || null,
                                footnotes
                            });
                        }
                    }
                }
            }

            if (Array.isArray(node.children)) {
                node.children.forEach(childId => traverse(childId));
            }
        };

        if (rootId) {
            traverse(rootId);
        } else {
            mappingKeys.forEach(traverse);
        }

        return messages;
    }

    function convertConversationToMarkdown(convData, attachmentResult = null) {
        const messages = extractConversationMessages(convData, attachmentResult);
        const mdLines = messages.length === 0
            ? ['# Conversation', 'No visible user or assistant messages were exported.', '']
            : [];
        messages.forEach(msg => {
            const roleLabel = msg.role === 'user' ? '# User' : '# Assistant';
            mdLines.push(roleLabel);
            mdLines.push(msg.content);
            if (Array.isArray(msg.footnotes) && msg.footnotes.length > 0) {
                mdLines.push('');
                msg.footnotes
                    .slice()
                    .sort((a, b) => a.index - b.index)
                    .forEach(note => {
                        if (!note.url) return;
                        const title = note.title ? ` "${note.title}"` : '';
                        mdLines.push(`[${note.index}]: ${note.url}${title}`);
                    });
            }
            mdLines.push('');
        });

        const additionalFiles = (attachmentResult?.files || [])
            .filter(file => file.kind !== 'sandbox' && file.ownerRole !== 'user' && file.ownerRole !== 'assistant');
        if (additionalFiles.length > 0) {
            mdLines.push('# Attachments', '');
            additionalFiles.forEach(file => {
                const label = file.name.replace(/[\[\]]/g, '\\$&');
                mdLines.push(file.isImage ? `![${label}](${file.path})` : `- [${label}](${file.path})`);
            });
            mdLines.push('');
        }

        return mdLines.join('\n').trim() + '\n';
    }

    function downloadFile(blob, filename) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);
    }

    // --- 悬浮导出按钮（紧凑悬浮球：可拖动、位置记忆、贴边半隐藏） ---
    const FAB_SIZE = 44;
    const FAB_DRAG_THRESHOLD = 6;
    const FAB_EDGE_SNAP = 36;
    const FAB_STORAGE_KEY = 'chatgpt-exporter-fab-v1';
    const FAB_ICON_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';

    const fabState = { x: null, y: null, docked: null, collapsed: false };
    let fabDragInfo = null;
    let fabSuppressClick = false;
    let fabCollapseTimer = null;

    function fabDefaultPosition() {
        return { x: window.innerWidth - FAB_SIZE / 2 - 14, y: Math.round(window.innerHeight * 0.45) };
    }

    function fabClamp(pos) {
        const half = FAB_SIZE / 2;
        return {
            x: Math.min(Math.max(pos.x, half + 2), Math.max(half + 2, window.innerWidth - half - 2)),
            y: Math.min(Math.max(pos.y, half + 2), Math.max(half + 2, window.innerHeight - half - 2))
        };
    }

    function fabSnap(pos) {
        const half = FAB_SIZE / 2;
        const snapped = { ...pos };
        fabState.docked = null;
        if (pos.x <= half + FAB_EDGE_SNAP) {
            snapped.x = half + 2;
            fabState.docked = 'left';
        } else if (pos.x >= window.innerWidth - half - FAB_EDGE_SNAP) {
            snapped.x = window.innerWidth - half - 2;
            fabState.docked = 'right';
        }
        return snapped;
    }

    function loadFabState() {
        try {
            const saved = JSON.parse(localStorage.getItem(FAB_STORAGE_KEY));
            if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') return saved;
        } catch (_) {}
        return null;
    }

    function saveFabState() {
        try {
            localStorage.setItem(FAB_STORAGE_KEY, JSON.stringify({
                x: fabState.x,
                y: fabState.y,
                docked: fabState.docked,
                collapsed: fabState.collapsed
            }));
        } catch (_) {}
    }

    function fabStatusEl() {
        let el = document.getElementById('gre-fab-status');
        if (!el) {
            el = document.createElement('div');
            el.id = 'gre-fab-status';
            document.body.appendChild(el);
        }
        return el;
    }

    function fabPositionStatus(btn) {
        const pill = document.getElementById('gre-fab-status');
        if (!pill) return;
        const rect = btn.getBoundingClientRect();
        const left = fabState.x > window.innerWidth / 2
            ? rect.left - pill.offsetWidth - 10
            : rect.right + 10;
        pill.style.left = `${Math.max(6, Math.min(left, window.innerWidth - pill.offsetWidth - 6))}px`;
        pill.style.top = `${Math.round(rect.top + rect.height / 2 - pill.offsetHeight / 2)}px`;
    }

    function fabApply(btn, pos, persist = false) {
        fabState.x = pos.x;
        fabState.y = pos.y;
        btn.style.left = `${Math.round(pos.x - FAB_SIZE / 2)}px`;
        btn.style.top = `${Math.round(pos.y - FAB_SIZE / 2)}px`;
        fabPositionStatus(btn);
        if (persist) saveFabState();
    }

    function fabIsCollapsed(btn) {
        return btn.classList.contains('gre-collapsed-left') || btn.classList.contains('gre-collapsed-right');
    }

    function fabExpand(btn) {
        btn.classList.remove('gre-collapsed-left', 'gre-collapsed-right');
        fabState.collapsed = false;
    }

    function fabCollapse(btn) {
        fabExpand(btn);
        if (!fabState.docked) return;
        btn.classList.add(`gre-collapsed-${fabState.docked}`);
        fabState.collapsed = true;
        saveFabState();
    }

    function fabScheduleCollapse(btn) {
        clearTimeout(fabCollapseTimer);
        if (!fabState.docked) return;
        fabCollapseTimer = setTimeout(() => {
            if (!btn.classList.contains('gre-busy') && !btn.classList.contains('gre-progress') && !btn.matches(':hover')) {
                fabCollapse(btn);
            }
        }, 2500);
    }

    function setFabStatus(btn, text) {
        btn.classList.remove('gre-busy', 'gre-progress', 'gre-done', 'gre-error');
        const ring = btn.querySelector('.gre-fab-ring');
        const badge = btn.querySelector('.gre-fab-badge');
        const pill = fabStatusEl();
        if (text === EXPORT_BUTTON_LABEL) {
            if (badge) badge.textContent = '';
            pill.classList.remove('gre-visible');
            btn.title = `ChatGPT Exporter v${ATTACHMENT_EXPORT_VERSION} · 点击导出 · 拖动移动 · 右键重置位置`;
            fabScheduleCollapse(btn);
            return;
        }
        const progress = /\((\d+)\s*\/\s*(\d+)\)/.exec(text);
        if (progress && Number(progress[2]) > 0) {
            const pct = Math.min(100, Math.round((Number(progress[1]) / Number(progress[2])) * 100));
            btn.classList.add('gre-progress');
            if (ring) ring.style.setProperty('--gre-pct', String(pct));
            if (badge) badge.textContent = `${pct}%`;
        } else if (text.includes('✅')) {
            btn.classList.add('gre-done');
            if (badge) badge.textContent = '✓';
        } else if (text.includes('⚠️')) {
            btn.classList.add('gre-error');
            if (badge) badge.textContent = '!';
        } else {
            btn.classList.add('gre-busy');
            if (badge) badge.textContent = '';
        }
        btn.title = `${text} · ChatGPT Exporter v${ATTACHMENT_EXPORT_VERSION}`;
        fabExpand(btn);
        pill.textContent = text;
        pill.classList.add('gre-visible');
        fabPositionStatus(btn);
    }

    function ensureFabStyle() {
        if (document.getElementById('gre-fab-style')) return;
        const style = document.createElement('style');
        style.id = 'gre-fab-style';
        style.textContent = `
#gpt-rescue-btn {
    position: fixed;
    width: ${FAB_SIZE}px;
    height: ${FAB_SIZE}px;
    padding: 0;
    border-radius: 999px;
    border: 1px solid rgba(0, 0, 0, .08);
    background: rgba(255, 255, 255, .88);
    color: #0d0d0d;
    -webkit-backdrop-filter: blur(10px);
    backdrop-filter: blur(10px);
    box-shadow: 0 2px 10px rgba(0, 0, 0, .16);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: grab;
    z-index: 99997;
    user-select: none;
    -webkit-user-select: none;
    touch-action: none;
    font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
    transition: transform .25s ease, box-shadow .2s ease;
}
#gpt-rescue-btn:hover { box-shadow: 0 4px 16px rgba(0, 0, 0, .24); }
#gpt-rescue-btn.gre-dragging { transition: none; cursor: grabbing; }
#gpt-rescue-btn:disabled { cursor: default; }
#gpt-rescue-btn:focus-visible { outline: 2px solid #10a37f; outline-offset: 2px; }

html.dark #gpt-rescue-btn {
    background: rgba(52, 53, 65, .92);
    border-color: rgba(255, 255, 255, .14);
    color: #ececec;
}

.gre-fab-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    transition: opacity .2s;
}
.gre-fab-ring {
    position: absolute;
    inset: 2px;
    border-radius: 999px;
    opacity: 0;
    background: conic-gradient(#10a37f calc(var(--gre-pct, 0) * 1%), rgba(0, 0, 0, .12) 0);
    -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 3.5px), #000 calc(100% - 3px));
    mask: radial-gradient(farthest-side, transparent calc(100% - 3.5px), #000 calc(100% - 3px));
    transition: opacity .2s;
}
html.dark .gre-fab-ring {
    background: conic-gradient(#19c37d calc(var(--gre-pct, 0) * 1%), rgba(255, 255, 255, .16) 0);
}
.gre-fab-badge {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: -.2px;
    opacity: 0;
    transition: opacity .2s;
}
#gpt-rescue-btn.gre-progress .gre-fab-ring,
#gpt-rescue-btn.gre-progress .gre-fab-badge { opacity: 1; }
#gpt-rescue-btn.gre-progress .gre-fab-icon { opacity: 0; }
#gpt-rescue-btn.gre-busy .gre-fab-icon { opacity: 0; animation: gre-pulse 1.1s ease-in-out infinite; }
#gpt-rescue-btn.gre-done { color: #10a37f; }
#gpt-rescue-btn.gre-error { color: #ef4444; }
#gpt-rescue-btn.gre-done .gre-fab-icon,
#gpt-rescue-btn.gre-error .gre-fab-icon { opacity: 0; }
#gpt-rescue-btn.gre-done .gre-fab-badge,
#gpt-rescue-btn.gre-error .gre-fab-badge { opacity: 1; }

#gpt-rescue-btn.gre-collapsed-right { transform: translateX(58%); }
#gpt-rescue-btn.gre-collapsed-left { transform: translateX(-58%); }
#gpt-rescue-btn.gre-collapsed-right:hover,
#gpt-rescue-btn.gre-collapsed-left:hover,
#gpt-rescue-btn.gre-collapsed-right:focus-visible,
#gpt-rescue-btn.gre-collapsed-left:focus-visible,
#gpt-rescue-btn.gre-busy,
#gpt-rescue-btn.gre-progress,
#gpt-rescue-btn.gre-dragging { transform: none; }

@keyframes gre-pulse {
    0%, 100% { opacity: 0; }
    50% { opacity: 1; }
}

#gre-fab-status {
    position: fixed;
    z-index: 99997;
    max-width: 220px;
    padding: 5px 11px;
    border-radius: 999px;
    border: 1px solid rgba(0, 0, 0, .08);
    background: rgba(255, 255, 255, .92);
    color: #0d0d0d;
    -webkit-backdrop-filter: blur(10px);
    backdrop-filter: blur(10px);
    box-shadow: 0 2px 10px rgba(0, 0, 0, .14);
    font-size: 12px;
    font-weight: 500;
    line-height: 1.3;
    font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    opacity: 0;
    pointer-events: none;
    transition: opacity .2s;
}
#gre-fab-status.gre-visible { opacity: 1; }
html.dark #gre-fab-status {
    background: rgba(52, 53, 65, .94);
    border-color: rgba(255, 255, 255, .14);
    color: #ececec;
}
`;
        document.head.appendChild(style);
    }

    function createFabButton() {
        let btn = document.getElementById('gpt-rescue-btn');
        if (!btn) {
            btn = document.createElement('button');
            btn.id = 'gpt-rescue-btn';
            btn.type = 'button';
            document.body.appendChild(btn);
        }
        // 旧版为文字按钮：清掉遗留的内联样式与文案，重建悬浮球结构
        if (!btn.querySelector('.gre-fab-ring')) {
            btn.textContent = '';
            btn.removeAttribute('style');
            btn.setAttribute('aria-label', 'ChatGPT Exporter：导出对话');
            btn.innerHTML = `<span class="gre-fab-ring"></span><span class="gre-fab-icon">${FAB_ICON_SVG}</span><span class="gre-fab-badge"></span>`;
        }
        return btn;
    }

    function bindFabEvents(btn) {
        if (btn.dataset.fabBound === '1') return;
        btn.dataset.fabBound = '1';

        btn.addEventListener('pointerdown', (e) => {
            if (e.button !== 0 || btn.disabled) return;
            fabDragInfo = {
                id: e.pointerId,
                startX: e.clientX,
                startY: e.clientY,
                originX: fabState.x,
                originY: fabState.y,
                moved: false
            };
            try { btn.setPointerCapture(e.pointerId); } catch (_) {}
        });

        btn.addEventListener('pointermove', (e) => {
            if (!fabDragInfo || e.pointerId !== fabDragInfo.id) return;
            const dx = e.clientX - fabDragInfo.startX;
            const dy = e.clientY - fabDragInfo.startY;
            if (!fabDragInfo.moved) {
                if (Math.hypot(dx, dy) < FAB_DRAG_THRESHOLD) return;
                fabDragInfo.moved = true;
                btn.classList.add('gre-dragging');
                fabExpand(btn);
                document.getElementById('gre-fab-status')?.classList.remove('gre-visible');
            }
            fabApply(btn, fabClamp({ x: fabDragInfo.originX + dx, y: fabDragInfo.originY + dy }));
        });

        const endDrag = (e) => {
            if (!fabDragInfo || (e && e.pointerId !== fabDragInfo.id)) return;
            const wasMoved = fabDragInfo.moved;
            fabDragInfo = null;
            btn.classList.remove('gre-dragging');
            if (!wasMoved) return;
            fabSuppressClick = true;
            setTimeout(() => { fabSuppressClick = false; }, 100);
            fabApply(btn, fabSnap(fabClamp({ x: fabState.x, y: fabState.y })), true);
            fabScheduleCollapse(btn);
        };
        btn.addEventListener('pointerup', endDrag);
        btn.addEventListener('pointercancel', endDrag);

        btn.addEventListener('pointerenter', () => {
            clearTimeout(fabCollapseTimer);
            if (fabIsCollapsed(btn)) fabExpand(btn);
        });
        btn.addEventListener('pointerleave', () => fabScheduleCollapse(btn));

        btn.addEventListener('click', (e) => {
            if (fabSuppressClick) {
                fabSuppressClick = false;
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            // 触屏无 hover：收起状态下第一次点按仅展开
            if (fabIsCollapsed(btn)) {
                fabExpand(btn);
                fabScheduleCollapse(btn);
                return;
            }
            if (btn.classList.contains('gre-busy') || btn.classList.contains('gre-progress')) return;
            showExportDialog();
        });

        btn.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            fabExpand(btn);
            fabApply(btn, fabSnap(fabClamp(fabDefaultPosition())), true);
            const pill = fabStatusEl();
            pill.textContent = '已重置位置';
            pill.classList.add('gre-visible');
            fabPositionStatus(btn);
            setTimeout(() => {
                if (pill.textContent === '已重置位置') pill.classList.remove('gre-visible');
            }, 1500);
        });

        window.addEventListener('resize', () => {
            if (!document.body.contains(btn)) return;
            fabApply(btn, fabSnap(fabClamp({ x: fabState.x, y: fabState.y })), true);
        });
    }

    function getExportButton() {
        ensureFabStyle();
        const btn = createFabButton();
        bindFabEvents(btn);
        if (fabState.x == null) {
            const saved = loadFabState();
            fabApply(btn, fabSnap(fabClamp(saved ? { x: saved.x, y: saved.y } : fabDefaultPosition())));
            if (saved && saved.collapsed && fabState.docked) fabCollapse(btn);
        }
        if (!btn.disabled) setFabStatus(btn, EXPORT_BUTTON_LABEL);
        btn.dataset.exporterVersion = ATTACHMENT_EXPORT_VERSION;
        return btn;
    }

    function initFab() {
        if (!document.body) {
            setTimeout(initFab, 200);
            return;
        }
        getExportButton();
    }

    // --- 导出流程核心逻辑 ---

    // 从缓存记录恢复附件文件到 ZIP（文件二进制随记录一起缓存过）
    function restoreCachedAttachments(target, convData, record) {
        const attachmentResult = record.attachmentResult;
        const folder = target.folder(zipFolderName(convData));
        attachmentResult.files.forEach(file => {
            if (file?.data) folder.file(file.name, file.data);
        });
        return {
            ...attachmentResult,
            sandboxPaths: attachmentResult.sandboxPaths instanceof Map
                ? attachmentResult.sandboxPaths
                : new Map(Object.entries(attachmentResult.sandboxPaths || {}))
        };
    }

    // 返回 attachmentResult（含附件二进制），供断点续传缓存使用
    async function addConversationToZip(target, convData, workspaceId, report = null, cachedRecord = null) {
        target.file(generateUniqueFilename(convData), JSON.stringify(convData, null, 2));
        let attachmentResult = null;
        if (report) {
            attachmentResult = cachedRecord?.attachmentResult
                ? restoreCachedAttachments(target, convData, cachedRecord)
                : await appendAttachmentsToZip(target, convData, workspaceId);
            if (cachedRecord) report.cached = (report.cached || 0) + 1;
            report.detected += attachmentResult.detected;
            report.downloaded += attachmentResult.files.length;
            report.failed += attachmentResult.failures.length;
            report.conversations.push({
                conversation_id: convData?.conversation_id || null,
                title: convData?.title || 'Untitled Conversation',
                cached: Boolean(cachedRecord),
                detected: attachmentResult.detected,
                downloaded: attachmentResult.files.map(({ data, ...rest }) => rest),
                failures: attachmentResult.failures
            });
        }
        target.file(generateMarkdownFilename(convData), convertConversationToMarkdown(convData, attachmentResult));
        return attachmentResult;
    }

    async function exportConversations(options = {}) {
        const {
            mode = 'personal',
            workspaceId = null,
            conversationEntries = null,
            exportType = null,
            includeAttachments = false
        } = options;
        const btn = getExportButton();
        btn.disabled = true;

        if (!await ensureAccessToken()) {
            btn.disabled = false;
            setFabStatus(btn, EXPORT_BUTTON_LABEL);
            return;
        }

        // --- 断点续传：检测上次未完成导出的本地缓存 ---
        const sessionKey = getSessionKey(mode, workspaceId, includeAttachments);
        let resumeEnabled = false;
        try {
            const cachedCount = await resumeCountRecords(sessionKey);
            if (cachedCount > 0) {
                resumeEnabled = confirm(
                    `检测到上次导出未完成，本地已缓存 ${cachedCount} 个对话。\n` +
                    '是否断点续传？将跳过已缓存的对话，只补抓剩余部分。\n' +
                    '（点击“取消”将清除缓存并重新导出全部）'
                );
                if (!resumeEnabled) {
                    await resumeClearSession(sessionKey);
                }
            }
        } catch (err) {
            console.warn('[ChatGPT Exporter] 断点续传缓存不可用:', err);
        }

        // 单个对话失败只记录并跳过，不再中断整个导出；失败部分可通过续传补抓
        const failedConversations = [];
        let reusedCount = 0;
        let savedThisRun = 0;

        try {
            const zip = new JSZip();
            const attachmentReport = includeAttachments ? {
                exporter_version: ATTACHMENT_EXPORT_VERSION,
                generated_at: new Date().toISOString(),
                detected: 0,
                downloaded: 0,
                failed: 0,
                cached: 0,
                conversations: []
            } : null;

            const tasks = [];
            if (Array.isArray(conversationEntries) && conversationEntries.length > 0) {
                conversationEntries.forEach(entry => {
                    tasks.push({
                        id: entry.id,
                        projectTitle: entry?.projectTitle || null,
                        label: entry?.title ? entry.title.slice(0, 12) : '对话'
                    });
                });
            } else {
                setFabStatus(btn, '📂 获取项目外对话…');
                const orphanIds = await collectIds(btn, workspaceId, null);
                orphanIds.forEach(id => tasks.push({ id, projectTitle: null, label: '根目录' }));

                setFabStatus(btn, '🔍 获取项目列表…');
                const projects = await getProjects(workspaceId);
                for (const project of projects) {
                    setFabStatus(btn, `📂 项目: ${project.title}`);
                    const projectConvIds = await collectIds(btn, workspaceId, project.id);
                    projectConvIds.forEach(id => tasks.push({ id, projectTitle: project.title, label: project.title }));
                }
            }

            for (let i = 0; i < tasks.length; i++) {
                const task = tasks[i];
                setFabStatus(btn, `📥 ${task.label.slice(0, 12)} (${i + 1}/${tasks.length})`);

                let cachedRecord = null;
                if (resumeEnabled) {
                    try { cachedRecord = await resumeGetRecord(sessionKey, task.id); } catch (_) {}
                }

                let convData;
                if (cachedRecord?.convData) {
                    convData = cachedRecord.convData;
                    reusedCount++;
                } else {
                    try {
                        convData = await getConversation(task.id, workspaceId);
                    } catch (error) {
                        console.error(`[ChatGPT Exporter] 获取对话失败 ${task.id}:`, error);
                        failedConversations.push({ id: task.id, title: task.label, error: error?.message || String(error) });
                        continue;
                    }
                }

                const target = task.projectTitle ? zip.folder(sanitizeFilename(task.projectTitle)) : zip;
                const attachmentResult = await addConversationToZip(target, convData, workspaceId, attachmentReport, cachedRecord);

                if (!cachedRecord) {
                    try {
                        await resumeSaveRecord(sessionKey, {
                            id: task.id,
                            title: convData?.title || task.label,
                            projectTitle: task.projectTitle,
                            fetchedAt: new Date().toISOString(),
                            convData,
                            attachmentResult: attachmentResult || null
                        });
                        savedThisRun++;
                    } catch (err) {
                        console.warn('[ChatGPT Exporter] 缓存对话失败（不影响导出继续）:', err);
                    }
                }
                await sleep(jitter());
            }

            if (attachmentReport) {
                zip.file('attachment-export-report.json', JSON.stringify(attachmentReport, null, 2));
            }
            setFabStatus(btn, '📦 生成 ZIP 文件…');
            const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
            const date = new Date().toISOString().slice(0, 10);
            const selectionType = exportType || ((Array.isArray(conversationEntries) && conversationEntries.length > 0) ? 'selected' : 'full');
            let filename = '';
            if (selectionType === 'selected') {
                filename = mode === 'team'
                    ? `chatgpt_team_selected_${workspaceId}_${date}.zip`
                    : mode === 'project'
                        ? `chatgpt_project_selected_${date}.zip`
                        : `chatgpt_personal_selected_${date}.zip`;
            } else {
                filename = mode === 'team'
                    ? `chatgpt_team_backup_${workspaceId}_${date}.zip`
                    : mode === 'project'
                        ? `chatgpt_project_backup_${date}.zip`
                        : `chatgpt_personal_backup_${date}.zip`;
            }
            downloadFile(blob, filename);
            // 全部成功才清缓存；有失败时保留，下次导出同一空间即可续传补抓
            if (failedConversations.length === 0) {
                try { await resumeClearSession(sessionKey); } catch (_) {}
            }
            const attachmentSummary = attachmentReport
                ? `\n附件：检测 ${attachmentReport.detected}，成功 ${attachmentReport.downloaded}，失败 ${attachmentReport.failed}。`
                : '';
            const cacheSummary = reusedCount > 0 ? `\n♻️ 断点续传：复用本地缓存 ${reusedCount} 个对话。` : '';
            const failureSummary = failedConversations.length > 0
                ? `\n⚠️ ${failedConversations.length} 个对话获取失败已跳过（列表见控制台）。重新导出同一空间时将自动断点续传，仅补抓失败部分。`
                : '';
            if (failedConversations.length > 0) {
                console.warn('[ChatGPT Exporter] 以下对话获取失败，可稍后通过续传补抓:', failedConversations);
            }
            alert(`✅ 导出完成！${cacheSummary}${attachmentSummary}${failureSummary}`);
            setFabStatus(btn, '✅ 完成');

        } catch (e) {
            console.error("导出过程中发生严重错误:", e);
            const resumeHint = (reusedCount + savedThisRun) > 0
                ? '\n已完成部分的缓存已保留，重新导出同一空间时将提示断点续传。'
                : '';
            alert(`导出失败: ${e.message}。${resumeHint}\n详情请查看控制台（F12 -> Console）。`);
            setFabStatus(btn, '⚠️ Error');
        } finally {
            setTimeout(() => {
                btn.disabled = false;
                setFabStatus(btn, EXPORT_BUTTON_LABEL);
            }, 3000);
        }
    }

    async function startExportProcess(mode, workspaceId, includeAttachments = false) {
        await exportConversations({ mode, workspaceId, includeAttachments });
    }

    async function startProjectSpaceExportProcess(workspaceId = null, includeAttachments = false) {
        try {
            const projectEntries = await listProjectSpaceConversations(workspaceId);
            if (projectEntries.length === 0) {
                alert('未找到项目空间对话。');
                return;
            }
            await exportConversations({
                mode: 'project',
                workspaceId,
                conversationEntries: projectEntries,
                exportType: 'full',
                includeAttachments
            });
        } catch (err) {
            console.error('导出项目空间失败:', err);
            alert(`导出项目空间失败: ${err.message}`);
        }
    }

    async function startSelectiveExportProcess(mode, workspaceId, conversationEntries, includeAttachments = false) {
        await exportConversations({ mode, workspaceId, conversationEntries, includeAttachments });
    }

    function startScheduledExport(options = {}) {
        const {
            mode = 'personal',
            workspaceId = null,
            autoConfirm = false,
            source = 'schedule',
            includeAttachments = false
        } = options;
        const proceed = async () => {
            try {
                if (mode === 'project') {
                    await startProjectSpaceExportProcess(workspaceId, includeAttachments);
                } else {
                    await startExportProcess(mode, workspaceId, includeAttachments);
                }
            } catch (err) {
                console.error('[ChatGPT Exporter] 自动导出失败:', err);
            }
        };

        if (autoConfirm) {
            proceed();
            return;
        }

        const modeLabel = mode === 'team' ? '团队空间' : mode === 'project' ? '项目空间' : '个人空间';
        if (confirm(`Chrome 扩展请求导出 ${modeLabel} 对话（来源: ${source}）。是否开始？`)) {
            proceed();
        }
    }

    // --- API 调用函数 ---
    function normalizeProjectSpaceItem(item) {
        const rawGizmo = item?.gizmo?.gizmo || item?.gizmo || item;
        const display = rawGizmo?.display || item?.gizmo?.display || item?.display;
        const id = rawGizmo?.id || item?.gizmo?.id || item?.id;
        const title = display?.name || rawGizmo?.name || 'Untitled Project';
        if (!id) return null;
        return {
            id,
            title,
            conversations: item?.conversations?.items || []
        };
    }

    function resolveWorkspaceId(workspaceId) {
        if (workspaceId) return workspaceId;
        const match = document.cookie.match(/(?:^|; )_account=([^;]+)/);
        if (match?.[1]) return match[1];
        const detectedIds = detectAllWorkspaceIds();
        return detectedIds.length > 0 ? detectedIds[0] : null;
    }

    async function getProjectSpaces(workspaceId, options = {}) {
        const deviceId = getOaiDeviceId();
        if (!deviceId) {
            throw new Error('无法获取 oai-device-id，请确保已登录并刷新页面。');
        }
        const headers = {
            'Authorization': `Bearer ${accessToken}`,
            'oai-device-id': deviceId
        };
        const resolvedWorkspaceId = resolveWorkspaceId(workspaceId);
        if (resolvedWorkspaceId) { headers['ChatGPT-Account-Id'] = resolvedWorkspaceId; }

        const projects = new Map();
        let cursor = null;

        do {
            const query = new URLSearchParams();
            query.set('limit', String(PROJECT_SIDEBAR_LIMIT));
            if (options.conversationsPerGizmo !== undefined) {
                query.set('conversations_per_gizmo', String(options.conversationsPerGizmo));
            }
            if (options.ownedOnly !== undefined) {
                query.set('owned_only', options.ownedOnly ? 'true' : 'false');
            }
            if (cursor) {
                query.set('cursor', cursor);
            }

            const r = await apiFetch(`/backend-api/gizmos/snorlax/sidebar?${query.toString()}`, { headers }, '项目空间列表');
            if (!r.ok) {
                throw new Error(`获取项目空间列表失败 (${r.status})`);
            }
            const data = await r.json();
            data.items?.forEach(item => {
                const project = normalizeProjectSpaceItem(item);
                if (project) {
                    projects.set(project.id, project);
                }
            });
            cursor = data.cursor || null;
            if (cursor) {
                await sleep(jitter());
            }
        } while (cursor);

        return Array.from(projects.values());
    }

    async function getProjects(workspaceId) {
        if (!workspaceId) return [];
        try {
            const projects = await getProjectSpaces(workspaceId);
            return projects.map(({ id, title }) => ({ id, title }));
        } catch (err) {
            console.warn(`获取项目(Gizmo)列表失败 (${err?.message || err})`);
            return [];
        }
    }

    async function collectIds(btn, workspaceId, gizmoId) {
        const all = new Set();
        const deviceId = getOaiDeviceId();
        if (!deviceId) {
            throw new Error('无法获取 oai-device-id，请确保已登录并刷新页面。');
        }
        const headers = {
            'Authorization': `Bearer ${accessToken}`,
            'oai-device-id': deviceId
        };
        if (workspaceId) { headers['ChatGPT-Account-Id'] = workspaceId; }

        if (gizmoId) {
            let cursor = '0';
            do {
                const r = await apiFetch(`/backend-api/gizmos/${gizmoId}/conversations?cursor=${cursor}`, { headers }, `项目对话列表 ${gizmoId}`);
                if (!r.ok) throw new Error(`列举项目对话列表失败 (${r.status})`);
                const j = await r.json();
                j.items?.forEach(it => all.add(it.id));
                cursor = j.cursor;
                await sleep(jitter());
            } while (cursor);
        } else {
            for (const is_archived of [false, true]) {
                let offset = 0, has_more = true, page = 0;
                do {
                    setFabStatus(btn, `📂 项目外对话 (${is_archived ? 'Archived' : 'Active'} p${++page})`);
                    const r = await apiFetch(`/backend-api/conversations?offset=${offset}&limit=${PAGE_LIMIT}&order=updated${is_archived ? '&is_archived=true' : ''}`, { headers }, '对话列表');
                    if (!r.ok) throw new Error(`列举项目外对话列表失败 (${r.status})`);
                    const j = await r.json();
                    if (j.items && j.items.length > 0) {
                        j.items.forEach(it => all.add(it.id));
                        has_more = j.items.length === PAGE_LIMIT;
                        offset += j.items.length;
                    } else {
                        has_more = false;
                    }
                    await sleep(jitter());
                } while (has_more);
            }
        }
        return Array.from(all);
    }

    function upsertConversationEntry(map, item, extra = {}) {
        if (!item?.id) return;
        const create_time = normalizeEpochSeconds(item.create_time || 0);
        const update_time = normalizeEpochSeconds(item.update_time || item.create_time || 0);
        const entry = {
            id: item.id,
            title: item.title || 'Untitled Conversation',
            create_time,
            update_time,
            is_archived: item.is_archived ?? extra.is_archived ?? false,
            projectId: extra.projectId || null,
            projectTitle: extra.projectTitle || null
        };
        const existing = map.get(entry.id);
        if (!existing) {
            map.set(entry.id, entry);
            return;
        }
        if (!existing.projectTitle && entry.projectTitle) {
            existing.projectTitle = entry.projectTitle;
            existing.projectId = entry.projectId;
        }
        if (!existing.create_time && entry.create_time) {
            existing.create_time = entry.create_time;
        }
        existing.is_archived = existing.is_archived || entry.is_archived;
        if ((entry.update_time || 0) > (existing.update_time || 0)) {
            existing.update_time = entry.update_time;
        }
        if (existing.title === 'Untitled Conversation' && entry.title) {
            existing.title = entry.title;
        }
    }

    async function listConversations(workspaceId) {
        if (!await ensureAccessToken()) {
            throw new Error('无法获取 Access Token，请刷新页面或打开任意一个对话后再试。');
        }

        const deviceId = getOaiDeviceId();
        if (!deviceId) {
            throw new Error('无法获取 oai-device-id，请确保已登录并刷新页面。');
        }

        const headers = {
            'Authorization': `Bearer ${accessToken}`,
            'oai-device-id': deviceId
        };
        if (workspaceId) { headers['ChatGPT-Account-Id'] = workspaceId; }

        const map = new Map();
        const addEntry = (item, extra = {}) => upsertConversationEntry(map, item, extra);

        for (const is_archived of [false, true]) {
            let offset = 0;
            let has_more = true;
            do {
                const r = await apiFetch(`/backend-api/conversations?offset=${offset}&limit=${PAGE_LIMIT}&order=updated${is_archived ? '&is_archived=true' : ''}`, { headers }, '对话列表');
                if (!r.ok) throw new Error(`列举对话列表失败 (${r.status})`);
                const j = await r.json();
                if (j.items && j.items.length > 0) {
                    j.items.forEach(it => addEntry(it, { is_archived }));
                    has_more = j.items.length === PAGE_LIMIT;
                    offset += j.items.length;
                } else {
                    has_more = false;
                }
                await sleep(jitter());
            } while (has_more);
        }

        if (workspaceId) {
            const projects = await getProjects(workspaceId);
            for (const project of projects) {
                let cursor = '0';
                do {
                    const r = await apiFetch(`/backend-api/gizmos/${project.id}/conversations?cursor=${cursor}`, { headers }, `项目对话列表 ${project.title}`);
                    if (!r.ok) throw new Error(`列举项目对话列表失败 (${r.status})`);
                    const j = await r.json();
                    j.items?.forEach(it => addEntry(it, { projectId: project.id, projectTitle: project.title }));
                    cursor = j.cursor;
                    await sleep(jitter());
                } while (cursor);
            }
        }

        return Array.from(map.values())
            .sort((a, b) => (b.update_time || 0) - (a.update_time || 0));
    }

    async function listProjectSpaceConversations(workspaceId) {
        if (!await ensureAccessToken()) {
            throw new Error('无法获取 Access Token，请刷新页面或打开任意一个对话后再试。');
        }

        const deviceId = getOaiDeviceId();
        if (!deviceId) {
            throw new Error('无法获取 oai-device-id，请确保已登录并刷新页面。');
        }

        const headers = {
            'Authorization': `Bearer ${accessToken}`,
            'oai-device-id': deviceId
        };
        const resolvedWorkspaceId = resolveWorkspaceId(workspaceId);
        if (resolvedWorkspaceId) { headers['ChatGPT-Account-Id'] = resolvedWorkspaceId; }

        const map = new Map();
        const projects = await getProjectSpaces(resolvedWorkspaceId, { conversationsPerGizmo: PROJECT_SIDEBAR_PREVIEW, ownedOnly: true });

        for (const project of projects) {
            let cursor = '0';
            let fetched = false;
            do {
                const r = await apiFetch(`/backend-api/gizmos/${project.id}/conversations?cursor=${cursor}`, { headers }, `项目空间对话列表 ${project.title}`);
                if (!r.ok) {
                    if (!fetched && Array.isArray(project.conversations) && project.conversations.length > 0) {
                        console.warn(`项目空间对话列表请求失败 (${r.status})，使用侧边栏返回的预览对话。`);
                        project.conversations.forEach(item => upsertConversationEntry(map, item, {
                            projectId: project.id,
                            projectTitle: project.title
                        }));
                        cursor = null;
                        break;
                    }
                    throw new Error(`列举项目空间对话列表失败 (${r.status})`);
                }
                const j = await r.json();
                j.items?.forEach(item => upsertConversationEntry(map, item, {
                    projectId: project.id,
                    projectTitle: project.title
                }));
                cursor = j.cursor;
                fetched = true;
                await sleep(jitter());
            } while (cursor);
        }

        return Array.from(map.values())
            .sort((a, b) => (b.update_time || 0) - (a.update_time || 0));
    }

    async function getConversation(id, workspaceId) {
        const deviceId = getOaiDeviceId();
        if (!deviceId) {
            throw new Error('无法获取 oai-device-id，请确保已登录并刷新页面。');
        }
        const headers = {
            'Authorization': `Bearer ${accessToken}`,
            'oai-device-id': deviceId
        };
        const resolvedWorkspaceId = resolveWorkspaceId(workspaceId);
        if (resolvedWorkspaceId) { headers['ChatGPT-Account-Id'] = resolvedWorkspaceId; }
        const r = await apiFetch(`/backend-api/conversation/${id}`, { headers }, `对话详情 ${id}`);
        if (!r.ok) {
            if (r.status === 429) {
                const retryNote = r.__rateLimitRetries > 0 ? `已自动退避重试 ${r.__rateLimitRetries} 次仍被限流，` : '';
                throw new Error(`获取对话详情失败 conv ${id}：官方接口限流 (429)，${retryNote}请降低导出频率、减少单次导出的对话数量，等待几分钟后再试。`);
            }
            throw new Error(`获取对话详情失败 conv ${id} (${r.status})`);
        }
        const j = await r.json();
        j.__fetched_at = new Date().toISOString();
        return j;
    }

    // --- UI 相关函数 ---
    // (UI部分无变动，此处省略以保持简洁)
    /**
     * [新增] 全面检测函数，返回所有找到的ID
     * @returns {string[]} - 返回包含所有唯一Workspace ID的数组
     */
    function detectAllWorkspaceIds() {
        const foundIds = new Set(capturedWorkspaceIds); // 从网络拦截的结果开始

        // 扫描 __NEXT_DATA__
        try {
            const data = JSON.parse(document.getElementById('__NEXT_DATA__').textContent);
            // 遍历所有账户信息
            const accounts = data?.props?.pageProps?.user?.accounts;
            if (accounts) {
                Object.values(accounts).forEach(acc => {
                    if (acc?.account?.id) {
                        foundIds.add(acc.account.id);
                    }
                });
            }
        } catch (e) {}

        // 扫描 localStorage
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && (key.includes('account') || key.includes('workspace'))) {
                    const value = localStorage.getItem(key);
                    if (value && /^[a-z0-9]{2,}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.replace(/"/g, ''))) {
                         const extractedId = value.match(/ws-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
                         if(extractedId) foundIds.add(extractedId[0]);
                    } else if (value && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.replace(/"/g, ''))) {
                         foundIds.add(value.replace(/"/g, ''));
                    }
                }
            }
        } catch(e) {}

        console.log('🔍 检测到以下 Workspace IDs:', Array.from(foundIds));
        return Array.from(foundIds);
    }

    function showConversationPicker(options = {}) {
        const { mode = 'personal', workspaceId = null, includeAttachments = false } = options;
        const existing = document.getElementById('export-dialog-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'export-dialog-overlay';
        Object.assign(overlay.style, {
            position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
            backgroundColor: 'rgba(0, 0, 0, 0.5)', zIndex: '99998',
            display: 'flex', alignItems: 'center', justifyContent: 'center'
        });

        const dialog = document.createElement('div');
        dialog.id = 'export-dialog';
        Object.assign(dialog.style, {
            background: '#fff', padding: '24px', borderRadius: '12px',
            boxShadow: '0 5px 15px rgba(0,0,0,.3)', width: '720px',
            fontFamily: 'sans-serif', color: '#333', boxSizing: 'border-box'
        });

        const closeDialog = () => document.body.removeChild(overlay);
        const state = {
            list: [],
            filtered: [],
            selected: new Set(),
            query: '',
            scope: mode === 'project' ? 'project' : 'all',
            scopeLocked: mode === 'project',
            archived: 'all',
            timeField: 'update',
            loading: true,
            pageSize: 100,
            visibleCount: 100,
            startDate: '',
            endDate: '',
            includeAttachments: Boolean(includeAttachments)
        };

        const renderBase = () => {
            const modeLabel = mode === 'team' ? '团队空间' : mode === 'project' ? '项目空间' : '个人空间';
            const workspaceLabel = workspaceId ? `（${workspaceId}）` : '';
            dialog.innerHTML = `
                <h2 style="margin-top:0; margin-bottom: 12px; font-size: 18px;">选择要导出的对话</h2>
                <div style="margin-bottom: 12px; color: #666; font-size: 12px;">空间：${modeLabel}${workspaceLabel}</div>
                <div style="display: flex; gap: 8px; margin-bottom: 8px;">
                    <input id="conv-search" type="text" placeholder="搜索标题/项目名/ID"
                        style="flex: 1; padding: 8px; border-radius: 6px; border: 1px solid #ccc; box-sizing: border-box;">
                    <select id="filter-scope" style="padding: 8px 28px 8px 8px; border-radius: 6px; border: 1px solid #ccc;">
                        <option value="all">全部范围</option>
                        <option value="project">仅项目</option>
                        <option value="root">仅项目外</option>
                    </select>
                    <select id="filter-archived" style="padding: 8px 28px 8px 8px; border-radius: 6px; border: 1px solid #ccc;">
                        <option value="all">全部状态</option>
                        <option value="active">仅未归档</option>
                        <option value="archived">仅已归档</option>
                    </select>
                </div>
                <div style="display: flex; gap: 8px; margin-bottom: 8px; align-items: center;">
                    <select id="filter-time-field" style="padding: 8px 28px 8px 8px; border-radius: 6px; border: 1px solid #ccc;">
                        <option value="update">按更新时间</option>
                        <option value="create">按创建时间</option>
                    </select>
                    <input id="filter-start-date" type="date" style="padding: 8px; border-radius: 6px; border: 1px solid #ccc;">
                    <span style="color: #666; font-size: 12px;">至</span>
                    <input id="filter-end-date" type="date" style="padding: 8px; border-radius: 6px; border: 1px solid #ccc;">
                    <button id="clear-date-btn" style="padding: 8px 12px; border: 1px solid #ccc; border-radius: 6px; background: #fff; cursor: pointer;">清空日期</button>
                </div>
                <label style="display: flex; align-items: flex-start; gap: 8px; margin-bottom: 10px; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 8px; background: #f9fafb; cursor: pointer;">
                    <input id="include-attachments-picker" type="checkbox" ${state.includeAttachments ? 'checked' : ''} style="margin-top: 2px;">
                    <span>
                        <strong style="display: block; font-size: 13px;">同时下载上传和生成的附件</strong>
                        <span style="display: block; margin-top: 2px; color: #666; font-size: 12px;">默认关闭；开启后导出时间和 ZIP 体积可能明显增加。</span>
                    </span>
                </label>
                <div id="conv-status" style="margin-bottom: 8px; font-size: 12px; color: #666;">正在加载列表...</div>
                <div id="conv-list" style="max-height: 360px; overflow: auto; border: 1px solid #e5e7eb; border-radius: 8px; padding: 8px; background: #fff;"></div>
                <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 16px;">
                    <div style="display: flex; gap: 8px;">
                        <button id="select-all-btn" style="padding: 8px 12px; border: 1px solid #ccc; border-radius: 6px; background: #fff; cursor: pointer;">全选</button>
                        <button id="clear-all-btn" style="padding: 8px 12px; border: 1px solid #ccc; border-radius: 6px; background: #fff; cursor: pointer;">清空</button>
                    </div>
                    <div style="display: flex; gap: 8px;">
                        <button id="back-btn" style="padding: 8px 12px; border: 1px solid #ccc; border-radius: 6px; background: #fff; cursor: pointer;">返回</button>
                        <button id="export-selected-btn" style="padding: 8px 12px; border: none; border-radius: 6px; background: #10a37f; color: #fff; cursor: pointer; font-weight: bold;" disabled>导出选中 (0)</button>
                    </div>
                </div>
            `;

            const searchInput = dialog.querySelector('#conv-search');
            const scopeSelect = dialog.querySelector('#filter-scope');
            const archivedSelect = dialog.querySelector('#filter-archived');
            const timeFieldSelect = dialog.querySelector('#filter-time-field');
            const startDateInput = dialog.querySelector('#filter-start-date');
            const endDateInput = dialog.querySelector('#filter-end-date');
            const includeAttachmentsInput = dialog.querySelector('#include-attachments-picker');
            const clearDateBtn = dialog.querySelector('#clear-date-btn');
            const selectAllBtn = dialog.querySelector('#select-all-btn');
            const clearAllBtn = dialog.querySelector('#clear-all-btn');
            const backBtn = dialog.querySelector('#back-btn');
            const exportBtn = dialog.querySelector('#export-selected-btn');

            if (state.scopeLocked && scopeSelect) {
                scopeSelect.value = 'project';
                scopeSelect.disabled = true;
                scopeSelect.style.opacity = '0.7';
                scopeSelect.style.cursor = 'not-allowed';
                scopeSelect.title = '项目空间仅包含项目对话';
            }

            searchInput.oninput = (e) => {
                state.query = e.target.value || '';
                applyFilters();
                renderList();
            };
            scopeSelect.onchange = (e) => {
                state.scope = e.target.value;
                applyFilters();
                renderList();
            };
            archivedSelect.onchange = (e) => {
                state.archived = e.target.value;
                applyFilters();
                renderList();
            };
            timeFieldSelect.onchange = (e) => {
                state.timeField = e.target.value;
                applyFilters();
                renderList();
            };
            startDateInput.onchange = (e) => {
                state.startDate = e.target.value || '';
                applyFilters();
                renderList();
            };
            endDateInput.onchange = (e) => {
                state.endDate = e.target.value || '';
                applyFilters();
                renderList();
            };
            clearDateBtn.onclick = () => {
                state.startDate = '';
                state.endDate = '';
                startDateInput.value = '';
                endDateInput.value = '';
                applyFilters();
                renderList();
            };
            includeAttachmentsInput.onchange = (e) => {
                state.includeAttachments = e.target.checked;
            };
            selectAllBtn.onclick = () => {
                state.filtered.forEach(item => state.selected.add(item.id));
                renderList();
            };
            clearAllBtn.onclick = () => {
                state.selected.clear();
                renderList();
            };
            backBtn.onclick = () => {
                closeDialog();
                showExportDialog({ includeAttachments: state.includeAttachments });
            };
            exportBtn.onclick = async () => {
                if (state.selected.size === 0) return;
                const selectedList = state.list.filter(item => state.selected.has(item.id));
                closeDialog();
                await startSelectiveExportProcess(mode, workspaceId, selectedList, state.includeAttachments);
            };
        };

        const applyFilters = () => {
            const query = state.query.trim().toLowerCase();
            const startBound = parseDateInputToEpoch(state.startDate, false);
            const endBound = parseDateInputToEpoch(state.endDate, true);
            state.filtered = state.list.filter(item => {
                const text = `${item.title || ''} ${item.projectTitle || ''} ${item.id || ''}`.toLowerCase();
                if (query && !text.includes(query)) return false;
                if (state.scope === 'project' && !item.projectTitle) return false;
                if (state.scope === 'root' && item.projectTitle) return false;
                if (state.archived === 'active' && item.is_archived) return false;
                if (state.archived === 'archived' && !item.is_archived) return false;
                if (startBound || endBound) {
                    const sourceTime = state.timeField === 'create'
                        ? item.create_time
                        : item.update_time;
                    const ts = normalizeEpochSeconds(sourceTime || 0);
                    if (!ts) return false;
                    if (startBound && ts < startBound) return false;
                    if (endBound && ts > endBound) return false;
                }
                return true;
            });
            state.visibleCount = state.pageSize;
        };

        const renderList = () => {
            const statusEl = dialog.querySelector('#conv-status');
            const listEl = dialog.querySelector('#conv-list');
            const exportBtn = dialog.querySelector('#export-selected-btn');
            const selectAllBtn = dialog.querySelector('#select-all-btn');
            const clearAllBtn = dialog.querySelector('#clear-all-btn');
            const controlsDisabled = state.loading;

            if (selectAllBtn) selectAllBtn.disabled = controlsDisabled;
            if (clearAllBtn) clearAllBtn.disabled = controlsDisabled;
            if (exportBtn) exportBtn.disabled = controlsDisabled || state.selected.size === 0;

            listEl.innerHTML = '';
            if (state.loading) {
                statusEl.textContent = '正在加载列表...';
                return;
            }

            const visibleCount = Math.min(state.visibleCount, state.filtered.length);
            statusEl.textContent = `共 ${state.list.length} 条，当前筛选 ${state.filtered.length} 条，显示 ${visibleCount} 条，已选 ${state.selected.size} 条`;
            exportBtn.textContent = `导出选中 (${state.selected.size})`;

            if (state.filtered.length === 0) {
                const empty = document.createElement('div');
                empty.textContent = '没有匹配的对话。';
                empty.style.color = '#999';
                empty.style.padding = '8px 4px';
                listEl.appendChild(empty);
                return;
            }

            const visibleItems = state.filtered.slice(0, state.visibleCount);
            visibleItems.forEach(item => {
                const label = document.createElement('label');
                Object.assign(label.style, {
                    display: 'flex', gap: '8px', padding: '8px',
                    border: '1px solid #e5e7eb', borderRadius: '6px',
                    marginBottom: '8px', cursor: 'pointer', alignItems: 'flex-start'
                });

                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.checked = state.selected.has(item.id);
                checkbox.onchange = (e) => {
                    if (e.target.checked) {
                        state.selected.add(item.id);
                    } else {
                        state.selected.delete(item.id);
                    }
                    renderList();
                };

                const content = document.createElement('div');
                content.style.flex = '1';

                const title = document.createElement('div');
                title.textContent = item.title || 'Untitled Conversation';
                title.style.fontWeight = 'bold';
                title.style.fontSize = '14px';

                const meta = document.createElement('div');
                meta.style.fontSize = '12px';
                meta.style.color = '#666';
                const timeLabelPrefix = state.timeField === 'create' ? '创建' : '更新';
                const timeValue = state.timeField === 'create' ? item.create_time : item.update_time;
                const timeLabel = formatTimestamp(timeValue) || '未知';
                meta.textContent = `${timeLabelPrefix}: ${timeLabel}`;

                const tags = document.createElement('div');
                tags.style.marginTop = '6px';
                tags.style.display = 'flex';
                tags.style.gap = '6px';
                tags.style.flexWrap = 'wrap';

                if (item.projectTitle) {
                    const projectTag = document.createElement('span');
                    projectTag.textContent = `项目: ${item.projectTitle}`;
                    Object.assign(projectTag.style, {
                        background: '#eef2ff', color: '#4338ca',
                        padding: '2px 6px', borderRadius: '999px', fontSize: '11px'
                    });
                    tags.appendChild(projectTag);
                }

                if (item.is_archived) {
                    const archivedTag = document.createElement('span');
                    archivedTag.textContent = '已归档';
                    Object.assign(archivedTag.style, {
                        background: '#fef3c7', color: '#92400e',
                        padding: '2px 6px', borderRadius: '999px', fontSize: '11px'
                    });
                    tags.appendChild(archivedTag);
                }

                content.appendChild(title);
                content.appendChild(meta);
                if (tags.childNodes.length > 0) content.appendChild(tags);

                label.appendChild(checkbox);
                label.appendChild(content);
                listEl.appendChild(label);
            });

            if (state.filtered.length > state.visibleCount) {
                const loadMore = document.createElement('button');
                loadMore.textContent = `加载更多（剩余 ${state.filtered.length - state.visibleCount} 条）`;
                Object.assign(loadMore.style, {
                    width: '100%', padding: '8px 12px', border: '1px solid #ccc',
                    borderRadius: '6px', background: '#fff', cursor: 'pointer'
                });
                loadMore.onclick = () => {
                    state.visibleCount = Math.min(state.visibleCount + state.pageSize, state.filtered.length);
                    renderList();
                };
                listEl.appendChild(loadMore);
            }
        };

        renderBase();
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        overlay.onclick = (e) => { if (e.target === overlay) closeDialog(); };

        const listPromise = mode === 'project'
            ? listProjectSpaceConversations(workspaceId)
            : listConversations(workspaceId);
        listPromise
            .then(list => {
                state.list = list;
                state.loading = false;
                applyFilters();
                renderList();
            })
            .catch(err => {
                const statusEl = dialog.querySelector('#conv-status');
                state.loading = false;
                state.list = [];
                state.filtered = [];
                statusEl.textContent = `加载失败: ${err.message}`;
                renderList();
            });
    }

    /**
     * [重构] 多步骤、用户主导的导出对话框
     */
    function showExportDialog(options = {}) {
        if (document.getElementById('export-dialog-overlay')) return;

        const overlay = document.createElement('div');
        overlay.id = 'export-dialog-overlay';
        Object.assign(overlay.style, {
            position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
            backgroundColor: 'rgba(0, 0, 0, 0.5)', zIndex: '99998',
            display: 'flex', alignItems: 'center', justifyContent: 'center'
        });

        const dialog = document.createElement('div');
        dialog.id = 'export-dialog';
        Object.assign(dialog.style, {
            background: '#fff', padding: '24px', borderRadius: '12px',
            boxShadow: '0 5px 15px rgba(0,0,0,.3)', width: '450px',
            fontFamily: 'sans-serif', color: '#333', boxSizing: 'border-box'
        });

        const closeDialog = () => document.body.removeChild(overlay);

        let pendingTeamAction = null;
        let includeAttachments = Boolean(options.includeAttachments);
        const renderStep = (step, action = null) => {
            pendingTeamAction = action;
            let html = '';
            switch (step) {
                case 'team': {
                    const detectedIds = detectAllWorkspaceIds();
                    html = `<h2 style="margin-top:0; margin-bottom: 20px; font-size: 18px;">导出团队空间</h2>`;

                    if (detectedIds.length > 1) {
                        html += `<div style="background: #eef2ff; border: 1px solid #818cf8; border-radius: 8px; padding: 12px; margin-bottom: 20px;">
                                     <p style="margin: 0 0 12px 0; font-weight: bold; color: #4338ca;">🔎 检测到多个 Workspace，请选择一个:</p>
                                     <div id="workspace-id-list">`;
                        detectedIds.forEach((id, index) => {
                            html += `<label style="display: block; margin-bottom: 8px; padding: 8px; border-radius: 6px; cursor: pointer; border: 1px solid #ddd; background: #fff;">
                                         <input type="radio" name="workspace_id" value="${id}" ${index === 0 ? 'checked' : ''}>
                                         <code style="margin-left: 8px; font-family: monospace; color: #555;">${id}</code>
                                      </label>`;
                        });
                        html += `</div></div>`;
                    } else if (detectedIds.length === 1) {
                        html += `<div style="background: #f0fdf4; border: 1px solid #4ade80; border-radius: 8px; padding: 12px; margin-bottom: 20px;">
                                     <p style="margin: 0 0 8px 0; font-weight: bold; color: #166534;">✅ 已自动检测到 Workspace ID:</p>
                                     <code id="workspace-id-code" style="background: #e0e7ff; padding: 4px 8px; border-radius: 4px; font-family: monospace; color: #4338ca; word-break: break-all;">${detectedIds[0]}</code>
                                   </div>`;
                    } else {
                        html += `<div style="background: #fffbeb; border: 1px solid #facc15; border-radius: 8px; padding: 12px; margin-bottom: 20px;">
                                     <p style="margin: 0; color: #92400e;">⚠️ 未能自动检测到 Workspace ID。</p>
                                     <p style="margin: 8px 0 0 0; font-size: 12px; color: #92400e;">请尝试刷新页面或打开一个团队对话，或在下方手动输入。</p>
                                   </div>
                                   <label for="team-id-input" style="display: block; margin-bottom: 8px; font-weight: bold;">手动输入 Team Workspace ID:</label>
                                   <input type="text" id="team-id-input" placeholder="粘贴您的 Workspace ID (ws-...)" style="width: 100%; padding: 8px; border-radius: 6px; border: 1px solid #ccc; box-sizing: border-box;">`;
                    }

                    let actionButtons = '';
                    if (pendingTeamAction === 'all') {
                        actionButtons = `<button id="start-team-export-btn" style="padding: 10px 16px; border: none; border-radius: 8px; background: #10a37f; color: #fff; cursor: pointer; font-weight: bold;">导出全部 (ZIP)</button>`;
                    } else if (pendingTeamAction === 'select') {
                        actionButtons = `<button id="start-team-picker-btn" style="padding: 10px 16px; border: 1px solid #ccc; border-radius: 8px; background: #fff; cursor: pointer;">选择对话导出</button>`;
                    } else {
                        actionButtons = `<button id="start-team-export-btn" style="padding: 10px 16px; border: none; border-radius: 8px; background: #10a37f; color: #fff; cursor: pointer; font-weight: bold;">导出全部 (ZIP)</button>
                                     <button id="start-team-picker-btn" style="padding: 10px 16px; border: 1px solid #ccc; border-radius: 8px; background: #fff; cursor: pointer;">选择对话导出</button>`;
                    }

                    html += `<div style="display: flex; justify-content: space-between; align-items: center; margin-top: 24px;">
                                 <button id="back-btn" style="padding: 10px 16px; border: 1px solid #ccc; border-radius: 8px; background: #fff; cursor: pointer;">返回</button>
                                 <div style="display: flex; gap: 8px;">
                                     ${actionButtons}
                                 </div>
                               </div>`;
                    break;
                }

                case 'initial':
                default:
                    html = `<h2 style="margin-top:0; margin-bottom: 20px; font-size: 18px;">选择要导出的空间</h2>
                                <div style="display: flex; flex-direction: column; gap: 16px;">
                                    <div style="padding: 16px; border: 1px solid #ccc; border-radius: 8px; background: #f9fafb;">
                                        <strong style="font-size: 16px;">个人空间</strong>
                                        <p style="margin: 4px 0 12px 0; color: #666;">导出您个人账户下的对话。</p>
                                        <div style="display: flex; gap: 8px;">
                                            <button id="select-personal-btn" style="padding: 8px 12px; border: none; border-radius: 6px; background: #10a37f; color: #fff; cursor: pointer; font-weight: bold;">导出全部</button>
                                            <button id="select-personal-picker-btn" style="padding: 8px 12px; border: 1px solid #ccc; border-radius: 6px; background: #fff; cursor: pointer;">选择对话导出</button>
                                        </div>
                                    </div>
                                    <div style="padding: 16px; border: 1px solid #ccc; border-radius: 8px; background: #f9fafb;">
                                        <strong style="font-size: 16px;">项目空间</strong>
                                        <p style="margin: 4px 0 12px 0; color: #666;">导出项目空间下的对话，将按项目自动分组。</p>
                                        <div style="display: flex; gap: 8px;">
                                            <button id="select-project-btn" style="padding: 8px 12px; border: none; border-radius: 6px; background: #10a37f; color: #fff; cursor: pointer; font-weight: bold;">导出全部</button>
                                            <button id="select-project-picker-btn" style="padding: 8px 12px; border: 1px solid #ccc; border-radius: 6px; background: #fff; cursor: pointer;">选择对话导出</button>
                                        </div>
                                    </div>
                                    <div style="padding: 16px; border: 1px solid #ccc; border-radius: 8px; background: #f9fafb;">
                                        <strong style="font-size: 16px;">团队空间</strong>
                                        <p style="margin: 4px 0 12px 0; color: #666;">导出团队空间下的对话，将自动检测ID。</p>
                                        <div style="display: flex; gap: 8px;">
                                            <button id="select-team-btn" style="padding: 8px 12px; border: none; border-radius: 6px; background: #10a37f; color: #fff; cursor: pointer; font-weight: bold;">导出全部</button>
                                            <button id="select-team-picker-btn" style="padding: 8px 12px; border: 1px solid #ccc; border-radius: 6px; background: #fff; cursor: pointer;">选择对话导出</button>
                                        </div>
                                    </div>
                                </div>
                                <label style="display: flex; align-items: flex-start; gap: 8px; margin-top: 16px; padding: 12px; border: 1px solid #d1d5db; border-radius: 8px; background: #f9fafb; cursor: pointer;">
                                    <input id="include-attachments" type="checkbox" ${includeAttachments ? 'checked' : ''} style="margin-top: 2px;">
                                    <span>
                                        <strong style="display: block; font-size: 13px;">同时下载上传和生成的附件</strong>
                                        <span style="display: block; margin-top: 2px; color: #666; font-size: 12px;">默认关闭；开启后导出时间和 ZIP 体积可能明显增加。</span>
                                    </span>
                                </label>
                                <div style="display: flex; justify-content: flex-end; margin-top: 24px;">
                                    <button id="cancel-btn" style="padding: 10px 16px; border: 1px solid #ccc; border-radius: 8px; background: #fff; cursor: pointer;">取消</button>
                                </div>`;
                    break;
            }
            dialog.innerHTML = html;
            attachListeners(step);
        };

        const attachListeners = (step) => {
            if (step === 'initial') {
                const includeAttachmentsInput = document.getElementById('include-attachments');
                includeAttachmentsInput.onchange = (event) => {
                    includeAttachments = event.target.checked;
                };
                document.getElementById('select-personal-btn').onclick = () => {
                    closeDialog();
                    startExportProcess('personal', null, includeAttachments);
                };
                document.getElementById('select-personal-picker-btn').onclick = () => {
                    closeDialog();
                    showConversationPicker({ mode: 'personal', workspaceId: null, includeAttachments });
                };
                document.getElementById('select-project-btn').onclick = () => {
                    closeDialog();
                    startProjectSpaceExportProcess(null, includeAttachments);
                };
                document.getElementById('select-project-picker-btn').onclick = () => {
                    closeDialog();
                    showConversationPicker({ mode: 'project', workspaceId: null, includeAttachments });
                };
                const startTeamFlow = (action) => {
                    const detectedIds = detectAllWorkspaceIds();
                    if (detectedIds.length === 1) {
                        const workspaceId = detectedIds[0];
                        closeDialog();
                        if (action === 'all') {
                            startExportProcess('team', workspaceId, includeAttachments);
                        } else {
                            showConversationPicker({ mode: 'team', workspaceId, includeAttachments });
                        }
                        return;
                    }
                    renderStep('team', action);
                };
                document.getElementById('select-team-btn').onclick = () => startTeamFlow('all');
                document.getElementById('select-team-picker-btn').onclick = () => startTeamFlow('select');
                document.getElementById('cancel-btn').onclick = closeDialog;
            } else if (step === 'team') {
                document.getElementById('back-btn').onclick = () => renderStep('initial');
                const resolveWorkspaceId = () => {
                    let workspaceId = '';
                    const radioChecked = document.querySelector('input[name="workspace_id"]:checked');
                    const codeEl = document.getElementById('workspace-id-code');
                    const inputEl = document.getElementById('team-id-input');

                    if (radioChecked) {
                        workspaceId = radioChecked.value;
                    } else if (codeEl) {
                        workspaceId = codeEl.textContent;
                    } else if (inputEl) {
                        workspaceId = inputEl.value.trim();
                    }

                    if (!workspaceId) {
                        alert('请选择或输入一个有效的 Team Workspace ID！');
                        return;
                    }
                    return workspaceId;
                };
                const exportAllBtn = document.getElementById('start-team-export-btn');
                const pickerBtn = document.getElementById('start-team-picker-btn');
                if (exportAllBtn) exportAllBtn.onclick = () => {
                    const workspaceId = resolveWorkspaceId();
                    if (!workspaceId) return;
                    closeDialog();
                    startExportProcess('team', workspaceId, includeAttachments);
                };
                if (pickerBtn) pickerBtn.onclick = () => {
                    const workspaceId = resolveWorkspaceId();
                    if (!workspaceId) return;
                    closeDialog();
                    showConversationPicker({ mode: 'team', workspaceId, includeAttachments });
                };
            }
        };

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        overlay.onclick = (e) => { if (e.target === overlay) closeDialog(); };
        renderStep('initial');
    }

    // --- 脚本启动 ---
    // 悬浮导出按钮：页面加载后即可见（点击导出 / 拖动移动 / 贴边半隐藏 / 右键重置）
    if (document.body) {
        initFab();
    } else {
        document.addEventListener('DOMContentLoaded', initFab);
    }


    window.ChatGPTExporter = window.ChatGPTExporter || {};
    const previousRuntimeVersion = document.documentElement.getAttribute('data-chatgpt-exporter-version');
    if (previousRuntimeVersion !== ATTACHMENT_EXPORT_VERSION) {
        document.getElementById('export-dialog-overlay')?.remove();
    }
    Object.assign(window.ChatGPTExporter, {
        version: ATTACHMENT_EXPORT_VERSION,
        showDialog: showExportDialog,
        startManualExport: (mode = 'personal', workspaceId = null) => {
            if (mode === 'project') {
                return startProjectSpaceExportProcess(workspaceId);
            }
            return startExportProcess(mode, workspaceId);
        },
        startScheduledExport
    });

    document.documentElement.setAttribute('data-chatgpt-exporter-ready', '1');
    document.documentElement.setAttribute('data-chatgpt-exporter-version', ATTACHMENT_EXPORT_VERSION);
    console.info(`[ChatGPT Exporter] runtime v${ATTACHMENT_EXPORT_VERSION} ready`);
    window.dispatchEvent(new CustomEvent('CHATGPT_EXPORTER_READY'));

    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        const data = event.data || {};
        if (data?.type !== 'CHATGPT_EXPORTER_COMMAND') return;
        const api = window.ChatGPTExporter;
        if (!api) return;
        try {
            switch (data.action) {
                case 'START_SCHEDULED_EXPORT':
                    api.startScheduledExport(data.payload || {});
                    break;
                case 'OPEN_DIALOG':
                    api.showDialog();
                    break;
                case 'START_MANUAL_EXPORT':
                    api.startManualExport(data.payload?.mode, data.payload?.workspaceId);
                    break;
                default:
                    console.warn('[ChatGPT Exporter] 未知命令:', data.action);
            }
        } catch (err) {
            console.error('[ChatGPT Exporter] 处理命令失败:', err);
        }
    });

})();
