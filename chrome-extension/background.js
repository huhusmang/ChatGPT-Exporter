import { ALARM_NAME, DEFAULT_SETTINGS, normalizeSettings, calculateNextTrigger } from './utils/schedule.js';
import { storage } from './utils/chrome-helpers.js';

const EXPORT_PROGRESS_KEY = 'chatgptExporter.completedConversations.v1';
const RESUME_JOB_KEY = 'chatgptExporter.pendingResumeJob.v1';

function localGet(key) {
    return new Promise((resolve) => chrome.storage.local.get(key, resolve));
}

function localSet(value) {
    return new Promise((resolve) => chrome.storage.local.set(value, resolve));
}

function conversationFileSuffix(conversationId) {
    const id = String(conversationId || '');
    return id.includes('-') ? id.split('-').pop() : id;
}

function searchDownloads(query) {
    return new Promise((resolve, reject) => chrome.downloads.search(query, (items) => {
        if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
        }
        resolve(items);
    }));
}

async function findCompletedIdsInDownloads(conversationIds) {
    const candidates = Array.isArray(conversationIds) ? conversationIds.filter(Boolean) : [];
    if (candidates.length === 0) return [];

    const downloadedFiles = await searchDownloads({ state: 'complete', limit: 0 });
    const extensionsBySuffix = new Map();
    for (const item of downloadedFiles) {
        const filename = String(item.filename || '').replace(/\\/g, '/');
        if (!filename.includes('/ChatGPT Exports/')) continue;
        const match = filename.match(/_([a-z0-9-]+)(?: \(\d+\))?\.(json|md)$/i);
        if (!match) continue;
        const suffix = match[1].toLowerCase();
        const extensions = extensionsBySuffix.get(suffix) || new Set();
        extensions.add(match[2].toLowerCase());
        extensionsBySuffix.set(suffix, extensions);
    }

    return candidates.filter((id) => {
        const extensions = extensionsBySuffix.get(conversationFileSuffix(id).toLowerCase());
        return extensions?.has('json') && extensions?.has('md');
    });
}

async function getCompletedIds(scope, conversationIds = []) {
    const stored = await localGet(EXPORT_PROGRESS_KEY);
    const progress = stored[EXPORT_PROGRESS_KEY] || {};
    const scopeEntries = progress[scope] || {};
    const discoveredIds = await findCompletedIdsInDownloads(conversationIds);
    if (discoveredIds.length > 0) {
        progress[scope] = scopeEntries;
        const completedAt = new Date().toISOString();
        discoveredIds.forEach((id) => {
            if (!scopeEntries[id]) scopeEntries[id] = { completedAt, recoveredFromDownloads: true };
        });
        await localSet({ [EXPORT_PROGRESS_KEY]: progress });
    }
    return [...new Set([...Object.keys(scopeEntries), ...discoveredIds])];
}

async function markCompleted(scope, conversationId) {
    const stored = await localGet(EXPORT_PROGRESS_KEY);
    const progress = stored[EXPORT_PROGRESS_KEY] || {};
    progress[scope] = progress[scope] || {};
    progress[scope][conversationId] = { completedAt: new Date().toISOString() };
    await localSet({ [EXPORT_PROGRESS_KEY]: progress });
}

async function clearCompleted(scope) {
    const stored = await localGet(EXPORT_PROGRESS_KEY);
    const progress = stored[EXPORT_PROGRESS_KEY] || {};
    delete progress[scope];
    await localSet({ [EXPORT_PROGRESS_KEY]: progress });
}

async function saveResumeJob(job) {
    await localSet({ [RESUME_JOB_KEY]: job });
}

async function claimResumeJob() {
    const stored = await localGet(RESUME_JOB_KEY);
    const job = stored[RESUME_JOB_KEY] || null;
    if (job) await localSet({ [RESUME_JOB_KEY]: null });
    return job;
}

