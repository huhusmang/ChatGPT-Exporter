import { normalizeSettings, calculateNextTrigger } from '../utils/schedule.js';
import { storage, tabs } from '../utils/chrome-helpers.js';

const EXPECTED_EXPORTER_VERSION = '2.0';

const nextRunEl = document.getElementById('next-run');
const reminderNoteEl = document.getElementById('reminder-note');
const openDialogBtn = document.getElementById('open-dialog-btn');
const openOptionsBtn = document.getElementById('open-options-btn');

document.addEventListener('DOMContentLoaded', init);

async function init() {
    const { settings } = await storage.get('settings');
    const normalized = normalizeSettings(settings);
    renderSchedule(normalized);

    openDialogBtn.addEventListener('click', () => openDialog(normalized));
    openOptionsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
}

function renderSchedule(settings) {
    const nextTrigger = calculateNextTrigger(settings);
    if (!nextTrigger) {
        nextRunEl.textContent = '未启用定时提醒';
    } else {
        const date = new Date(nextTrigger);
        nextRunEl.textContent = `下次提醒：${date.toLocaleString()}`;
    }
    reminderNoteEl.textContent = '提醒只负责通知，不会自动导出';
}

async function openDialog() {
    const tab = await getActiveChatGPTTab();
    if (!tab) {
        chrome.tabs.create({ url: 'https://chatgpt.com/' });
        return;
    }
    const isNoReceiverError = (err) => {
        const message = err?.message || String(err || '');
        return message.includes('Receiving end does not exist') || message.includes('Could not establish connection');
    };
    try {
        const response = await tabs.sendMessage(tab.id, { type: 'OPEN_EXPORT_DIALOG' });
        if (response?.version === EXPECTED_EXPORTER_VERSION) return;
    } catch (error) {
        if (!isNoReceiverError(error)) {
            console.warn('Failed to reach content scripts, retrying after injection...', error);
        }
    }

    try {
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content/inject-exporter.js', 'content/auto-export.js']
        });
        await new Promise(resolve => setTimeout(resolve, 400));
        const response = await tabs.sendMessage(tab.id, { type: 'OPEN_EXPORT_DIALOG' });
        if (response?.version !== EXPECTED_EXPORTER_VERSION) {
            throw new Error(`页面仍在运行旧版导出器 (${response?.version || 'unknown'})`);
        }
    } catch (retryError) {
        alert('无法连接到页面脚本。请尝试刷新 ChatGPT 页面后再试。');
        console.error('Retry failed:', retryError);
    }
}

async function getActiveChatGPTTab() {
    const [tab] = await tabs.query({ active: true, currentWindow: true });
    const url = tab?.url || '';
    const isChatGPT = /^https:\/\/(.*\.)?chatgpt\.com/.test(url);
    const isOpenAI = /^https:\/\/(.*\.)?chat\.openai\.com/.test(url);
    
    if (tab && (isChatGPT || isOpenAI)) {
        return tab;
    }
    return null;
}
