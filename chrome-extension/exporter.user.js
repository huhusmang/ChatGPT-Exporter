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
        activeExport.progress('⏹ 正在停止…');
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

    let resultSeq = 0;

    function showExportResult({ tone = 'info', title, message }) {
        const panel = taskPanelEl();
        resultSeq += 1;
        panel.dataset.state = 'result';
        panel.dataset.tone = tone;
        panel.dataset.resultSeq = String(resultSeq);
        panel.querySelector('.gre-task-title').textContent = title;
        panel.querySelector('.gre-task-body').textContent = message;
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
            showNotice('已有导出任务正在进行。可以在右下角的进度面板中停止当前导出。');
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
                const label = entry?.title ? entry.title.slice(0, 24) : '对话';
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
                session.progress(`📦 生成 ZIP 文件 (${percent}/100)`);
            });
            downloadFile(blob, buildZipFilename({ mode, workspaceId, selected, incremental: incremental && !selected }));
            saveExportHistory(accountId, history, exported);

            const summary = buildExportSummary(errorReport, { skippedUnchanged });
            if (attachmentReport) {
                summary.message += `\n附件：检测 ${attachmentReport.detected}，成功 ${attachmentReport.downloaded}，失败 ${attachmentReport.failed}。`;
            }
            finalStatus = hasIssues ? '⚠️ 部分完成' : '✅ 完成';
            showExportResult(summary);
        } catch (error) {
            if (error?.cancelled) {
                finalStatus = '⚠️ 已取消';
                showExportResult({ tone: 'info', title: '已取消导出', message: '还没有导出任何对话，因此没有生成 ZIP。' });
            } else {
                console.error('导出过程中发生严重错误:', error);
                showExportResult({ tone: 'error', title: '导出失败', message: `${error.message}\n详情请查看控制台（F12 → Console）。` });
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
                if (await ensureAccessToken({ forceRefresh: true })) continue;
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

    // 跟随 ChatGPT 页面的 html.dark 切换深色；所有颜色都走 CSS 变量，避免被页面样式覆盖。
    function ensureUiStyle() {
        if (document.getElementById('gre-ui-style')) return;
        const style = document.createElement('style');
        style.id = 'gre-ui-style';
        style.textContent = `
.gre-theme {
    --gre-bg: #fff; --gre-fg: #0d0d0d; --gre-muted: #6b7280; --gre-border: #e5e7eb; --gre-subtle: #f7f7f8;
    --gre-accent: #10a37f; --gre-accent-fg: #fff; --gre-danger: #b91c1c; --gre-warn: #92400e; --gre-warn-bg: #fffbeb;
    --gre-info: #4338ca; --gre-info-bg: #eef2ff; --gre-ok: #166534; --gre-ok-bg: #f0fdf4;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 14px; line-height: 1.45; color: var(--gre-fg); color-scheme: light;
}
html.dark .gre-theme {
    --gre-bg: #212121; --gre-fg: #ececec; --gre-muted: #a1a1aa; --gre-border: #3f3f46; --gre-subtle: #2a2a2a;
    --gre-accent: #19c37d; --gre-accent-fg: #0d0d0d; --gre-danger: #f87171; --gre-warn: #fbbf24; --gre-warn-bg: rgba(251, 191, 36, .1);
    --gre-info: #a5b4fc; --gre-info-bg: rgba(99, 102, 241, .16); --gre-ok: #86efac; --gre-ok-bg: rgba(34, 197, 94, .12);
    color-scheme: dark;
}
.gre-theme *, .gre-theme *::before, .gre-theme *::after { box-sizing: border-box; }
.gre-overlay {
    position: fixed; inset: 0; z-index: 99998; padding: 16px;
    display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, .45);
}
.gre-dialog {
    width: 100%; max-width: 460px; max-height: calc(100vh - 32px); overflow: auto; padding: 22px;
    background: var(--gre-bg); border-radius: 14px; box-shadow: 0 12px 40px rgba(0, 0, 0, .3);
}
.gre-dialog.gre-wide { max-width: 760px; display: flex; flex-direction: column; }
.gre-dialog h2 { margin: 0; font-size: 18px; font-weight: 600; }
.gre-header { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
.gre-muted { color: var(--gre-muted); font-size: 12px; }
.gre-stack { display: flex; flex-direction: column; gap: 10px; }
.gre-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.gre-spread { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
.gre-section { margin-top: 14px; }
.gre-footer { margin-top: 18px; }
.gre-card { padding: 14px 16px; border: 1px solid var(--gre-border); border-radius: 10px; background: var(--gre-subtle); }
.gre-card strong { font-size: 15px; }
.gre-card p { margin: 2px 0 10px; color: var(--gre-muted); font-size: 13px; }
.gre-btn {
    padding: 7px 14px; border: 1px solid var(--gre-border); border-radius: 8px; background: var(--gre-bg);
    color: var(--gre-fg); font: inherit; font-size: 13px; cursor: pointer;
}
.gre-btn:hover:not(:disabled) { background: var(--gre-subtle); }
.gre-btn:disabled { opacity: .5; cursor: not-allowed; }
.gre-btn-primary { background: var(--gre-accent); border-color: var(--gre-accent); color: var(--gre-accent-fg); font-weight: 600; }
.gre-btn-primary:hover:not(:disabled) { background: var(--gre-accent); filter: brightness(1.08); }
.gre-link { padding: 0; border: none; background: none; color: var(--gre-info); font: inherit; font-size: 12px; cursor: pointer; }
.gre-link:hover { text-decoration: underline; }
.gre-theme :focus-visible { outline: 2px solid var(--gre-accent); outline-offset: 1px; }
.gre-option {
    display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; cursor: pointer;
    border: 1px solid var(--gre-border); border-radius: 10px; background: var(--gre-subtle);
}
.gre-option input { margin-top: 3px; accent-color: var(--gre-accent); }
.gre-option strong { display: block; font-size: 13px; font-weight: 600; }
.gre-input {
    padding: 7px 9px; border: 1px solid var(--gre-border); border-radius: 8px; background: var(--gre-bg);
    color: var(--gre-fg); font: inherit; font-size: 13px; min-width: 0;
}
.gre-grow { flex: 1 1 200px; }
.gre-filters { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
.gre-notice { padding: 12px; border-radius: 10px; font-size: 13px; }
.gre-notice p { margin: 0 0 8px; font-weight: 600; }
.gre-notice-info { background: var(--gre-info-bg); color: var(--gre-info); }
.gre-notice-ok { background: var(--gre-ok-bg); color: var(--gre-ok); }
.gre-notice-warn { background: var(--gre-warn-bg); color: var(--gre-warn); }
.gre-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; word-break: break-all; }
.gre-radio { display: flex; align-items: center; gap: 8px; padding: 8px; margin-top: 6px; border-radius: 8px; background: var(--gre-bg); color: var(--gre-fg); cursor: pointer; }
.gre-error { color: var(--gre-danger); font-size: 12px; }
.gre-list {
    flex: 1 1 auto; min-height: 160px; max-height: min(420px, 50vh); overflow: auto;
    margin-top: 8px; padding: 4px; border: 1px solid var(--gre-border); border-radius: 10px;
}
.gre-item { display: flex; gap: 10px; align-items: flex-start; padding: 8px 10px; border-radius: 8px; cursor: pointer; user-select: none; -webkit-user-select: none; }
.gre-item:hover { background: var(--gre-subtle); }
.gre-item.gre-checked { background: var(--gre-info-bg); }
.gre-item input { margin-top: 3px; accent-color: var(--gre-accent); }
.gre-item-title { font-weight: 600; word-break: break-word; }
.gre-item-meta { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-top: 2px; }
.gre-tag { padding: 1px 7px; border-radius: 999px; font-size: 11px; background: var(--gre-info-bg); color: var(--gre-info); }
.gre-tag-warn { background: var(--gre-warn-bg); color: var(--gre-warn); }
.gre-empty { padding: 12px 8px; color: var(--gre-muted); }
.gre-more { width: 100%; margin-top: 4px; }
#conv-status.gre-status-error { color: var(--gre-danger); }
#conv-status.gre-status-warn { color: var(--gre-warn); }

#gre-task-panel {
    position: fixed; right: 16px; bottom: 16px; z-index: 99999; width: min(360px, calc(100vw - 32px));
    padding: 14px 16px; border: 1px solid var(--gre-border); border-left: 4px solid var(--gre-info);
    border-radius: 12px; background: var(--gre-bg); box-shadow: 0 8px 30px rgba(0, 0, 0, .25);
}
#gre-task-panel[data-tone="ok"] { border-left-color: var(--gre-accent); }
#gre-task-panel[data-tone="warn"] { border-left-color: var(--gre-warn); }
#gre-task-panel[data-tone="error"] { border-left-color: var(--gre-danger); }
.gre-task-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 4px; }
.gre-task-title { font-weight: 600; }
.gre-task-body { max-height: 40vh; overflow: auto; font-size: 13px; white-space: pre-wrap; word-break: break-word; }
.gre-task-close { padding: 0 4px; border: none; background: none; color: var(--gre-muted); font-size: 18px; line-height: 1; cursor: pointer; }
.gre-progress-bar { height: 4px; margin-top: 10px; overflow: hidden; border-radius: 999px; background: var(--gre-border); }
.gre-progress-bar > span { display: block; width: 0; height: 100%; background: var(--gre-accent); transition: width .2s; }
.gre-task-actions { display: flex; justify-content: flex-end; margin-top: 10px; }
#gre-toast {
    position: fixed; left: 50%; bottom: 24px; z-index: 100000; max-width: calc(100vw - 32px); transform: translateX(-50%);
    padding: 10px 16px; border: 1px solid var(--gre-border); border-radius: 10px;
    background: var(--gre-bg); box-shadow: 0 8px 24px rgba(0, 0, 0, .2);
}
.gre-theme [hidden] { display: none !important; }
@media (max-width: 560px) {
    .gre-dialog { padding: 16px; }
    .gre-list { max-height: 45vh; }
}
`;
        document.head.appendChild(style);
    }

    // 只有在遮罩上按下并松开才算点击遮罩，避免在弹窗里拖选文字时误关。
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
            onRequestClose();
        };
        document.addEventListener('keydown', onKeydown, true);
        const close = () => {
            document.removeEventListener('keydown', onKeydown, true);
            overlay.remove();
        };
        overlay.__greClose = close;
        document.body.appendChild(overlay);
        return { overlay, dialog, close };
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
                <button type="button" class="gre-task-close" aria-label="关闭" hidden>×</button>
            </div>
            <div class="gre-task-body"></div>
            <div class="gre-progress-bar" hidden><span></span></div>
            <div class="gre-task-actions" hidden><button type="button" class="gre-btn gre-task-stop">停止导出</button></div>`;
        panel.querySelector('.gre-task-close').onclick = () => panel.remove();
        panel.querySelector('.gre-task-stop').onclick = cancelActiveExport;
        document.body.appendChild(panel);
        return panel;
    }

    function showTaskProgress(text) {
        const panel = taskPanelEl();
        panel.dataset.state = 'progress';
        panel.dataset.tone = 'info';
        panel.querySelector('.gre-task-title').textContent = '正在导出';
        panel.querySelector('.gre-task-body').textContent = text;
        const match = /\((\d+)\s*\/\s*(\d+)\)/.exec(text);
        const bar = panel.querySelector('.gre-progress-bar');
        bar.hidden = !match;
        if (match && Number(match[2]) > 0) {
            bar.firstElementChild.style.width = `${Math.min(100, (Number(match[1]) / Number(match[2])) * 100)}%`;
        }
        panel.querySelector('.gre-task-actions').hidden = false;
        const stop = panel.querySelector('.gre-task-stop');
        stop.disabled = Boolean(activeExport?.cancelled);
        stop.textContent = activeExport?.cancelled ? '正在停止…' : '停止导出';
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
            scope: mode === 'project' ? 'project' : 'all',
            scopeLocked: mode === 'project',
            archived: 'all',
            timeField: 'update',
            pageSize: 100,
            visibleCount: 100,
            startDate: '',
            endDate: '',
            includeAttachments: Boolean(includeAttachments)
        };
        // 关闭选择器时停止仍在进行的列表加载，避免关闭后继续请求接口。
        const listSession = createTaskSession(text => {
            const statusEl = dialog.querySelector('#conv-status');
            if (state.loading && statusEl) statusEl.textContent = text;
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
            <div class="gre-header">
                <h2 id="gre-picker-title">选择要导出的对话</h2>
                <span class="gre-muted">${SPACE_LABELS[mode] || SPACE_LABELS.personal}${workspaceId ? `（<span class="gre-code">${escapeHtml(workspaceId)}</span>）` : ''}</span>
            </div>
            <div class="gre-filters">
                <input id="conv-search" class="gre-input gre-grow" type="search" placeholder="搜索标题、项目名或 ID" aria-label="搜索对话">
                <select id="filter-scope" class="gre-input" aria-label="范围">
                    <option value="all">全部范围</option>
                    <option value="project">仅项目</option>
                    <option value="root">仅项目外</option>
                </select>
                <select id="filter-archived" class="gre-input" aria-label="归档状态">
                    <option value="all">全部状态</option>
                    <option value="active">仅未归档</option>
                    <option value="archived">仅已归档</option>
                </select>
            </div>
            <div class="gre-filters">
                <select id="filter-time-field" class="gre-input" aria-label="时间字段">
                    <option value="update">按更新时间</option>
                    <option value="create">按创建时间</option>
                </select>
                <input id="filter-start-date" class="gre-input" type="date" aria-label="开始日期">
                <span class="gre-muted">至</span>
                <input id="filter-end-date" class="gre-input" type="date" aria-label="结束日期">
                <button id="clear-date-btn" class="gre-btn" type="button">清空日期</button>
            </div>
            <label class="gre-option">
                <input id="include-attachments-picker" type="checkbox" ${state.includeAttachments ? 'checked' : ''}>
                <span>
                    <strong>同时下载上传和生成的附件</strong>
                    <span class="gre-muted">开启后导出时间和 ZIP 体积可能明显增加。</span>
                </span>
            </label>
            <div class="gre-spread gre-section">
                <div id="conv-status" class="gre-muted" role="status">正在加载列表…</div>
                <div class="gre-row">
                    <button id="select-all-btn" class="gre-btn" type="button" disabled>全选筛选结果</button>
                    <button id="clear-all-btn" class="gre-btn" type="button" disabled>清空选择</button>
                </div>
            </div>
            <div id="conv-list" class="gre-list" aria-labelledby="gre-picker-title"></div>
            <div class="gre-muted" style="margin-top: 6px;">按住 Shift 点击可以连续选择多个对话。</div>
            <div class="gre-spread gre-footer">
                <button id="back-btn" class="gre-btn" type="button">返回</button>
                <button id="export-selected-btn" class="gre-btn gre-btn-primary" type="button" disabled>导出选中 (0)</button>
            </div>
        `;

        const $ = selector => dialog.querySelector(selector);
        const statusEl = $('#conv-status');
        const listEl = $('#conv-list');
        const selectAllBtn = $('#select-all-btn');
        const clearAllBtn = $('#clear-all-btn');
        const exportBtn = $('#export-selected-btn');

        if (state.scopeLocked) {
            const scopeSelect = $('#filter-scope');
            scopeSelect.value = 'project';
            scopeSelect.disabled = true;
            scopeSelect.title = '项目空间仅包含项目对话';
        }

        const refilter = () => {
            applyFilters();
            renderList();
        };
        $('#conv-search').oninput = e => { state.query = e.target.value || ''; refilter(); };
        $('#filter-scope').onchange = e => { state.scope = e.target.value; refilter(); };
        $('#filter-archived').onchange = e => { state.archived = e.target.value; refilter(); };
        $('#filter-time-field').onchange = e => { state.timeField = e.target.value; refilter(); };
        $('#filter-start-date').onchange = e => { state.startDate = e.target.value || ''; refilter(); };
        $('#filter-end-date').onchange = e => { state.endDate = e.target.value || ''; refilter(); };
        $('#clear-date-btn').onclick = () => {
            state.startDate = '';
            state.endDate = '';
            $('#filter-start-date').value = '';
            $('#filter-end-date').value = '';
            refilter();
        };
        $('#include-attachments-picker').onchange = e => { state.includeAttachments = e.target.checked; };
        selectAllBtn.onclick = () => {
            state.filtered.forEach(item => state.selected.add(item.id));
            refreshSelection();
        };
        clearAllBtn.onclick = () => {
            state.selected.clear();
            state.anchorIndex = null;
            refreshSelection();
        };
        $('#back-btn').onclick = () => {
            closeDialog();
            showExportDialog({ includeAttachments: state.includeAttachments, incremental });
        };
        exportBtn.onclick = async () => {
            if (state.selected.size === 0) return;
            const selectedList = state.list.filter(item => state.selected.has(item.id));
            closeDialog();
            await startSelectiveExportProcess(mode, workspaceId, selectedList, state.includeAttachments);
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
                    const ts = normalizeEpochSeconds((state.timeField === 'create' ? item.create_time : item.update_time) || 0);
                    if (!ts) return false;
                    if (startBound && ts < startBound) return false;
                    if (endBound && ts > endBound) return false;
                }
                return true;
            });
            state.visibleCount = state.pageSize;
            state.anchorIndex = null;
        };

        // 选中状态变化只更新已有行和统计，不重建列表，避免滚动位置跳回顶部。
        const refreshSelection = () => {
            listEl.querySelectorAll('.gre-item').forEach(row => {
                const checked = state.selected.has(row.dataset.id);
                row.classList.toggle('gre-checked', checked);
                row.querySelector('input').checked = checked;
            });
            const ready = !state.loading && !state.loadError;
            selectAllBtn.textContent = `全选筛选结果 (${state.filtered.length})`;
            selectAllBtn.disabled = !ready || state.filtered.length === 0;
            clearAllBtn.disabled = !ready || state.selected.size === 0;
            exportBtn.disabled = !ready || state.selected.size === 0;
            exportBtn.textContent = `导出选中 (${state.selected.size})`;

            statusEl.className = 'gre-muted';
            if (state.loading) return;
            if (state.loadError) {
                statusEl.textContent = `加载失败：${state.loadError}`;
                statusEl.classList.add('gre-status-error');
                return;
            }
            statusEl.textContent = `共 ${state.list.length} 条 · 筛选 ${state.filtered.length} 条 · 已选 ${state.selected.size} 条`
                + (state.listWarning ? `。⚠️ ${state.listWarning}` : '');
            if (state.listWarning) statusEl.classList.add('gre-status-warn');
        };

        const toggleItem = (index, checked, extendRange) => {
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
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.setAttribute('aria-label', item.title || 'Untitled Conversation');
            checkbox.addEventListener('click', e => {
                e.stopPropagation();
                toggleItem(index, checkbox.checked, e.shiftKey);
            });
            row.addEventListener('click', e => toggleItem(index, !state.selected.has(item.id), e.shiftKey));

            const content = document.createElement('div');
            const title = document.createElement('div');
            title.className = 'gre-item-title';
            title.textContent = item.title || 'Untitled Conversation';
            const meta = document.createElement('div');
            meta.className = 'gre-item-meta';
            const time = document.createElement('span');
            time.className = 'gre-muted';
            const timeValue = state.timeField === 'create' ? item.create_time : item.update_time;
            time.textContent = `${state.timeField === 'create' ? '创建' : '更新'}：${formatTimestamp(timeValue) || '未知'}`;
            meta.appendChild(time);
            if (item.projectTitle) {
                const tag = document.createElement('span');
                tag.className = 'gre-tag';
                tag.textContent = `项目：${item.projectTitle}`;
                meta.appendChild(tag);
            }
            if (item.is_archived) {
                const tag = document.createElement('span');
                tag.className = 'gre-tag gre-tag-warn';
                tag.textContent = '已归档';
                meta.appendChild(tag);
            }
            content.append(title, meta);
            row.append(checkbox, content);
            return row;
        };

        const renderList = () => {
            const scrollTop = listEl.scrollTop;
            listEl.innerHTML = '';
            if (!state.loading && !state.loadError) {
                if (state.filtered.length === 0) {
                    const empty = document.createElement('div');
                    empty.className = 'gre-empty';
                    empty.textContent = state.list.length === 0 ? '这个空间里没有对话。' : '没有匹配的对话。';
                    listEl.appendChild(empty);
                }
                state.filtered.slice(0, state.visibleCount).forEach((item, index) => listEl.appendChild(renderRow(item, index)));
                if (state.filtered.length > state.visibleCount) {
                    const more = document.createElement('button');
                    more.type = 'button';
                    more.className = 'gre-btn gre-more';
                    more.textContent = `加载更多（剩余 ${state.filtered.length - state.visibleCount} 条）`;
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

        let includeAttachments = Boolean(options.includeAttachments);
        let incremental = Boolean(options.incremental);
        const exportOptions = () => ({ includeAttachments, incremental });
        const { dialog, close: closeDialog } = openModal({ labelledBy: 'gre-dialog-title', onRequestClose: () => closeDialog() });

        const spaceCard = (key, title, description) => `
            <div class="gre-card">
                <strong>${title}</strong>
                <p>${description}</p>
                <div class="gre-row">
                    <button id="select-${key}-btn" class="gre-btn gre-btn-primary" type="button">导出全部</button>
                    <button id="select-${key}-picker-btn" class="gre-btn" type="button">选择对话导出</button>
                </div>
            </div>`;

        const renderInitial = () => {
            dialog.innerHTML = `
                <div class="gre-header">
                    <h2 id="gre-dialog-title">导出 ChatGPT 对话</h2>
                    <span class="gre-muted">v${EXPORTER_VERSION}</span>
                </div>
                <div class="gre-stack">
                    ${spaceCard('personal', '个人空间', '个人账户下的全部对话，包括项目中的对话。')}
                    ${spaceCard('project', '项目空间', '只导出项目中的对话，按项目分文件夹。')}
                    ${spaceCard('team', '团队空间', '团队（Team / Business）工作区的对话，会自动检测工作区 ID。')}
                </div>
                <div class="gre-stack gre-section">
                    <label class="gre-option">
                        <input id="include-attachments" type="checkbox" ${includeAttachments ? 'checked' : ''}>
                        <span>
                            <strong>同时下载上传和生成的附件</strong>
                            <span class="gre-muted">开启后导出时间和 ZIP 体积可能明显增加。</span>
                        </span>
                    </label>
                    <label class="gre-option">
                        <input id="incremental-export" type="checkbox" ${incremental ? 'checked' : ''}>
                        <span>
                            <strong>增量导出：只导出有变化的对话</strong>
                            <span class="gre-muted">仅对“导出全部”生效，跳过上次导出后没有更新的对话。导出记录保存在当前浏览器。</span>
                        </span>
                    </label>
                </div>
                <div class="gre-spread gre-footer">
                    <button id="clear-history-btn" class="gre-link" type="button">清除导出记录</button>
                    <button id="cancel-btn" class="gre-btn" type="button">取消</button>
                </div>`;

            const $ = selector => dialog.querySelector(selector);
            $('#include-attachments').onchange = e => { includeAttachments = e.target.checked; };
            $('#incremental-export').onchange = e => { incremental = e.target.checked; };
            $('#clear-history-btn').onclick = e => {
                if (!confirm('清除后，下一次增量导出会重新导出全部对话。确定清除吗？')) return;
                clearExportHistory();
                e.target.textContent = '已清除导出记录';
                e.target.disabled = true;
            };
            $('#select-personal-btn').onclick = () => {
                closeDialog();
                startExportProcess('personal', null, exportOptions());
            };
            $('#select-personal-picker-btn').onclick = () => {
                closeDialog();
                showConversationPicker({ mode: 'personal', workspaceId: null, includeAttachments, incremental });
            };
            $('#select-project-btn').onclick = () => {
                closeDialog();
                startExportProcess('project', null, exportOptions());
            };
            $('#select-project-picker-btn').onclick = () => {
                closeDialog();
                showConversationPicker({ mode: 'project', workspaceId: null, includeAttachments, incremental });
            };
            $('#select-team-btn').onclick = () => startTeamFlow('all');
            $('#select-team-picker-btn').onclick = () => startTeamFlow('select');
            $('#cancel-btn').onclick = closeDialog;
            $('#select-personal-btn').focus();
        };

        const runTeamAction = (action, workspaceId) => {
            closeDialog();
            if (action === 'all') {
                startExportProcess('team', workspaceId, exportOptions());
            } else {
                showConversationPicker({ mode: 'team', workspaceId, includeAttachments, incremental });
            }
        };

        const startTeamFlow = action => {
            const detectedIds = detectAllWorkspaceIds();
            if (detectedIds.length === 1) {
                runTeamAction(action, detectedIds[0]);
                return;
            }
            renderTeam(action, detectedIds);
        };

        const renderTeam = (action, detectedIds) => {
            let detection;
            if (detectedIds.length > 1) {
                detection = `
                    <div class="gre-notice gre-notice-info">
                        <p>检测到多个工作区，请选择一个：</p>
                        ${detectedIds.map((id, index) => `
                            <label class="gre-radio">
                                <input type="radio" name="workspace_id" value="${escapeHtml(id)}" ${index === 0 ? 'checked' : ''}>
                                <span class="gre-code">${escapeHtml(id)}</span>
                            </label>`).join('')}
                    </div>`;
            } else {
                detection = `
                    <div class="gre-notice gre-notice-warn">
                        <p>未能自动检测到工作区 ID</p>
                        请刷新页面或打开一个团队对话后重试，也可以在下方手动输入。
                    </div>
                    <label for="team-id-input" class="gre-section" style="display: block; margin-bottom: 6px; font-weight: 600;">手动输入工作区 ID</label>
                    <input id="team-id-input" class="gre-input" type="text" placeholder="粘贴工作区 ID（ws-… 或 UUID）" style="width: 100%;">`;
            }
            const actionLabel = action === 'all' ? '导出全部' : '选择对话导出';
            dialog.innerHTML = `
                <div class="gre-header"><h2 id="gre-dialog-title">导出团队空间</h2></div>
                ${detection}
                <div id="team-id-error" class="gre-error" role="alert" style="margin-top: 8px;" hidden></div>
                <div class="gre-spread gre-footer">
                    <button id="back-btn" class="gre-btn" type="button">返回</button>
                    <button id="start-team-btn" class="gre-btn gre-btn-primary" type="button">${actionLabel}</button>
                </div>`;

            const readSelectedWorkspaceId = () => {
                const radio = dialog.querySelector('input[name="workspace_id"]:checked');
                if (radio) return radio.value;
                return dialog.querySelector('#team-id-input')?.value.trim() || '';
            };
            dialog.querySelector('#back-btn').onclick = renderInitial;
            dialog.querySelector('#start-team-btn').onclick = () => {
                const workspaceId = readSelectedWorkspaceId();
                if (!workspaceId) {
                    const errorEl = dialog.querySelector('#team-id-error');
                    errorEl.textContent = '请选择或输入一个工作区 ID。';
                    errorEl.hidden = false;
                    dialog.querySelector('#team-id-input')?.focus();
                    return;
                }
                runTeamAction(action, workspaceId);
            };
            (dialog.querySelector('#team-id-input') || dialog.querySelector('#start-team-btn')).focus();
        };

        renderInitial();
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