function downloadFile(file) {
    return new Promise((resolve, reject) => {
        chrome.downloads.download({
            url: file.dataUrl,
            filename: file.filename,
            conflictAction: 'uniquify',
            saveAs: false
        }, (downloadId) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }

            const onChanged = (delta) => {
                if (delta.id !== downloadId || !delta.state) return;
                if (delta.state.current === 'complete') {
                    chrome.downloads.onChanged.removeListener(onChanged);
                    resolve();
                } else if (delta.state.current === 'interrupted') {
                    chrome.downloads.onChanged.removeListener(onChanged);
                    reject(new Error(delta.error?.current || 'download interrupted'));
                }
            };
            chrome.downloads.onChanged.addListener(onChanged);
        });
    });
}

chrome.runtime.onInstalled.addListener(async () => {
    const settings = await ensureSettings();
    await scheduleAlarm(settings);
});

chrome.runtime.onStartup.addListener(async () => {
    const { settings } = await storage.get('settings');
    await scheduleAlarm(settings || DEFAULT_SETTINGS);
});

chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area === 'sync' && changes.settings) {
        await scheduleAlarm(changes.settings.newValue);
    }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== ALARM_NAME) return;
    const { settings } = await storage.get('settings');
    if (!settings || settings.frequency === 'off') return;
    await handleAlarm(settings);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message?.type) {
        case 'CHATGPT_EXPORTER_RESCHEDULE':
            storage.get('settings').then(async ({ settings }) => {
                await scheduleAlarm(settings || DEFAULT_SETTINGS);
                sendResponse({ ok: true });
            });
            return true;
        case 'CHATGPT_EXPORTER_GET_COMPLETED':
            getCompletedIds(message.scope, message.conversationIds)
                .then((completedIds) => sendResponse({ ok: true, completedIds }))
                .catch((error) => sendResponse({ ok: false, error: error.message }));
            return true;
        case 'CHATGPT_EXPORTER_CLEAR_COMPLETED':
            clearCompleted(message.scope)
                .then(() => sendResponse({ ok: true }))
                .catch((error) => sendResponse({ ok: false, error: error.message }));
            return true;
        case 'CHATGPT_EXPORTER_DOWNLOAD_AND_MARK':
            (async () => {
                for (const file of message.files || []) {
                    await downloadFile(file);
                }
                await markCompleted(message.scope, message.conversationId);
                sendResponse({ ok: true });
            })().catch((error) => sendResponse({ ok: false, error: error.message }));
            return true;
        case 'CHATGPT_EXPORTER_SAVE_RESUME_JOB':
            saveResumeJob(message.job)
                .then(() => sendResponse({ ok: true }))
                .catch((error) => sendResponse({ ok: false, error: error.message }));
            return true;
        case 'CHATGPT_EXPORTER_CLAIM_RESUME_JOB':
            claimResumeJob()
                .then((job) => sendResponse({ ok: true, job }))
                .catch((error) => sendResponse({ ok: false, error: error.message }));
            return true;
        default:
            break;
    }
    return undefined;
});

async function ensureSettings() {
    const { settings } = await storage.get('settings');
    if (settings) {
        return normalizeSettings(settings);
    }
    await storage.set({ settings: DEFAULT_SETTINGS });
    return { ...DEFAULT_SETTINGS };
}

async function scheduleAlarm(settings) {
    await chrome.alarms.clear(ALARM_NAME);
    const normalized = normalizeSettings(settings);
    const nextTrigger = calculateNextTrigger(normalized);
    if (!nextTrigger) return;
    const period = normalized.frequency === 'weekly'
        ? 7 * 24 * 60
        : 24 * 60;
    chrome.alarms.create(ALARM_NAME, {
        when: nextTrigger,
        periodInMinutes: period
    });
}

async function handleAlarm(settings) {
    const normalized = normalizeSettings(settings);
    const notificationId = `${ALARM_NAME}-${Date.now()}`;
    chrome.notifications.create(notificationId, {
        type: 'basic',
        title: 'ChatGPT 导出提醒',
        message: `到${normalized.frequency === 'weekly' ? '每周' : '每日'}导出时间啦，打开扩展手动导出即可。`,
        iconUrl: 'icons/icon128.png',
        priority: 1
    }, () => chrome.runtime.lastError);
}
