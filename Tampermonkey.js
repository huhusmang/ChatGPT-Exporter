// ==UserScript==
// @name         ChatGPT Universal Exporter (Markdown Support)
// @version      1.5.1
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
    function readHeader(headers, name) {
        if (!headers) return null;
        if (typeof headers.get === 'function') return headers.get(name);
        const lowerName = name.toLowerCase();
        if (Array.isArray(headers)) {
            const pair = headers.find(([key]) => String(key).toLowerCase() === lowerName);
            return pair ? pair[1] : null;
        }
        const key = Object.keys(headers).find(k => k.toLowerCase() === lowerName);
        return key ? headers[key] : null;
    }

    (function interceptNetwork() {
        const rawFetch = window.fetch;
        window.fetch = function (resource, options) {
            try {
                const isRequest = typeof Request !== 'undefined' && resource instanceof Request;
                const headers = options?.headers || (isRequest ? resource.headers : null);
                tryCaptureToken(readHeader(headers, 'Authorization'));
                const id = readHeader(headers, 'ChatGPT-Account-Id');
                if (id && !capturedWorkspaceIds.has(id)) {
                    console.log('🎯 [Fetch] 捕获到 Workspace ID:', id);
                    capturedWorkspaceIds.add(id);
                }
            } catch (_) {}
            return rawFetch.apply(this, arguments);
        };
    })();

    function tryCaptureToken(value) {
        if (typeof value !== 'string' || !value.startsWith('Bearer ')) return;
        const token = value.slice(7);
        // 未登录时页面会发送占位符 "dummy"，不能当作真实 Token
        if (token && token.toLowerCase() !== 'dummy') {
            accessToken = token;
        }
    }

    async function ensureAccessToken({ forceRefresh = false, silent = false } = {}) {
        if (accessToken && !forceRefresh) return accessToken;
        try {
            const session = await (await fetch('/api/auth/session?unstable_client=true')).json();
            if (session?.accessToken) {
                accessToken = session.accessToken;
                return accessToken;
            }
        } catch (_) {}
        if (!silent) alert('无法获取 Access Token。请刷新页面或打开任意一个对话后再试。');
        return null;
    }
    // --- 辅助函数 ---
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const jitter = () => BASE_DELAY + Math.random() * JITTER;
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

    const EXPORTER_VERSION = '1.5.1';
    const EXPORT_BUTTON_LABEL = `Export Conversations v${EXPORTER_VERSION}`;
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

    function getActiveConversationNodes(convData) {
        const mapping = convData?.mapping;
        if (!mapping || typeof mapping !== 'object') return [];

        const entries = Object.entries(mapping);
        if (entries.length === 0) return [];

        let currentNodeId = convData?.current_node;
        if (!currentNodeId || !mapping[currentNodeId]) {
            const leaves = entries
                .filter(([, node]) => !Array.isArray(node?.children) || node.children.length === 0)
                .sort(([, a], [, b]) => {
                    const aTime = Number(a?.message?.create_time) || 0;
                    const bTime = Number(b?.message?.create_time) || 0;
                    return bTime - aTime;
                });
            currentNodeId = leaves[0]?.[0] || entries[entries.length - 1][0];
            console.warn('Conversation current_node is unavailable; exporting the latest leaf path instead.');
        }

        const path = [];
        const visited = new Set();
        while (currentNodeId && !visited.has(currentNodeId)) {
            visited.add(currentNodeId);
            const node = mapping[currentNodeId];
            if (!node) break;
            path.push(node);
            currentNodeId = node.parent || null;
        }
        return path.reverse();
    }

    function collectVisibleAttachments(convData) {
        const references = new Map();
        const add = (reference) => {
            const key = reference.kind === 'sandbox'
                ? `sandbox:${reference.messageId}:${reference.sandboxPath}`
                : `file:${reference.fileId}`;
            if (!references.has(key)) references.set(key, reference);
        };

        getActiveConversationNodes(convData).forEach(node => {
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

    function attachmentHeaders(accountId) {
        const headers = {
            'Authorization': `Bearer ${accessToken}`,
            'oai-device-id': getOaiDeviceId()
        };
        if (accountId) headers['ChatGPT-Account-Id'] = accountId;
        return headers;
    }

    async function fetchAttachmentBinary(reference, convData, accountId, session) {
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

        const metadataResponse = await apiFetch(metadataUrl, {
            accountId, session, label: 'metadata HTTP', init: { credentials: 'include' }
        });
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
            ? { credentials: 'include', headers: attachmentHeaders(accountId) }
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

    // 图片、音视频、压缩包和 Office 文档本身已经压缩过，再 DEFLATE 只会白白耗费打包时间。
    const PRECOMPRESSED_FILE = /\.(?:png|jpe?g|gif|webp|avif|heic|mp3|m4a|aac|ogg|mp4|mov|webm|zip|gz|7z|rar|pdf|docx|xlsx|pptx)$/i;

    async function appendAttachmentsToZip(target, convData, accountId, session = null) {
        const references = collectVisibleAttachments(convData);
        const failures = [];
        const files = [];
        const sandboxPaths = new Map();
        const usedNames = new Set();
        const folderName = generateUniqueFilename(convData).replace(/\.json$/i, '') + '_files';

        for (const reference of references) {
            if (session?.cancelled) break;
            try {
                const downloaded = await fetchAttachmentBinary(reference, convData, accountId, session);
                const filename = uniqueAttachmentName(downloaded.filename, usedNames);
                target.folder(folderName).file(filename, downloaded.data, {
                    compression: PRECOMPRESSED_FILE.test(filename) ? 'STORE' : 'DEFLATE'
                });
                const relativePath = encodeRelativePath(`${folderName}/${filename}`);
                files.push({
                    name: filename,
                    path: relativePath,
                    kind: reference.kind,
                    isImage: reference.isImage,
                    messageId: reference.messageId,
                    ownerRole: reference.ownerRole
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

    function processContentReferences(text, contentReferences, referenceStartIndex = 1) {
        if (!text || !Array.isArray(contentReferences) || contentReferences.length === 0) {
            return { text, footnotes: [], nextReferenceIndex: referenceStartIndex };
        }

        const references = contentReferences.filter(ref => ref && typeof ref.matched_text === 'string' && ref.matched_text.length > 0);
        if (references.length === 0) {
            return { text, footnotes: [], nextReferenceIndex: referenceStartIndex };
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
            const index = referenceStartIndex + footnotes.length;
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

        return {
            text: output,
            footnotes,
            nextReferenceIndex: referenceStartIndex + footnotes.length
        };
    }

    function extractConversationMessages(convData, attachmentResult = null) {
        const messages = [];
        const nodes = getActiveConversationNodes(convData);
        let nextReferenceIndex = 1;

        nodes.forEach(node => {
            const msg = node?.message;
            if (!msg) return;

            const author = msg.author?.role;
            const isHidden = msg.metadata?.is_visually_hidden_from_conversation ||
                msg.metadata?.is_contextual_answers_system_message;
            if ((author !== 'user' && author !== 'assistant') || isHidden) return;

            const content = msg.content;
            if ((content?.content_type !== 'text' && content?.content_type !== 'multimodal_text') || !Array.isArray(content.parts)) return;

            const rawText = content.parts
                .map(part => typeof part === 'string' ? part : (part?.text ?? ''))
                .filter(Boolean)
                .join('\n');
            const contentReferences = msg.metadata?.content_references || [];
            let processedText = rawText;
            let footnotes = [];
            if (Array.isArray(contentReferences) && contentReferences.length > 0) {
                const processed = processContentReferences(rawText, contentReferences, nextReferenceIndex);
                processedText = processed.text;
                footnotes = processed.footnotes;
                nextReferenceIndex = processed.nextReferenceIndex;
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
            if (!renderedContent) return;

            messages.push({
                role: author,
                content: renderedContent,
                messageId: msg.id,
                create_time: msg.create_time || null,
                footnotes
            });
        });

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
        // 立即回收会让部分浏览器（Firefox、Safari）的大文件下载失败
        setTimeout(() => URL.revokeObjectURL(a.href), 60000);
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
            btn.title = `ChatGPT Exporter v${EXPORTER_VERSION} · 点击导出 · 拖动移动 · 右键重置位置`;
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
        btn.title = `${text} · ChatGPT Exporter v${EXPORTER_VERSION}`;
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
            if (e.button !== 0) return;
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
            if (activeExport) {
                requestCancelActiveExport();
                return;
            }
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
        if (!activeExport) setFabStatus(btn, EXPORT_BUTTON_LABEL);
        btn.dataset.exporterVersion = EXPORTER_VERSION;
        return btn;
    }

    // @build:userscript-only-start
    function initFab() {
        if (!document.body) {
            setTimeout(initFab, 200);
            return;
        }
        getExportButton();
    }
    // @build:userscript-only-end

    // --- 导出流程核心逻辑 ---

    let activeExport = null;

    function createCancelError() {
        const error = new Error('已取消导出');
        error.cancelled = true;
        error.stopsBatch = true;
        return error;
    }

    // 导出和列表加载共用：汇报进度、响应取消、在限流退避时倒计时。
    function createTaskSession(onProgress) {
        return {
            cancelled: false,
            progress(text) {
                onProgress?.(text);
            },
            throwIfCancelled() {
                if (this.cancelled) throw createCancelError();
            },
            async wait(ms, describe) {
                const until = Date.now() + ms;
                while (Date.now() < until) {
                    this.throwIfCancelled();
                    if (describe) this.progress(describe(Math.ceil((until - Date.now()) / 1000)));
                    await sleep(Math.min(1000, until - Date.now()));
                }
                this.throwIfCancelled();
            }
        };
    }

    function requestCancelActiveExport() {
        if (!activeExport || activeExport.cancelled) return;
        if (!confirm('要停止当前导出吗？已经导出的对话会照常打包下载。')) return;
        activeExport.cancelled = true;
        activeExport.progress('⏹ 正在停止…');
    }

    // JSON 是无损备份，必须最先写入；附件或 Markdown 出错只降级为部分成功，不影响已写入的 JSON。
    async function addConversationToZip(target, convData, context) {
        const { accountId, attachmentReport, session } = context;
        target.file(generateUniqueFilename(convData), JSON.stringify(convData, null, 2));
        const stageErrors = [];
        let attachmentResult = null;
        if (attachmentReport) {
            try {
                attachmentResult = await appendAttachmentsToZip(target, convData, accountId, session);
                attachmentReport.detected += attachmentResult.detected;
                attachmentReport.downloaded += attachmentResult.files.length;
                attachmentReport.failed += attachmentResult.failures.length;
                attachmentReport.conversations.push({
                    conversation_id: convData?.conversation_id || null,
                    title: convData?.title || 'Untitled Conversation',
                    detected: attachmentResult.detected,
                    downloaded: attachmentResult.files,
                    failures: attachmentResult.failures
                });
            } catch (error) {
                attachmentResult = null;
                stageErrors.push({ stage: 'attachments', error });
            }
        }
        try {
            target.file(generateMarkdownFilename(convData), convertConversationToMarkdown(convData, attachmentResult));
        } catch (error) {
            stageErrors.push({ stage: 'markdown', error });
        }
        return stageErrors;
    }

    function createExportErrorReport() {
        return {
            exporter_version: EXPORTER_VERSION,
            generated_at: new Date().toISOString(),
            succeeded: 0,
            partial: 0,
            failed: 0,
            stopped_reason: null,
            issues: []
        };
    }

    function recordExportIssue(errorReport, entry, stage, error) {
        const message = error?.message || String(error);
        errorReport.issues.push({
            conversation_id: entry?.id || null,
            title: entry?.title || null,
            folder: entry?.folder || null,
            stage,
            error: message
        });
        console.error(`[ChatGPT Exporter] ${stage} 阶段失败 (${entry?.id || entry?.folder || 'unknown'}):`, error);
    }

    // outcome 为 'ok' | 'partial' | 'failed' | 'stopped'；只有 'stopped' 需要调用方终止批量导出。
    async function exportConversationSafely(target, entry, context) {
        const { errorReport, session, accountId } = context;
        let convData;
        try {
            convData = await getConversation(entry.id, accountId, session);
        } catch (error) {
            if (error?.cancelled) {
                errorReport.stopped_reason = error.message;
                return { outcome: 'stopped' };
            }
            errorReport.failed += 1;
            recordExportIssue(errorReport, entry, 'fetch', error);
            if (error?.stopsBatch) {
                errorReport.stopped_reason = error.message;
                return { outcome: 'stopped' };
            }
            return { outcome: 'failed' };
        }

        const issueEntry = { ...entry, title: convData?.title || entry.title };
        const updateTime = normalizeEpochSeconds(convData?.update_time);
        let stageErrors;
        try {
            stageErrors = await addConversationToZip(target, convData, context);
        } catch (error) {
            errorReport.failed += 1;
            recordExportIssue(errorReport, issueEntry, 'json', error);
            return { outcome: 'failed' };
        }
        if (stageErrors.length === 0) {
            errorReport.succeeded += 1;
            return { outcome: 'ok', updateTime };
        }
        errorReport.partial += 1;
        stageErrors.forEach(({ stage, error }) => recordExportIssue(errorReport, issueEntry, stage, error));
        return { outcome: 'partial', updateTime };
    }

    function buildExportSummary(errorReport, { skippedUnchanged = 0 } = {}) {
        const skippedLine = skippedUnchanged > 0
            ? `\n增量导出：跳过了 ${skippedUnchanged} 个自上次导出后没有变化的对话。`
            : '';
        if (errorReport.issues.length === 0 && !errorReport.stopped_reason) {
            return `✅ 导出完成！共 ${errorReport.succeeded} 个对话。${skippedLine}`;
        }
        const head = errorReport.stopped_reason
            ? `⚠️ 导出已提前停止，ZIP 中只包含停止前导出的对话。\n原因：${errorReport.stopped_reason}`
            : '⚠️ 导出完成，但有部分内容失败。';
        const listFailures = errorReport.issues.filter(issue => issue.stage === 'list').length;
        const listLine = listFailures > 0 ? `\n另有 ${listFailures} 处对话列表获取失败，可能漏掉了部分项目对话。` : '';
        return `${head}\n成功 ${errorReport.succeeded}，部分成功（已存 JSON，缺 Markdown 或附件）${errorReport.partial}，失败 ${errorReport.failed}。${listLine}${skippedLine}\n详情见 ZIP 内的 export-error-report.json。`;
    }

    // --- 增量导出记录：按账户记住每个对话上次导出时的更新时间 ---
    const EXPORT_HISTORY_KEY = 'chatgpt-exporter-history-v1';

    function exportHistoryStorageKey(accountId) {
        return `${EXPORT_HISTORY_KEY}:${accountId || 'default'}`;
    }

    function loadExportHistory(accountId) {
        try {
            const saved = JSON.parse(localStorage.getItem(exportHistoryStorageKey(accountId)));
            return saved && typeof saved === 'object' ? saved : {};
        } catch (_) {
            return {};
        }
    }

    function saveExportHistory(accountId, history, exported) {
        exported.forEach(({ id, updateTime }) => {
            if (id && updateTime) history[id] = Math.max(updateTime, Number(history[id]) || 0);
        });
        try {
            localStorage.setItem(exportHistoryStorageKey(accountId), JSON.stringify(history));
        } catch (error) {
            console.warn('[ChatGPT Exporter] 保存增量导出记录失败:', error);
        }
    }

    function clearExportHistory() {
        try {
            Object.keys(localStorage)
                .filter(key => key.startsWith(`${EXPORT_HISTORY_KEY}:`))
                .forEach(key => localStorage.removeItem(key));
        } catch (_) {}
    }

    function isUnchangedSinceLastExport(entry, history) {
        const exportedAt = Number(history[entry.id]) || 0;
        const updatedAt = Number(entry.update_time) || 0;
        return exportedAt > 0 && updatedAt > 0 && exportedAt >= updatedAt;
    }

    function localDateStamp(date = new Date()) {
        const pad = value => String(value).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    }

    function buildZipFilename({ mode, workspaceId, selected, incremental }) {
        const kind = selected ? 'selected' : incremental ? 'incremental' : 'backup';
        const space = mode === 'team' ? 'team' : mode === 'project' ? 'project' : 'personal';
        const workspacePart = mode === 'team' && workspaceId ? `_${workspaceId}` : '';
        return `chatgpt_${space}_${kind}${workspacePart}_${localDateStamp()}.zip`;
    }

    function showExportResult(message) {
        alert(message);
    }

    function showNotice(message) {
        alert(message);
    }

    async function exportConversations(options = {}) {
        const {
            mode = 'personal',
            workspaceId = null,
            conversationEntries = null,
            includeAttachments = false,
            incremental = false
        } = options;
        if (activeExport) {
            showNotice('已有导出任务正在进行。点击悬浮球可以停止当前导出。');
            return;
        }
        const btn = getExportButton();
        if (!await ensureAccessToken()) return;

        const session = createTaskSession(text => setFabStatus(btn, text));
        activeExport = session;
        const accountId = resolveWorkspaceId(workspaceId);
        const selected = Array.isArray(conversationEntries) && conversationEntries.length > 0;
        const errorReport = createExportErrorReport();
        const attachmentReport = includeAttachments ? {
            exporter_version: EXPORTER_VERSION,
            generated_at: new Date().toISOString(),
            detected: 0,
            downloaded: 0,
            failed: 0,
            conversations: []
        } : null;
        let finalStatus = '⚠️ Error';

        try {
            let entries = conversationEntries;
            if (!selected) {
                session.progress('📂 读取对话列表…');
                const listing = await collectConversationEntries({ mode, accountId, session });
                listing.problems.forEach(({ folder, error }) => recordExportIssue(errorReport, { folder }, 'list', error));
                entries = listing.entries;
            }

            const history = loadExportHistory(accountId);
            let skippedUnchanged = 0;
            if (incremental && !selected) {
                const changed = entries.filter(entry => !isUnchangedSinceLastExport(entry, history));
                skippedUnchanged = entries.length - changed.length;
                entries = changed;
            }
            if (entries.length === 0) {
                finalStatus = '✅ 完成';
                const listProblems = errorReport.issues.length > 0
                    ? `\n另有 ${errorReport.issues.length} 处对话列表获取失败，详情请查看控制台。`
                    : '';
                showExportResult(skippedUnchanged > 0
                    ? `✅ 没有需要导出的对话：${skippedUnchanged} 个对话自上次导出后都没有变化。${listProblems}`
                    : `没有找到可以导出的对话。${listProblems}`);
                return;
            }

            const zip = new JSZip();
            const exported = [];
            const context = { accountId, attachmentReport, errorReport, session };
            for (let i = 0; i < entries.length; i++) {
                if (session.cancelled) {
                    errorReport.stopped_reason = '已取消导出';
                    break;
                }
                const entry = entries[i];
                const label = entry?.title ? entry.title.slice(0, 12) : '对话';
                session.progress(`📥 ${label} (${i + 1}/${entries.length})`);
                const target = entry?.projectTitle
                    ? zip.folder(sanitizeFilename(entry.projectTitle))
                    : zip;
                const { outcome, updateTime } = await exportConversationSafely(target, {
                    id: entry.id,
                    title: entry?.title || null,
                    folder: entry?.projectTitle || null
                }, context);
                if (outcome === 'ok' || outcome === 'partial') {
                    exported.push({ id: entry.id, updateTime: Math.max(Number(entry.update_time) || 0, updateTime || 0) });
                }
                if (outcome === 'stopped') break;
                if (i < entries.length - 1) await sleep(jitter());
            }

            if (exported.length === 0) {
                showExportResult(`${buildExportSummary(errorReport, { skippedUnchanged })}`.replace(/\n详情见 ZIP 内的 export-error-report\.json。$/, '\n没有导出任何对话，因此没有生成 ZIP。详情请查看控制台。'));
                return;
            }

            if (attachmentReport) {
                zip.file('attachment-export-report.json', JSON.stringify(attachmentReport, null, 2));
            }
            const hasIssues = errorReport.issues.length > 0 || Boolean(errorReport.stopped_reason);
            if (hasIssues) {
                zip.file('export-error-report.json', JSON.stringify(errorReport, null, 2));
            }

            let lastPercent = -1;
            const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }, meta => {
                const percent = Math.floor(meta.percent);
                if (percent === lastPercent) return;
                lastPercent = percent;
                session.progress(`📦 生成 ZIP 文件 (${percent}/100)`);
            });
            downloadFile(blob, buildZipFilename({ mode, workspaceId, selected, incremental: incremental && !selected }));
            saveExportHistory(accountId, history, exported);

            const attachmentSummary = attachmentReport
                ? `\n附件：检测 ${attachmentReport.detected}，成功 ${attachmentReport.downloaded}，失败 ${attachmentReport.failed}。`
                : '';
            finalStatus = hasIssues ? '⚠️ 部分完成' : '✅ 完成';
            showExportResult(`${buildExportSummary(errorReport, { skippedUnchanged })}${attachmentSummary}`);
        } catch (error) {
            if (error?.cancelled) {
                finalStatus = '⚠️ 已取消';
                showExportResult('已取消导出。');
            } else {
                console.error('导出过程中发生严重错误:', error);
                showExportResult(`导出失败: ${error.message}。详情请查看控制台（F12 -> Console）。`);
            }
        } finally {
            activeExport = null;
            setFabStatus(btn, finalStatus);
            setTimeout(() => {
                if (!activeExport) setFabStatus(btn, EXPORT_BUTTON_LABEL);
            }, 3000);
        }
    }

    function startExportProcess(mode, workspaceId, options = {}) {
        return exportConversations({ mode, workspaceId, ...options });
    }

    function startSelectiveExportProcess(mode, workspaceId, conversationEntries, includeAttachments = false) {
        return exportConversations({ mode, workspaceId, conversationEntries, includeAttachments });
    }

    // --- API 调用函数 ---
    const RATE_LIMIT_RETRY_DELAYS = [15000, 30000, 60000];
    const MAX_RETRY_AFTER_MS = 120000;

    // 401（登录失效）和 429（限流）在重试后仍失败时，会让后续每个请求同样失败，批量导出应停止。
    function createHttpError(message, status) {
        const error = new Error(message);
        error.status = status;
        error.stopsBatch = status === 401 || status === 429;
        return error;
    }

    function describeHttpFailure(label, status) {
        if (status === 429) {
            return `${label}：官方接口限流 (429)，重试后仍未恢复。请等待几分钟后再试，或减少单次导出的对话数量。`;
        }
        if (status === 401) {
            return `${label}：登录状态已失效 (401)，请刷新页面后重试。`;
        }
        return `${label} (${status})`;
    }

    function retryAfterMs(response) {
        const header = response.headers?.get?.('retry-after');
        if (header == null || header === '') return null;
        const seconds = Number(header);
        const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
        return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS) : null;
    }

    // 所有 backend-api 请求的统一入口：补齐认证和账户请求头；401 时刷新一次 Token；
    // 429 时按 Retry-After（没有则按固定间隔）退避重试。
    async function apiFetch(path, { accountId = null, session = null, label = '请求失败', init = {} } = {}) {
        const deviceId = getOaiDeviceId();
        if (!deviceId) {
            const error = new Error('无法获取 oai-device-id，请确保已登录并刷新页面。');
            error.stopsBatch = true;
            throw error;
        }
        let tokenRefreshed = false;
        let rateLimitRetries = 0;
        for (;;) {
            session?.throwIfCancelled();
            const headers = {
                ...(init.headers || {}),
                'Authorization': `Bearer ${accessToken}`,
                'oai-device-id': deviceId
            };
            if (accountId) headers['ChatGPT-Account-Id'] = accountId;
            const response = await fetch(path, { ...init, headers });
            if (response.ok) return response;

            if (response.status === 401 && !tokenRefreshed) {
                tokenRefreshed = true;
                if (await ensureAccessToken({ forceRefresh: true, silent: true })) continue;
            }
            if (response.status === 429 && rateLimitRetries < RATE_LIMIT_RETRY_DELAYS.length) {
                const delay = retryAfterMs(response) ?? RATE_LIMIT_RETRY_DELAYS[rateLimitRetries];
                rateLimitRetries++;
                if (session) {
                    await session.wait(delay, seconds => `⏳ 接口限流，${seconds} 秒后重试…`);
                } else {
                    await sleep(delay);
                }
                continue;
            }
            throw createHttpError(describeHttpFailure(label, response.status), response.status);
        }
    }

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

    async function listProjects(accountId, session, query = {}) {
        const projects = new Map();
        let cursor = null;
        do {
            const params = new URLSearchParams({ limit: String(PROJECT_SIDEBAR_LIMIT) });
            if (query.conversationsPerGizmo !== undefined) {
                params.set('conversations_per_gizmo', String(query.conversationsPerGizmo));
            }
            if (query.ownedOnly !== undefined) {
                params.set('owned_only', query.ownedOnly ? 'true' : 'false');
            }
            if (cursor) params.set('cursor', cursor);
            const response = await apiFetch(`/backend-api/gizmos/snorlax/sidebar?${params}`, {
                accountId, session, label: '获取项目列表失败'
            });
            const data = await response.json();
            (data.items || []).forEach(item => {
                const project = normalizeProjectSpaceItem(item);
                if (project) projects.set(project.id, project);
            });
            cursor = data.cursor || null;
            if (cursor) await sleep(jitter());
        } while (cursor);
        return Array.from(projects.values());
    }

    async function listRootConversations(map, accountId, session) {
        for (const isArchived of [false, true]) {
            let offset = 0;
            for (;;) {
                const query = `offset=${offset}&limit=${PAGE_LIMIT}&order=updated${isArchived ? '&is_archived=true' : ''}`;
                const response = await apiFetch(`/backend-api/conversations?${query}`, {
                    accountId, session, label: '获取对话列表失败'
                });
                const data = await response.json();
                const items = Array.isArray(data.items) ? data.items : [];
                const sizeBefore = map.size;
                items.forEach(item => upsertConversationEntry(map, item, { is_archived: isArchived }));
                offset += items.length;
                session?.progress(`📂 读取对话列表… 已找到 ${map.size} 个`);
                // 服务端可能把单页数量压到 PAGE_LIMIT 以下：有 total 时以 total 为准，否则翻到空页为止；
                // 一页里没有任何新对话时也停止，防止接口忽略 offset 导致死循环。
                const reachedEnd = items.length === 0
                    || map.size === sizeBefore
                    || (Number.isFinite(data.total) && offset >= data.total);
                if (reachedEnd) break;
                await sleep(jitter());
            }
        }
    }

    // 返回 null 表示完整获取；返回 Error 表示只拿到了侧边栏里的预览对话。
    async function listProjectConversations(map, project, accountId, session) {
        const extra = { projectId: project.id, projectTitle: project.title };
        let cursor = '0';
        let fetchedAny = false;
        do {
            let response;
            try {
                response = await apiFetch(`/backend-api/gizmos/${project.id}/conversations?cursor=${cursor}`, {
                    accountId, session, label: `获取项目「${project.title}」的对话列表失败`
                });
            } catch (error) {
                if (fetchedAny || error?.stopsBatch || !project.conversations?.length) throw error;
                project.conversations.forEach(item => upsertConversationEntry(map, item, extra));
                return new Error(`${error.message}，已改用侧边栏中的 ${project.conversations.length} 个预览对话`);
            }
            const data = await response.json();
            (data.items || []).forEach(item => upsertConversationEntry(map, item, extra));
            fetchedAny = true;
            cursor = data.cursor || null;
            if (cursor) await sleep(jitter());
        } while (cursor);
        return null;
    }

    // mode 为 'project' 时只列项目内对话，其余模式列出项目外和项目内的全部对话。
    // 单个项目失败只记入 problems，不影响其他项目；登录失效、限流或取消会直接抛出。
    async function collectConversationEntries({ mode, accountId, session = null }) {
        const map = new Map();
        const problems = [];
        if (mode !== 'project') {
            await listRootConversations(map, accountId, session);
        }

        let projects = [];
        try {
            session?.progress('🔍 读取项目列表…');
            const query = mode === 'team' ? {} : { conversationsPerGizmo: PROJECT_SIDEBAR_PREVIEW, ownedOnly: true };
            projects = await listProjects(accountId, session, query);
        } catch (error) {
            if (mode === 'project' || error?.stopsBatch) throw error;
            problems.push({ folder: null, error });
        }

        for (const project of projects) {
            session?.progress(`📂 读取项目「${project.title}」… 已找到 ${map.size} 个`);
            try {
                const warning = await listProjectConversations(map, project, accountId, session);
                if (warning) problems.push({ folder: project.title, error: warning });
            } catch (error) {
                if (error?.stopsBatch) throw error;
                problems.push({ folder: project.title, error });
            }
        }

        const entries = Array.from(map.values())
            .sort((a, b) => (b.update_time || 0) - (a.update_time || 0));
        return { entries, problems };
    }

    async function getConversation(id, accountId, session = null) {
        const response = await apiFetch(`/backend-api/conversation/${id}`, {
            accountId, session, label: `获取对话详情失败 conv ${id}`
        });
        const data = await response.json();
        data.__fetched_at = new Date().toISOString();
        return data;
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

        // 关闭选择器时停止仍在进行的列表加载，避免关闭后继续请求接口。
        const listSession = createTaskSession(text => {
            const statusEl = dialog.querySelector('#conv-status');
            if (state.loading && statusEl) statusEl.textContent = text;
        });
        const closeDialog = () => {
            listSession.cancelled = true;
            overlay.remove();
        };
        const state = {
            loadError: null,
            listWarning: null,
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
                showExportDialog({ includeAttachments: state.includeAttachments, incremental: options.incremental });
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
            statusEl.style.color = '#666';
            if (state.loading) return;
            if (state.loadError) {
                statusEl.textContent = `加载失败：${state.loadError}`;
                statusEl.style.color = '#b91c1c';
                return;
            }

            const visibleCount = Math.min(state.visibleCount, state.filtered.length);
            statusEl.textContent = `共 ${state.list.length} 条，当前筛选 ${state.filtered.length} 条，显示 ${visibleCount} 条，已选 ${state.selected.size} 条`
                + (state.listWarning ? `。⚠️ ${state.listWarning}` : '');
            if (state.listWarning) statusEl.style.color = '#92400e';
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

        (async () => {
            if (!await ensureAccessToken({ silent: true })) {
                throw new Error('无法获取 Access Token。请刷新页面或打开任意一个对话后再试。');
            }
            return collectConversationEntries({ mode, accountId: resolveWorkspaceId(workspaceId), session: listSession });
        })()
            .then(({ entries, problems }) => {
                state.list = entries;
                if (problems.length > 0) {
                    const names = problems.map(({ folder }) => folder ? `「${folder}」` : '项目列表').join('、');
                    state.listWarning = `${names}读取失败或不完整，列表可能缺少部分项目对话（详情见控制台）`;
                    problems.forEach(({ folder, error }) => console.warn(`[ChatGPT Exporter] 读取 ${folder || '项目列表'} 失败:`, error));
                }
            })
            .catch(err => {
                if (err?.cancelled) return;
                console.error('[ChatGPT Exporter] 加载对话列表失败:', err);
                state.loadError = err?.message || String(err);
                state.list = [];
            })
            .finally(() => {
                if (listSession.cancelled) return;
                state.loading = false;
                applyFilters();
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
        let incremental = Boolean(options.incremental);
        const exportOptions = () => ({ includeAttachments, incremental });
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
                                <label style="display: flex; align-items: flex-start; gap: 8px; margin-top: 8px; padding: 12px; border: 1px solid #d1d5db; border-radius: 8px; background: #f9fafb; cursor: pointer;">
                                    <input id="incremental-export" type="checkbox" ${incremental ? 'checked' : ''} style="margin-top: 2px;">
                                    <span>
                                        <strong style="display: block; font-size: 13px;">增量导出：只导出有变化的对话</strong>
                                        <span style="display: block; margin-top: 2px; color: #666; font-size: 12px;">仅对“导出全部”生效，跳过上次导出后没有更新的对话。导出记录保存在当前浏览器。</span>
                                        <button id="clear-history-btn" type="button" style="margin-top: 6px; padding: 0; border: none; background: none; color: #2563eb; cursor: pointer; font-size: 12px;">清除导出记录</button>
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
                document.getElementById('incremental-export').onchange = (event) => {
                    incremental = event.target.checked;
                };
                document.getElementById('clear-history-btn').onclick = (event) => {
                    event.preventDefault();
                    if (!confirm('清除后，下一次增量导出会重新导出全部对话。确定清除吗？')) return;
                    clearExportHistory();
                    event.target.textContent = '已清除导出记录';
                };
                document.getElementById('select-personal-btn').onclick = () => {
                    closeDialog();
                    startExportProcess('personal', null, exportOptions());
                };
                document.getElementById('select-personal-picker-btn').onclick = () => {
                    closeDialog();
                    showConversationPicker({ mode: 'personal', workspaceId: null, includeAttachments, incremental });
                };
                document.getElementById('select-project-btn').onclick = () => {
                    closeDialog();
                    startExportProcess('project', null, exportOptions());
                };
                document.getElementById('select-project-picker-btn').onclick = () => {
                    closeDialog();
                    showConversationPicker({ mode: 'project', workspaceId: null, includeAttachments, incremental });
                };
                const startTeamFlow = (action) => {
                    const detectedIds = detectAllWorkspaceIds();
                    if (detectedIds.length === 1) {
                        const workspaceId = detectedIds[0];
                        closeDialog();
                        if (action === 'all') {
                            startExportProcess('team', workspaceId, exportOptions());
                        } else {
                            showConversationPicker({ mode: 'team', workspaceId, includeAttachments, incremental });
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
                const readSelectedWorkspaceId = () => {
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
                    const workspaceId = readSelectedWorkspaceId();
                    if (!workspaceId) return;
                    closeDialog();
                    startExportProcess('team', workspaceId, exportOptions());
                };
                if (pickerBtn) pickerBtn.onclick = () => {
                    const workspaceId = readSelectedWorkspaceId();
                    if (!workspaceId) return;
                    closeDialog();
                    showConversationPicker({ mode: 'team', workspaceId, includeAttachments, incremental });
                };
            }
        };

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        overlay.onclick = (e) => { if (e.target === overlay) closeDialog(); };
        renderStep('initial');
    }

    // --- 脚本启动 ---
    // Chrome 扩展版不常驻悬浮按钮（入口是工具栏弹窗），构建时会去掉这一段；
    // 扩展里的按钮只在导出时由 getExportButton() 按需创建，用作进度指示。
    // @build:userscript-only-start
    if (document.body) {
        initFab();
    } else {
        document.addEventListener('DOMContentLoaded', initFab);
    }
    // @build:userscript-only-end

    const previousRuntimeVersion = document.documentElement.getAttribute('data-chatgpt-exporter-version');
    if (previousRuntimeVersion !== EXPORTER_VERSION) {
        document.getElementById('export-dialog-overlay')?.remove();
    }
    // 页面里的任何脚本都能访问这个对象，所以只暴露打开对话框，不暴露静默导出的入口。
    window.ChatGPTExporter = {
        version: EXPORTER_VERSION,
        showDialog: showExportDialog
    };

    document.documentElement.setAttribute('data-chatgpt-exporter-ready', '1');
    document.documentElement.setAttribute('data-chatgpt-exporter-version', EXPORTER_VERSION);
    console.info(`[ChatGPT Exporter] runtime v${EXPORTER_VERSION} ready`);
    window.dispatchEvent(new CustomEvent('CHATGPT_EXPORTER_READY'));

    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        const data = event.data || {};
        if (data?.type !== 'CHATGPT_EXPORTER_COMMAND') return;
        const api = window.ChatGPTExporter;
        if (!api) return;
        try {
            if (data.action === 'OPEN_DIALOG') {
                api.showDialog();
            } else {
                console.warn('[ChatGPT Exporter] 未知命令:', data.action);
            }
        } catch (err) {
            console.error('[ChatGPT Exporter] 处理命令失败:', err);
        }
    });

})();
