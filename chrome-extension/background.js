import { ALARM_NAME, DEFAULT_SETTINGS, normalizeSettings, calculateNextTrigger } from './utils/schedule.js';
import { storage } from './utils/chrome-helpers.js';

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

