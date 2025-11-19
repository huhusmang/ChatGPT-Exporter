import { normalizeSettings, calculateNextTrigger } from '../utils/schedule.js';
import { storage, tabs } from '../utils/chrome-helpers.js';

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
    try {
        await tabs.sendMessage(tab.id, { type: 'OPEN_EXPORT_DIALOG' });
    } catch (error) {
        console.warn('Initial connection failed, attempting to inject scripts...', error.message || error);
        try {
            // Programmatically inject the content scripts
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['content/inject-exporter.js', 'content/auto-export.js']
            });
            
            // Wait a moment for the scripts to initialize
            await new Promise(resolve => setTimeout(resolve, 200));
            
            // Retry sending the message
            await tabs.sendMessage(tab.id, { type: 'OPEN_EXPORT_DIALOG' });
            
        } catch (retryError) {
            alert('无法连接到页面脚本。请尝试刷新 ChatGPT 页面后再试。');
            console.error('Retry failed:', retryError);
        }
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

