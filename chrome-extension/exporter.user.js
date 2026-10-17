// 此文件由 scripts/build.mjs 根据 Tampermonkey.js 生成，请勿直接修改。

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

    const ACCESS_TOKEN_HINT = '无法获取 Access Token。请刷新页面或打开任意一个对话后再试。';

    async function ensureAccessToken({ forceRefresh = false } = {}) {
        if (accessToken && !forceRefresh) return accessToken;
        try {
            const session = await (await fetch('/api/auth/session?unstable_client=true')).json();
            if (session?.accessToken) {
                accessToken = session.accessToken;
                return accessToken;
            }
        } catch (_) {}
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

    const EXPORTER_VERSION = '1.6.0';
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

    function toIsoTime(value) {
        const seconds = normalizeEpochSeconds(value);
        return seconds ? new Date(seconds * 1000).toISOString() : null;
    }

    // JSON.stringify 的转义是 YAML 双引号字符串的子集，可以直接当作 YAML 字符串值。
    function buildMarkdownFrontMatter(convData) {
        const id = convData?.conversation_id || convData?.id || null;
        const fields = [
            ['title', convData?.title || 'Untitled Conversation'],
            ['conversation_id', id],
            ['created', toIsoTime(convData?.create_time)],
            ['updated', toIsoTime(convData?.update_time)],
            ['url', id ? `https://chatgpt.com/c/${id}` : null],
            ['exported_by', `ChatGPT Exporter v${EXPORTER_VERSION}`]
        ].filter(([, value]) => value);
        return ['---', ...fields.map(([key, value]) => `${key}: ${JSON.stringify(String(value))}`), '---', ''];
    }

    function convertConversationToMarkdown(convData, attachmentResult = null) {
        const messages = extractConversationMessages(convData, attachmentResult);
        const mdLines = buildMarkdownFrontMatter(convData);
        if (messages.length === 0) {
            mdLines.push('# Conversation', 'No visible user or assistant messages were exported.', '');
        }
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

    // tone 为 'done' / 'error' 时显示结束状态，否则根据文本中的 (n/total) 显示进度环。
    function setFabStatus(btn, text, tone = null) {
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
        const progress = tone ? null : /\((\d+)\s*\/\s*(\d+)\)\s*$/.exec(text);
        if (progress && Number(progress[2]) > 0) {
            const pct = Math.min(100, Math.round((Number(progress[1]) / Number(progress[2])) * 100));
            btn.classList.add('gre-progress');
            if (ring) ring.style.setProperty('--gre-pct', String(pct));
            if (badge) badge.textContent = `${pct}%`;
        } else if (tone === 'done') {
            btn.classList.add('gre-done');
            if (badge) badge.textContent = '✓';
        } else if (tone === 'error') {
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

    function cancelActiveExport() {
        if (!activeExport || activeExport.cancelled) return;
        activeExport.cancelled = true;
        activeExport.progress('正在停止…');
    }

    function requestCancelActiveExport() {
        if (!activeExport || activeExport.cancelled) return;
        if (!confirm('要停止当前导出吗？已经导出的对话会照常打包下载。')) return;
        cancelActiveExport();
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

    function buildExportSummary(errorReport, { skippedUnchanged = 0, zipCreated = true } = {}) {
        const clean = errorReport.issues.length === 0 && !errorReport.stopped_reason;
        const lines = [];
        if (clean) {
            lines.push(`共导出 ${errorReport.succeeded} 个对话。`);
        } else {
            if (errorReport.stopped_reason) {
                lines.push(`导出已提前停止${zipCreated ? '，ZIP 中只包含停止前导出的对话' : ''}。原因：${errorReport.stopped_reason}`);
            }
            lines.push(`成功 ${errorReport.succeeded}，部分成功（已存 JSON，缺 Markdown 或附件）${errorReport.partial}，失败 ${errorReport.failed}。`);
            const listFailures = errorReport.issues.filter(issue => issue.stage === 'list').length;
            if (listFailures > 0) lines.push(`另有 ${listFailures} 处对话列表获取失败，可能漏掉了部分项目对话。`);
        }
        if (skippedUnchanged > 0) {
            lines.push(`增量导出：跳过了 ${skippedUnchanged} 个自上次导出后没有变化的对话。`);
        }
        if (!clean) {
            lines.push(zipCreated
                ? '详情见 ZIP 内的 export-error-report.json。'
                : '没有导出任何对话，因此没有生成 ZIP。详情请查看控制台。');
        }
        let title = '导出完成';
        if (!zipCreated) title = '导出失败';
        else if (errorReport.stopped_reason) title = '导出已停止';
        else if (!clean) title = '导出完成，部分内容失败';
        return { tone: clean ? 'ok' : zipCreated ? 'warn' : 'error', title, message: lines.join('\n') };
    }
    // --- 增量导出记录：按账户记住每个对话上次导出时的更新时间，以及最近一次导出的时间 ---
    const EXPORT_HISTORY_KEY = 'chatgpt-exporter-history-v1';

    function exportHistoryStorageKey(accountId) {
        return `${EXPORT_HISTORY_KEY}:${accountId || 'default'}`;
    }

    // 早期版本直接存 { 对话 ID: 更新时间 }，读取时兼容这种格式。
    function loadExportHistory(accountId) {
        try {
            const saved = JSON.parse(localStorage.getItem(exportHistoryStorageKey(accountId)));
            if (saved && typeof saved.items === 'object' && saved.items) {
                return { items: saved.items, lastExportAt: Number(saved.lastExportAt) || null };
            }
            if (saved && typeof saved === 'object') return { items: saved, lastExportAt: null };
        } catch (_) {}
        return { items: {}, lastExportAt: null };
    }

    function saveExportHistory(accountId, history, exported) {
        exported.forEach(({ id, updateTime }) => {
            if (id && updateTime) history.items[id] = Math.max(updateTime, Number(history.items[id]) || 0);
        });
        history.lastExportAt = Date.now();
        try {
            localStorage.setItem(exportHistoryStorageKey(accountId), JSON.stringify(history));
        } catch (error) {
            console.warn('[ChatGPT Exporter] 保存增量导出记录失败:', error);
        }
    }

    function clearExportHistory(accountId) {
        try {
            localStorage.removeItem(exportHistoryStorageKey(accountId));
        } catch (_) {}
    }

    // 'new'：从未导出；'updated'：导出后又有更新；'exported'：导出后没有变化。
    function exportStatusOf(entry, items) {
        const exportedAt = Number(items[entry.id]) || 0;
        if (!exportedAt) return 'new';
        const updatedAt = normalizeEpochSeconds(entry.update_time) || 0;
        return updatedAt > exportedAt ? 'updated' : 'exported';
    }

    function isUnchangedSinceLastExport(entry, history) {
        return exportStatusOf(entry, history.items) === 'exported' && Boolean(normalizeEpochSeconds(entry.update_time));
    }

    function formatShortDateTime(ms) {
        const date = new Date(ms);
        const pad = value => String(value).padStart(2, '0');
        const sameYear = date.getFullYear() === new Date().getFullYear();
        const day = sameYear ? `${date.getMonth() + 1}/${date.getDate()}` : `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
        return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    function describeExportHistory(history) {
        const count = Object.keys(history.items).length;
        if (count === 0) return '还没有导出记录，这次会导出全部对话';
        const last = history.lastExportAt ? ` · 上次导出 ${formatShortDateTime(history.lastExportAt)}` : '';
        return `已记录 ${count.toLocaleString()} 个对话${last}`;
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

    let resultSeq = 0;

    function showExportResult({ tone = 'info', title, message }) {
        const panel = taskPanelEl();
        resultSeq += 1;
        panel.dataset.state = 'result';
        panel.dataset.tone = tone;
        panel.dataset.resultSeq = String(resultSeq);
        panel.querySelector('.gre-task-title').textContent = title;
        panel.querySelector('.gre-task-body').textContent = message;
        panel.querySelector('.gre-task-count').textContent = '';
        panel.querySelector('.gre-progress-bar').hidden = true;
        panel.querySelector('.gre-task-actions').hidden = true;
        panel.querySelector('.gre-task-close').hidden = false;
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
            showNotice('已有导出任务正在进行，可以在右下角的面板中停止。');
            return;
        }
        const btn = getExportButton();
        if (!await ensureAccessToken()) {
            showExportResult({ tone: 'error', title: '无法开始导出', message: ACCESS_TOKEN_HINT });
            return;
        }

        const session = createTaskSession(text => {
            setFabStatus(btn, text);
            showTaskProgress(text);
        });
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
        let finalStatus = ['出错', 'error'];

        try {
            let entries = conversationEntries;
            if (!selected) {
                session.progress('正在读取对话列表…');
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
                finalStatus = ['完成', 'done'];
                const listProblems = errorReport.issues.length > 0
                    ? `\n另有 ${errorReport.issues.length} 处对话列表获取失败，详情请查看控制台。`
                    : '';
                showExportResult(skippedUnchanged > 0
                    ? { tone: 'ok', title: '没有需要导出的对话', message: `${skippedUnchanged} 个对话自上次导出后都没有变化，没有生成 ZIP。${listProblems}` }
                    : { tone: 'info', title: '没有找到对话', message: `没有找到可以导出的对话。${listProblems}` });
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
                const label = entry?.title ? entry.title.slice(0, 40) : '对话';
                session.progress(`${label} (${i + 1}/${entries.length})`);
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
                showExportResult(buildExportSummary(errorReport, { skippedUnchanged, zipCreated: false }));
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
                session.progress(`正在打包 ZIP (${percent}/100)`);
            });
            downloadFile(blob, buildZipFilename({ mode, workspaceId, selected, incremental: incremental && !selected }));
            saveExportHistory(accountId, history, exported);

            const summary = buildExportSummary(errorReport, { skippedUnchanged });
            if (attachmentReport) {
                summary.message += `\n附件：检测 ${attachmentReport.detected}，成功 ${attachmentReport.downloaded}，失败 ${attachmentReport.failed}。`;
            }
            finalStatus = hasIssues ? ['部分完成', 'error'] : ['完成', 'done'];
            showExportResult(summary);
        } catch (error) {
            if (error?.cancelled) {
                finalStatus = ['已取消', 'error'];
                showExportResult({ tone: 'info', title: '已取消导出', message: '还没有导出任何对话，因此没有生成 ZIP。' });
            } else {
                console.error('导出过程中发生严重错误:', error);
                showExportResult({ tone: 'error', title: '导出失败', message: `${error.message}\n详情请查看控制台（F12 → Console）。` });
            }
        } finally {
            activeExport = null;
            setFabStatus(btn, ...finalStatus);
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
                if (await ensureAccessToken({ forceRefresh: true })) continue;
            }
            if (response.status === 429 && rateLimitRetries < RATE_LIMIT_RETRY_DELAYS.length) {
                const delay = retryAfterMs(response) ?? RATE_LIMIT_RETRY_DELAYS[rateLimitRetries];
                rateLimitRetries++;
                if (session) {
                    await session.wait(delay, seconds => `接口限流，${seconds} 秒后重试…`);
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
                session?.progress(`正在读取对话列表，已找到 ${map.size} 个`);
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
            session?.progress('正在读取项目列表…');
            const query = mode === 'team' ? {} : { conversationsPerGizmo: PROJECT_SIDEBAR_PREVIEW, ownedOnly: true };
            projects = await listProjects(accountId, session, query);
        } catch (error) {
            if (mode === 'project' || error?.stopsBatch) throw error;
            problems.push({ folder: null, error });
        }

        for (const project of projects) {
            session?.progress(`正在读取项目「${project.title}」，已找到 ${map.size} 个`);
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

    const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[ch]);

    const ICONS = {
        close: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>',
        chevron: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
        check: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
        search: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>'
    };

    // ChatGPT 页面的全局样式会重置原生 checkbox / select 的外观，所以这里的勾选框、开关和下拉框都自己绘制。
    // 颜色跟随页面的 html.dark；只用中性色加一个墨色强调，和 ChatGPT 自身的界面保持一致。
    function ensureUiStyle() {
        if (document.getElementById('gre-ui-style')) return;
        const style = document.createElement('style');
        style.id = 'gre-ui-style';
        style.textContent = `
.gre-theme {
    --gre-bg: #fff; --gre-elev: #fff; --gre-fg: #0d0d0d; --gre-muted: #5d5d5d; --gre-faint: #8f8f8f;
    --gre-line: rgba(13, 13, 13, .1); --gre-line-strong: rgba(13, 13, 13, .2); --gre-hover: rgba(13, 13, 13, .05);
    --gre-ink: #0d0d0d; --gre-ink-fg: #fff; --gre-danger: #d93025;
    --gre-shadow: 0 1px 2px rgba(0, 0, 0, .06), 0 10px 30px rgba(0, 0, 0, .12);
    font-family: ui-sans-serif, -apple-system, system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    font-size: 14px; line-height: 1.5; color: var(--gre-fg); color-scheme: light;
    -webkit-font-smoothing: antialiased;
}
html.dark .gre-theme {
    --gre-bg: #2f2f2f; --gre-elev: #383838; --gre-fg: #ececec; --gre-muted: #b4b4b4; --gre-faint: #8e8e8e;
    --gre-line: rgba(255, 255, 255, .1); --gre-line-strong: rgba(255, 255, 255, .22); --gre-hover: rgba(255, 255, 255, .07);
    --gre-ink: #ececec; --gre-ink-fg: #0d0d0d; --gre-danger: #ff7b72;
    --gre-shadow: 0 1px 2px rgba(0, 0, 0, .3), 0 12px 32px rgba(0, 0, 0, .45);
    color-scheme: dark;
}
.gre-theme *, .gre-theme *::before, .gre-theme *::after { box-sizing: border-box; }
.gre-theme [hidden] { display: none !important; }
/* :where() 不增加优先级，组件自己的 class 规则才能覆盖这些基础样式 */
:where(.gre-theme) button { margin: 0; font: inherit; color: inherit; }
:where(.gre-theme) svg { display: block; flex: none; }
.gre-theme :focus-visible { outline: 2px solid var(--gre-ink); outline-offset: 2px; }
.gre-theme .gre-input:focus-visible { outline: none; }

.gre-overlay {
    position: fixed; inset: 0; z-index: 99998; padding: 16px;
    display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, .4);
}
html.dark .gre-overlay { background: rgba(0, 0, 0, .6); }
.gre-dialog {
    position: relative; display: flex; flex-direction: column; width: 100%; max-width: 400px;
    max-height: calc(100vh - 32px); background: var(--gre-bg); border-radius: 16px; box-shadow: var(--gre-shadow);
}
html.dark .gre-dialog { box-shadow: var(--gre-shadow), inset 0 0 0 1px var(--gre-line); }
.gre-dialog.gre-wide { max-width: 680px; height: min(760px, calc(100vh - 32px)); }
.gre-head { display: flex; align-items: center; gap: 10px; padding: 18px 20px 14px; }
.gre-head h2 { margin: 0; font-size: 17px; font-weight: 600; line-height: 1.3; color: var(--gre-fg); }
.gre-sub { color: var(--gre-faint); font-size: 13px; }
.gre-icon-btn {
    display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; margin: -6px -8px -6px auto;
    padding: 0; border: 0; border-radius: 8px; background: transparent; color: var(--gre-muted); cursor: pointer;
}
.gre-icon-btn:hover { background: var(--gre-hover); color: var(--gre-fg); }
.gre-body { padding: 0 20px 4px; }
.gre-foot { display: flex; align-items: center; gap: 8px; padding: 16px 20px 18px; }
.gre-foot.gre-divided { border-top: 1px solid var(--gre-line); padding-top: 14px; }
.gre-spacer { flex: 1; }

.gre-seg { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 2px; padding: 3px; border-radius: 10px; background: var(--gre-hover); }
.gre-seg button {
    height: 32px; padding: 0; border: 0; border-radius: 7px; background: transparent;
    color: var(--gre-muted); font-size: 14px; cursor: pointer; transition: background-color .15s, color .15s;
}
.gre-seg button:hover { color: var(--gre-fg); }
.gre-seg button[aria-checked="true"] { background: var(--gre-bg); color: var(--gre-fg); font-weight: 500; box-shadow: 0 1px 3px rgba(0, 0, 0, .1); }
html.dark .gre-seg button[aria-checked="true"] { background: var(--gre-elev); }

.gre-rows { margin-top: 10px; }
.gre-rows > * + * { border-top: 1px solid var(--gre-line); }
.gre-toggle {
    display: flex; align-items: center; gap: 12px; width: 100%; padding: 12px 0;
    border: 0; background: transparent; text-align: left; cursor: pointer;
}
.gre-toggle-text { flex: 1; }
.gre-switch { position: relative; flex: none; width: 32px; height: 20px; border-radius: 999px; background: var(--gre-line-strong); transition: background-color .15s; }
.gre-switch::after {
    content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%;
    background: #fff; box-shadow: 0 1px 2px rgba(0, 0, 0, .25); transition: transform .15s;
}
[aria-checked="true"] > .gre-switch { background: var(--gre-ink); }
[aria-checked="true"] > .gre-switch::after { transform: translateX(12px); background: var(--gre-ink-fg); }
.gre-foot .gre-toggle { width: auto; padding: 0; flex-direction: row-reverse; gap: 8px; color: var(--gre-muted); font-size: 13px; }
.gre-field { display: flex; align-items: center; gap: 12px; padding: 12px 0 0; }
.gre-field-label { color: var(--gre-muted); flex: none; }
.gre-field .gre-dd, .gre-field .gre-input { flex: 1; min-width: 0; }
.gre-field .gre-chip { width: 100%; min-width: 0; justify-content: space-between; }
.gre-field .gre-chip > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.gre-dialog:focus { outline: none; }
.gre-history { display: flex; align-items: baseline; gap: 10px; margin-top: -4px; padding: 0 0 8px; }

.gre-btn {
    display: inline-flex; align-items: center; justify-content: center; height: 36px; padding: 0 16px;
    border: 1px solid var(--gre-line-strong); border-radius: 999px; background: transparent;
    color: var(--gre-fg); font-size: 14px; font-weight: 500; white-space: nowrap; cursor: pointer;
    transition: background-color .15s, opacity .15s;
}
.gre-btn:hover:not(:disabled) { background: var(--gre-hover); }
.gre-btn:disabled { opacity: .35; cursor: default; }
.gre-btn-primary { border-color: transparent; background: var(--gre-ink); color: var(--gre-ink-fg); }
.gre-btn-primary:hover:not(:disabled) { background: var(--gre-ink); opacity: .85; }
.gre-btn-ghost { border-color: transparent; }
.gre-link {
    padding: 0; border: 0; background: transparent; color: var(--gre-muted); font-size: 13px; cursor: pointer;
    text-decoration: underline; text-decoration-color: var(--gre-line-strong); text-underline-offset: 3px;
}
.gre-link:hover:not(:disabled) { color: var(--gre-fg); }
.gre-link:disabled { text-decoration: none; cursor: default; }

.gre-input {
    height: 36px; padding: 0 12px; border: 1px solid var(--gre-line-strong); border-radius: 10px; outline: none;
    background: transparent; color: var(--gre-fg); font: inherit; font-size: 14px; min-width: 0;
}
.gre-input:focus { border-color: var(--gre-ink); }
.gre-input::placeholder { color: var(--gre-faint); }
.gre-search { position: relative; display: flex; align-items: center; margin: 0; }
.gre-search svg { position: absolute; left: 12px; color: var(--gre-faint); pointer-events: none; }
.gre-search .gre-input { width: 100%; padding-left: 36px; }

.gre-filters { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.gre-dd { position: relative; }
.gre-chip {
    display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 8px 0 12px;
    border: 1px solid var(--gre-line-strong); border-radius: 999px; background: transparent;
    color: var(--gre-fg); font-size: 13px; white-space: nowrap; cursor: pointer; transition: background-color .15s, border-color .15s;
}
.gre-chip-k { color: var(--gre-muted); }
.gre-chip svg { color: var(--gre-faint); }
.gre-chip:hover, .gre-chip[aria-expanded="true"] { background: var(--gre-hover); }
.gre-chip[data-active="true"] { border-color: var(--gre-ink); }
.gre-menu {
    position: absolute; top: calc(100% + 4px); left: 0; z-index: 5; min-width: 100%; padding: 4px;
    border: 1px solid var(--gre-line); border-radius: 12px; background: var(--gre-elev); box-shadow: var(--gre-shadow);
}
.gre-menu button {
    display: flex; align-items: center; gap: 16px; width: 100%; height: 32px; padding: 0 10px;
    border: 0; border-radius: 8px; background: transparent; font-size: 13px; text-align: left; white-space: nowrap; cursor: pointer;
}
.gre-menu button:hover, .gre-menu button:focus-visible { background: var(--gre-hover); outline: none; }
.gre-menu button svg { margin-left: auto; visibility: hidden; }
.gre-menu button[aria-checked="true"] svg { visibility: visible; }
.gre-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.gre-range { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.gre-range .gre-input { height: 32px; font-size: 13px; }

.gre-listhead { display: flex; align-items: center; gap: 12px; margin-top: 14px; padding: 10px 20px; border-top: 1px solid var(--gre-line); border-bottom: 1px solid var(--gre-line); }
.gre-selectall { display: inline-flex; align-items: center; gap: 12px; padding: 0; border: 0; background: transparent; font-size: 13px; font-weight: 500; cursor: pointer; }
.gre-selectall:disabled { opacity: .4; cursor: default; }
.gre-count { color: var(--gre-muted); font-size: 13px; }
.gre-count.gre-error { color: var(--gre-danger); }
.gre-listhead .gre-link { margin-left: auto; }
.gre-list { flex: 1; min-height: 120px; overflow: auto; padding: 4px 8px; }
.gre-item { display: flex; align-items: center; gap: 12px; padding: 9px 12px; border-radius: 10px; cursor: pointer; user-select: none; -webkit-user-select: none; }
.gre-item:hover { background: var(--gre-hover); }
.gre-item:focus-visible { outline-offset: -2px; }
.gre-item-main { flex: 1; min-width: 0; }
.gre-item-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gre-item-meta { margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--gre-faint); font-size: 12px; }
.gre-item-date { flex: none; color: var(--gre-faint); font-size: 12px; font-variant-numeric: tabular-nums; }
.gre-box {
    display: inline-flex; align-items: center; justify-content: center; flex: none; width: 18px; height: 18px;
    border: 1.5px solid var(--gre-faint); border-radius: 5px; color: var(--gre-ink-fg);
    transition: background-color .12s, border-color .12s;
}
[aria-checked="true"] > .gre-box, [aria-checked="mixed"] > .gre-box { background: var(--gre-ink); border-color: var(--gre-ink); }
.gre-box svg, .gre-box i { display: none; }
[aria-checked="true"] > .gre-box svg { display: block; }
[aria-checked="mixed"] > .gre-box i { display: block; width: 8px; height: 2px; border-radius: 1px; background: currentColor; }
.gre-empty { padding: 48px 12px; text-align: center; color: var(--gre-faint); }
.gre-more { display: flex; margin: 8px auto; height: 30px; font-size: 13px; }
.gre-error { color: var(--gre-danger); font-size: 13px; }

#gre-task-panel {
    position: fixed; right: 16px; bottom: 16px; z-index: 99999; width: min(340px, calc(100vw - 32px));
    padding: 14px 16px; border: 1px solid var(--gre-line); border-radius: 14px; background: var(--gre-bg); box-shadow: var(--gre-shadow);
}
.gre-task-head { display: flex; align-items: center; gap: 8px; min-height: 22px; }
.gre-task-title { font-weight: 600; }
#gre-task-panel[data-tone="error"] .gre-task-title { color: var(--gre-danger); }
.gre-task-count { margin-left: auto; color: var(--gre-muted); font-size: 13px; font-variant-numeric: tabular-nums; }
.gre-task-close { width: 28px; height: 28px; }
.gre-task-body { margin-top: 2px; max-height: 40vh; overflow: auto; color: var(--gre-muted); font-size: 13px; white-space: pre-wrap; word-break: break-word; }
.gre-progress-bar { height: 4px; margin-top: 12px; overflow: hidden; border-radius: 999px; background: var(--gre-hover); }
.gre-progress-bar > span { display: block; width: 0; height: 100%; border-radius: inherit; background: var(--gre-ink); transition: width .2s; }
.gre-task-actions { display: flex; justify-content: flex-end; margin-top: 12px; }
.gre-task-actions .gre-btn { height: 30px; padding: 0 14px; font-size: 13px; }
#gre-toast {
    position: fixed; left: 50%; bottom: 24px; z-index: 100000; max-width: calc(100vw - 32px); transform: translateX(-50%);
    padding: 10px 16px; border-radius: 12px; background: var(--gre-ink); color: var(--gre-ink-fg); font-size: 13px; box-shadow: var(--gre-shadow);
}
@media (max-width: 560px) {
    .gre-dialog.gre-wide { height: calc(100vh - 32px); }
    .gre-item-date { display: none; }
}
`;
        document.head.appendChild(style);
    }

    let activeMenu = null;
    function closeActiveMenu() {
        if (!activeMenu) return false;
        activeMenu.close();
        return true;
    }

    // 只有在遮罩上按下并松开才算点击遮罩，避免在弹窗里拖选文字时误关；Esc 先关闭展开的下拉菜单。
    function openModal({ wide = false, labelledBy = null, onRequestClose }) {
        ensureUiStyle();
        const existing = document.getElementById('export-dialog-overlay');
        if (existing) existing.__greClose ? existing.__greClose() : existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'export-dialog-overlay';
        overlay.className = 'gre-theme gre-overlay';
        const dialog = document.createElement('div');
        dialog.id = 'export-dialog';
        dialog.className = wide ? 'gre-dialog gre-wide' : 'gre-dialog';
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        if (labelledBy) dialog.setAttribute('aria-labelledby', labelledBy);
        overlay.appendChild(dialog);

        let pressedOnOverlay = false;
        overlay.addEventListener('mousedown', e => { pressedOnOverlay = e.target === overlay; });
        overlay.addEventListener('click', e => {
            if (pressedOnOverlay && e.target === overlay) onRequestClose();
            pressedOnOverlay = false;
        });
        const onKeydown = e => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            if (!closeActiveMenu()) onRequestClose();
        };
        document.addEventListener('keydown', onKeydown, true);
        const close = () => {
            closeActiveMenu();
            document.removeEventListener('keydown', onKeydown, true);
            overlay.remove();
        };
        overlay.__greClose = close;
        document.body.appendChild(overlay);
        return { overlay, dialog, close };
    }

    function createDropdown({ id, label, options, value, onChange, renderValue = null }) {
        const wrap = document.createElement('div');
        wrap.className = 'gre-dd';
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.id = id;
        chip.className = 'gre-chip';
        chip.setAttribute('aria-haspopup', 'menu');
        chip.setAttribute('aria-expanded', 'false');
        const menu = document.createElement('div');
        menu.className = 'gre-menu';
        menu.setAttribute('role', 'menu');
        wrap.appendChild(chip);

        let current = value;
        const labelText = () => (typeof label === 'function' ? label() : label);
        const render = () => {
            const option = options.find(item => item.value === current) || options[0];
            const valueHtml = renderValue ? renderValue(option) : escapeHtml(option.label);
            const key = labelText();
            chip.innerHTML = `${key ? `<span class="gre-chip-k">${escapeHtml(key)}</span>` : ''}<span>${valueHtml}</span>${ICONS.chevron}`;
            chip.dataset.active = String(Boolean(key) && current !== options[0].value);
        };
        const onOutside = e => { if (!wrap.contains(e.target)) api.close(); };
        const api = {
            el: wrap,
            get value() { return current; },
            refresh: render,
            close() {
                menu.remove();
                chip.setAttribute('aria-expanded', 'false');
                document.removeEventListener('mousedown', onOutside, true);
                if (activeMenu === api) activeMenu = null;
            }
        };
        const open = () => {
            closeActiveMenu();
            menu.innerHTML = '';
            options.forEach(option => {
                const item = document.createElement('button');
                item.type = 'button';
                item.setAttribute('role', 'menuitemradio');
                item.setAttribute('aria-checked', String(option.value === current));
                item.dataset.value = option.value;
                item.innerHTML = `<span>${renderValue ? renderValue(option) : escapeHtml(option.label)}</span>${ICONS.check}`;
                item.onclick = () => {
                    api.close();
                    chip.focus();
                    if (option.value === current) return;
                    current = option.value;
                    render();
                    onChange(current);
                };
                menu.appendChild(item);
            });
            menu.onkeydown = e => {
                if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
                e.preventDefault();
                const items = [...menu.children];
                const index = items.indexOf(document.activeElement);
                items[(index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
            };
            wrap.appendChild(menu);
            chip.setAttribute('aria-expanded', 'true');
            document.addEventListener('mousedown', onOutside, true);
            activeMenu = api;
            (menu.querySelector('[aria-checked="true"]') || menu.firstElementChild)?.focus();
        };
        chip.onclick = () => (activeMenu === api ? api.close() : open());
        render();
        return api;
    }

    const toggleHtml = (id, text, on) => `
        <button type="button" id="${id}" class="gre-toggle" role="switch" aria-checked="${on ? 'true' : 'false'}">
            <span class="gre-toggle-text">${text}</span><span class="gre-switch"></span>
        </button>`;

    function bindToggle(el, onChange) {
        el.onclick = () => {
            const next = el.getAttribute('aria-checked') !== 'true';
            el.setAttribute('aria-checked', String(next));
            onChange(next);
        };
    }

    function taskPanelEl() {
        ensureUiStyle();
        let panel = document.getElementById('gre-task-panel');
        if (panel) return panel;
        panel = document.createElement('div');
        panel.id = 'gre-task-panel';
        panel.className = 'gre-theme';
        panel.setAttribute('role', 'status');
        panel.setAttribute('aria-live', 'polite');
        panel.innerHTML = `
            <div class="gre-task-head">
                <span class="gre-task-title"></span>
                <span class="gre-task-count"></span>
                <button type="button" class="gre-icon-btn gre-task-close" aria-label="关闭" hidden>${ICONS.close}</button>
            </div>
            <div class="gre-task-body"></div>
            <div class="gre-progress-bar" hidden><span></span></div>
            <div class="gre-task-actions" hidden><button type="button" class="gre-btn gre-task-stop">停止</button></div>`;
        panel.querySelector('.gre-task-close').onclick = () => panel.remove();
        panel.querySelector('.gre-task-stop').onclick = cancelActiveExport;
        document.body.appendChild(panel);
        return panel;
    }

    function showTaskProgress(text) {
        const panel = taskPanelEl();
        panel.dataset.state = 'progress';
        panel.dataset.tone = 'info';
        const match = /\s*\((\d+)\s*\/\s*(\d+)\)\s*$/.exec(text);
        const done = match ? Number(match[1]) : 0;
        const total = match ? Number(match[2]) : 0;
        const packing = text.startsWith('正在打包');
        panel.querySelector('.gre-task-title').textContent = packing ? '正在打包' : '正在导出';
        panel.querySelector('.gre-task-count').textContent = !match ? '' : packing ? `${done}%` : `${done} / ${total}`;
        panel.querySelector('.gre-task-body').textContent = match ? text.slice(0, match.index) : text;
        const bar = panel.querySelector('.gre-progress-bar');
        bar.hidden = !match || total === 0;
        if (total > 0) bar.firstElementChild.style.width = `${Math.min(100, (done / total) * 100)}%`;
        panel.querySelector('.gre-task-actions').hidden = false;
        const stop = panel.querySelector('.gre-task-stop');
        stop.disabled = Boolean(activeExport?.cancelled);
        stop.textContent = activeExport?.cancelled ? '正在停止…' : '停止';
        panel.querySelector('.gre-task-close').hidden = true;
    }

    let toastTimer = null;
    function showNotice(message) {
        ensureUiStyle();
        let toast = document.getElementById('gre-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'gre-toast';
            toast.className = 'gre-theme';
            toast.setAttribute('role', 'alert');
            document.body.appendChild(toast);
        }
        toast.textContent = message;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast.remove(), 6000);
    }

    const SPACE_LABELS = { personal: '个人空间', project: '项目空间', team: '团队空间' };
    const formatDate = value => {
        const seconds = normalizeEpochSeconds(value);
        return seconds ? new Date(seconds * 1000).toLocaleDateString() : '';
    };

    function showConversationPicker(options = {}) {
        const { mode = 'personal', workspaceId = null, includeAttachments = false, incremental = false } = options;
        const state = {
            loading: true,
            loadError: null,
            listWarning: null,
            list: [],
            filtered: [],
            selected: new Set(),
            anchorIndex: null,
            query: '',
            sort: 'update-desc',
            scope: 'all',
            archived: 'all',
            timeRange: 'all',
            exportStatus: 'all',
            startDate: '',
            endDate: '',
            pageSize: 100,
            visibleCount: 100,
            includeAttachments: Boolean(includeAttachments)
        };
        const timeField = () => (state.sort.startsWith('create') ? 'create_time' : 'update_time');
        const history = loadExportHistory(resolveWorkspaceId(workspaceId));
        const hasHistory = Object.keys(history.items).length > 0;
        const STATUS_LABELS = { new: '未导出', updated: '有更新' };

        // 关闭选择器时停止仍在进行的列表加载，避免关闭后继续请求接口。
        const listSession = createTaskSession(text => {
            if (state.loading) statusEl.textContent = text;
        });
        const closeDialog = () => {
            listSession.cancelled = true;
            modal.close();
        };
        const requestClose = () => {
            if (state.selected.size > 0 && !confirm(`关闭后会丢失已选的 ${state.selected.size} 个对话，确定关闭吗？`)) return;
            closeDialog();
        };
        const modal = openModal({ wide: true, labelledBy: 'gre-picker-title', onRequestClose: requestClose });
        const { dialog } = modal;

        dialog.innerHTML = `
            <div class="gre-head">
                <h2 id="gre-picker-title">选择对话</h2>
                <span class="gre-sub">${SPACE_LABELS[mode] || SPACE_LABELS.personal}</span>
                <button type="button" id="gre-close-btn" class="gre-icon-btn" aria-label="关闭">${ICONS.close}</button>
            </div>
            <div class="gre-body">
                <label class="gre-search">${ICONS.search}
                    <input id="conv-search" class="gre-input" type="search" placeholder="搜索标题、项目或 ID" aria-label="搜索对话" autocomplete="off">
                </label>
                <div id="gre-filters" class="gre-filters"></div>
                <div id="gre-range" class="gre-range" hidden>
                    <input id="filter-start-date" class="gre-input" type="date" aria-label="开始日期">
                    <span class="gre-count">至</span>
                    <input id="filter-end-date" class="gre-input" type="date" aria-label="结束日期">
                </div>
            </div>
            <div class="gre-listhead">
                <button type="button" id="select-all-btn" class="gre-selectall" role="checkbox" aria-checked="false" disabled>
                    <span class="gre-box">${ICONS.check}<i></i></span>全选
                </button>
                <span id="conv-status" class="gre-count" role="status">正在加载…</span>
                <button type="button" id="clear-all-btn" class="gre-link" hidden>清除选择</button>
            </div>
            <div id="conv-list" class="gre-list" role="group" aria-labelledby="gre-picker-title"></div>
            <div class="gre-foot gre-divided">
                ${toggleHtml('include-attachments-picker', '包含附件', state.includeAttachments)}
                <span class="gre-spacer"></span>
                <button type="button" id="back-btn" class="gre-btn gre-btn-ghost">返回</button>
                <button type="button" id="export-selected-btn" class="gre-btn gre-btn-primary" disabled>导出</button>
            </div>
        `;

        const $ = selector => dialog.querySelector(selector);
        const statusEl = $('#conv-status');
        const listEl = $('#conv-list');
        const selectAllBtn = $('#select-all-btn');
        const clearAllBtn = $('#clear-all-btn');
        const exportBtn = $('#export-selected-btn');
        const rangeEl = $('#gre-range');

        const refilter = () => {
            applyFilters();
            renderList();
        };
        const filtersEl = $('#gre-filters');
        const timeDropdown = createDropdown({
            id: 'filter-time',
            label: () => (timeField() === 'create_time' ? '创建于' : '更新于'),
            value: 'all',
            options: [
                { value: 'all', label: '不限' },
                { value: '7', label: '最近 7 天' },
                { value: '30', label: '最近 30 天' },
                { value: '90', label: '最近 90 天' },
                { value: 'year', label: '今年' },
                { value: 'custom', label: '自定义' }
            ],
            onChange: value => {
                state.timeRange = value;
                rangeEl.hidden = value !== 'custom';
                refilter();
            }
        });
        const sortDropdown = createDropdown({
            id: 'filter-sort',
            label: '排序',
            value: state.sort,
            options: [
                { value: 'update-desc', label: '最近更新' },
                { value: 'create-desc', label: '最近创建' },
                { value: 'create-asc', label: '最早创建' }
            ],
            onChange: value => {
                state.sort = value;
                timeDropdown.refresh();
                refilter();
            }
        });
        filtersEl.appendChild(sortDropdown.el);
        if (mode !== 'project') {
            filtersEl.appendChild(createDropdown({
                id: 'filter-scope',
                label: '范围',
                value: 'all',
                options: [
                    { value: 'all', label: '全部' },
                    { value: 'project', label: '项目内' },
                    { value: 'root', label: '项目外' }
                ],
                onChange: value => { state.scope = value; refilter(); }
            }).el);
        }
        filtersEl.appendChild(createDropdown({
            id: 'filter-archived',
            label: '状态',
            value: 'all',
            options: [
                { value: 'all', label: '全部' },
                { value: 'active', label: '未归档' },
                { value: 'archived', label: '已归档' }
            ],
            onChange: value => { state.archived = value; refilter(); }
        }).el);
        filtersEl.appendChild(timeDropdown.el);
        if (hasHistory) {
            filtersEl.appendChild(createDropdown({
                id: 'filter-export-status',
                label: '导出状态',
                value: 'all',
                options: [
                    { value: 'all', label: '全部' },
                    { value: 'changed', label: '有变化' },
                    { value: 'exported', label: '已导出' }
                ],
                onChange: value => { state.exportStatus = value; refilter(); }
            }).el);
        }

        $('#gre-close-btn').onclick = requestClose;
        $('#conv-search').oninput = e => { state.query = e.target.value || ''; refilter(); };
        $('#filter-start-date').onchange = e => { state.startDate = e.target.value || ''; refilter(); };
        $('#filter-end-date').onchange = e => { state.endDate = e.target.value || ''; refilter(); };
        bindToggle($('#include-attachments-picker'), value => { state.includeAttachments = value; });
        selectAllBtn.onclick = () => {
            const allSelected = state.filtered.length > 0 && state.filtered.every(item => state.selected.has(item.id));
            state.filtered.forEach(item => (allSelected ? state.selected.delete(item.id) : state.selected.add(item.id)));
            refreshSelection();
        };
        clearAllBtn.onclick = () => {
            state.selected.clear();
            state.anchorIndex = null;
            refreshSelection();
        };
        $('#back-btn').onclick = () => {
            closeDialog();
            showExportDialog({ space: mode, includeAttachments: state.includeAttachments, incremental });
        };
        exportBtn.onclick = async () => {
            if (state.selected.size === 0) return;
            const selectedList = state.list.filter(item => state.selected.has(item.id));
            closeDialog();
            await startSelectiveExportProcess(mode, workspaceId, selectedList, state.includeAttachments);
        };

        const timeBounds = () => {
            const now = Date.now() / 1000;
            switch (state.timeRange) {
                case '7':
                case '30':
                case '90':
                    return [now - Number(state.timeRange) * 86400, null];
                case 'year':
                    return [new Date(new Date().getFullYear(), 0, 1).getTime() / 1000, null];
                case 'custom':
                    return [parseDateInputToEpoch(state.startDate, false), parseDateInputToEpoch(state.endDate, true)];
                default:
                    return [null, null];
            }
        };

        const applyFilters = () => {
            const query = state.query.trim().toLowerCase();
            const [startBound, endBound] = timeBounds();
            const field = timeField();
            const direction = state.sort.endsWith('asc') ? 1 : -1;
            state.filtered = state.list.filter(item => {
                const text = `${item.title || ''} ${item.projectTitle || ''} ${item.id || ''}`.toLowerCase();
                if (query && !text.includes(query)) return false;
                if (state.scope === 'project' && !item.projectTitle) return false;
                if (state.scope === 'root' && item.projectTitle) return false;
                if (state.archived === 'active' && item.is_archived) return false;
                if (state.archived === 'archived' && !item.is_archived) return false;
                if (state.exportStatus !== 'all') {
                    const exported = exportStatusOf(item, history.items) === 'exported';
                    if ((state.exportStatus === 'exported') !== exported) return false;
                }
                if (startBound || endBound) {
                    const ts = normalizeEpochSeconds(item[field] || 0);
                    if (!ts) return false;
                    if (startBound && ts < startBound) return false;
                    if (endBound && ts > endBound) return false;
                }
                return true;
            }).sort((a, b) => direction * ((normalizeEpochSeconds(a[field]) || 0) - (normalizeEpochSeconds(b[field]) || 0)));
            state.visibleCount = state.pageSize;
            state.anchorIndex = null;
        };

        // 选中状态变化只更新已有行和统计，不重建列表，避免滚动位置跳回顶部。
        const refreshSelection = () => {
            listEl.querySelectorAll('.gre-item').forEach(row => {
                row.setAttribute('aria-checked', String(state.selected.has(row.dataset.id)));
            });
            const ready = !state.loading && !state.loadError;
            const selectedInView = state.filtered.filter(item => state.selected.has(item.id)).length;
            selectAllBtn.disabled = !ready || state.filtered.length === 0;
            selectAllBtn.setAttribute('aria-checked', selectedInView === 0 ? 'false'
                : selectedInView === state.filtered.length ? 'true' : 'mixed');
            clearAllBtn.hidden = state.selected.size === 0;
            exportBtn.disabled = !ready || state.selected.size === 0;
            exportBtn.textContent = state.selected.size > 0 ? `导出 ${state.selected.size} 个` : '导出';

            statusEl.classList.remove('gre-error');
            statusEl.removeAttribute('title');
            if (state.loading) return;
            if (state.loadError) {
                statusEl.textContent = `加载失败：${state.loadError}`;
                statusEl.classList.add('gre-error');
                return;
            }
            const total = state.filtered.length === state.list.length
                ? `${state.list.length} 个对话`
                : `${state.filtered.length} / ${state.list.length} 个对话`;
            const selected = state.selected.size > 0 ? ` · 已选 ${state.selected.size}` : '';
            statusEl.textContent = total + selected + (state.listWarning ? ' · 部分项目未能读取' : '');
            if (state.listWarning) statusEl.title = state.listWarning;
        };

        const toggleItem = (index, extendRange) => {
            const checked = !state.selected.has(state.filtered[index].id);
            const anchor = state.anchorIndex;
            const useRange = extendRange && anchor !== null && anchor < state.filtered.length;
            const from = useRange ? Math.min(anchor, index) : index;
            const to = useRange ? Math.max(anchor, index) : index;
            for (let i = from; i <= to; i++) {
                const id = state.filtered[i].id;
                if (checked) state.selected.add(id);
                else state.selected.delete(id);
            }
            state.anchorIndex = index;
            refreshSelection();
        };

        const renderRow = (item, index) => {
            const row = document.createElement('div');
            row.className = 'gre-item';
            row.dataset.id = item.id;
            row.tabIndex = 0;
            row.setAttribute('role', 'checkbox');
            row.setAttribute('aria-checked', String(state.selected.has(item.id)));
            row.addEventListener('click', e => toggleItem(index, e.shiftKey));
            row.addEventListener('keydown', e => {
                if (e.key !== ' ' && e.key !== 'Enter') return;
                e.preventDefault();
                toggleItem(index, e.shiftKey);
            });

            const status = hasHistory ? STATUS_LABELS[exportStatusOf(item, history.items)] : null;
            const meta = [status, item.projectTitle, item.is_archived ? '已归档' : null].filter(Boolean).join(' · ');
            const timeValue = item[timeField()];
            row.innerHTML = `
                <span class="gre-box">${ICONS.check}<i></i></span>
                <div class="gre-item-main">
                    <div class="gre-item-title"></div>
                    ${meta ? '<div class="gre-item-meta"></div>' : ''}
                </div>
                <span class="gre-item-date"></span>`;
            row.querySelector('.gre-item-title').textContent = item.title || 'Untitled Conversation';
            if (meta) row.querySelector('.gre-item-meta').textContent = meta;
            const date = row.querySelector('.gre-item-date');
            date.textContent = formatDate(timeValue);
            date.title = `${timeField() === 'create_time' ? '创建' : '更新'}于 ${formatTimestamp(timeValue) || '未知'}`;
            return row;
        };

        const renderList = () => {
            const scrollTop = listEl.scrollTop;
            listEl.innerHTML = '';
            if (state.loading || state.loadError) {
                const note = document.createElement('div');
                note.className = 'gre-empty';
                note.textContent = state.loading ? '正在加载…' : '对话列表加载失败。';
                listEl.appendChild(note);
            } else if (state.filtered.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'gre-empty';
                empty.textContent = state.list.length === 0 ? '这里还没有对话' : '没有匹配的对话';
                listEl.appendChild(empty);
            } else {
                state.filtered.slice(0, state.visibleCount).forEach((item, index) => listEl.appendChild(renderRow(item, index)));
                if (state.filtered.length > state.visibleCount) {
                    const more = document.createElement('button');
                    more.type = 'button';
                    more.className = 'gre-btn gre-more';
                    more.textContent = `再显示 ${Math.min(state.pageSize, state.filtered.length - state.visibleCount)} 个`;
                    more.onclick = () => {
                        state.visibleCount = Math.min(state.visibleCount + state.pageSize, state.filtered.length);
                        renderList();
                    };
                    listEl.appendChild(more);
                }
            }
            listEl.scrollTop = scrollTop;
            refreshSelection();
        };

        renderList();
        (async () => {
            if (!await ensureAccessToken()) throw new Error(ACCESS_TOKEN_HINT);
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
        $('#conv-search').focus();
    }

    function showExportDialog(options = {}) {
        if (document.getElementById('export-dialog-overlay')) return;

        let space = SPACE_LABELS[options.space] ? options.space : 'personal';
        let includeAttachments = Boolean(options.includeAttachments);
        let incremental = Boolean(options.incremental);
        let teamDropdown = null;
        const { dialog, close: closeDialog } = openModal({ labelledBy: 'gre-dialog-title', onRequestClose: () => closeDialog() });

        dialog.innerHTML = `
            <div class="gre-head">
                <h2 id="gre-dialog-title">导出对话</h2>
                <button type="button" id="gre-close-btn" class="gre-icon-btn" aria-label="关闭">${ICONS.close}</button>
            </div>
            <div class="gre-body">
                <div class="gre-seg" role="radiogroup" aria-label="导出范围">
                    <button type="button" role="radio" data-space="personal">个人</button>
                    <button type="button" role="radio" data-space="project">项目</button>
                    <button type="button" role="radio" data-space="team">团队</button>
                </div>
                <div id="gre-team-field" hidden></div>
                <div class="gre-rows">
                    ${toggleHtml('include-attachments', '包含附件', includeAttachments)}
                    ${toggleHtml('incremental-export', '仅导出有变化的对话', incremental)}
                </div>
                <div id="gre-history-row" class="gre-history" hidden>
                    <span id="gre-history-text" class="gre-count"></span>
                    <button type="button" id="clear-history-btn" class="gre-link">清除</button>
                </div>
            </div>
            <div class="gre-foot">
                <span class="gre-spacer"></span>
                <button type="button" id="open-picker-btn" class="gre-btn">选择对话</button>
                <button type="button" id="export-all-btn" class="gre-btn gre-btn-primary">导出全部</button>
            </div>`;

        const $ = selector => dialog.querySelector(selector);
        const teamField = $('#gre-team-field');
        const historyRow = $('#gre-history-row');

        const renderTeamField = () => {
            teamDropdown = null;
            teamField.hidden = space !== 'team';
            if (space !== 'team') return;
            const detectedIds = detectAllWorkspaceIds();
            teamField.innerHTML = `
                <div class="gre-field"><span class="gre-field-label">工作区</span></div>
                <div id="team-id-error" class="gre-error" role="alert" style="margin-top: 6px;" hidden></div>`;
            const row = teamField.querySelector('.gre-field');
            if (detectedIds.length > 0) {
                teamDropdown = createDropdown({
                    id: 'team-id-select',
                    label: '',
                    value: detectedIds[0],
                    options: detectedIds.map(id => ({ value: id, label: id })),
                    renderValue: option => `<span class="gre-mono">${escapeHtml(option.label)}</span>`,
                    onChange: renderHistory
                });
                row.appendChild(teamDropdown.el);
            } else {
                const input = document.createElement('input');
                input.id = 'team-id-input';
                input.className = 'gre-input';
                input.placeholder = '没有检测到，请粘贴工作区 ID';
                input.autocomplete = 'off';
                row.appendChild(input);
            }
        };

        // 增量记录按账户保存：团队空间看所选工作区，个人和项目空间看当前账户。
        const currentAccountId = () => (space === 'team'
            ? (teamDropdown ? teamDropdown.value : null)
            : resolveWorkspaceId(null));
        function renderHistory() {
            historyRow.hidden = !incremental;
            if (!incremental) return;
            const canResolve = space !== 'team' || teamDropdown;
            const history = canResolve ? loadExportHistory(currentAccountId()) : { items: {}, lastExportAt: null };
            $('#gre-history-text').textContent = canResolve ? describeExportHistory(history) : '填写工作区 ID 后按该工作区的记录判断';
            const clearBtn = $('#clear-history-btn');
            clearBtn.hidden = Object.keys(history.items).length === 0;
            clearBtn.disabled = false;
            clearBtn.textContent = '清除';
        }

        const selectSpace = value => {
            space = value;
            dialog.querySelectorAll('[data-space]').forEach(button => {
                button.setAttribute('aria-checked', String(button.dataset.space === space));
            });
            renderTeamField();
            renderHistory();
        };

        const readWorkspaceId = () => {
            if (space !== 'team') return null;
            const value = teamDropdown ? teamDropdown.value : $('#team-id-input')?.value.trim();
            if (value) return value;
            const errorEl = $('#team-id-error');
            errorEl.textContent = '请填写工作区 ID';
            errorEl.hidden = false;
            $('#team-id-input')?.focus();
            return undefined;
        };

        dialog.querySelectorAll('[data-space]').forEach(button => {
            button.onclick = () => selectSpace(button.dataset.space);
        });
        bindToggle($('#include-attachments'), value => { includeAttachments = value; });
        bindToggle($('#incremental-export'), value => {
            incremental = value;
            renderHistory();
        });
        $('#clear-history-btn').onclick = () => {
            if (!confirm('清除后，下一次增量导出会重新导出这个空间的全部对话。确定清除吗？')) return;
            clearExportHistory(currentAccountId());
            renderHistory();
        };
        $('#gre-close-btn').onclick = closeDialog;
        $('#export-all-btn').onclick = () => {
            const workspaceId = readWorkspaceId();
            if (workspaceId === undefined) return;
            closeDialog();
            startExportProcess(space, workspaceId, { includeAttachments, incremental });
        };
        $('#open-picker-btn').onclick = () => {
            const workspaceId = readWorkspaceId();
            if (workspaceId === undefined) return;
            closeDialog();
            showConversationPicker({ mode: space, workspaceId, includeAttachments, incremental });
        };

        selectSpace(space);
        dialog.tabIndex = -1;
        dialog.focus();
    }
    // --- 脚本启动 ---
    // Chrome 扩展版不常驻悬浮按钮（入口是工具栏弹窗），构建时会去掉这一段；
    // 扩展里的按钮只在导出时由 getExportButton() 按需创建，用作进度指示。

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
