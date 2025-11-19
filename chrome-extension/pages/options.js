import { DEFAULT_SETTINGS, normalizeSettings } from '../utils/schedule.js';
import { storage, runtime } from '../utils/chrome-helpers.js';

const form = document.getElementById('settings-form');
const frequencyEl = document.getElementById('frequency');
const timeEl = document.getElementById('timeOfDay');
const weekdayEl = document.getElementById('weekday');
const saveStateEl = document.getElementById('save-state');
const resetBtn = document.getElementById('reset-btn');

document.addEventListener('DOMContentLoaded', loadSettings);
frequencyEl.addEventListener('change', toggleSections);
resetBtn.addEventListener('click', resetSettings);
form.addEventListener('submit', onSubmit);

async function loadSettings() {
    const { settings } = await storage.get('settings');
    const normalized = normalizeSettings(settings);
    frequencyEl.value = normalized.frequency;
    timeEl.value = normalized.timeOfDay;
    weekdayEl.value = normalized.weekday;
    toggleSections();
}

function toggleSections() {
    const showWeekday = frequencyEl.value === 'weekly';
    document.getElementById('weekday-section').style.display = showWeekday ? 'flex' : 'none';
    document.getElementById('time-section').style.display = frequencyEl.value === 'off' ? 'none' : 'flex';
}

async function onSubmit(event) {
    event.preventDefault();
    const nextSettings = {
        frequency: frequencyEl.value,
        timeOfDay: timeEl.value || DEFAULT_SETTINGS.timeOfDay,
        weekday: Number(weekdayEl.value)
    };
    await storage.set({ settings: nextSettings });
    await runtime.sendMessage({ type: 'CHATGPT_EXPORTER_RESCHEDULE' });
    saveStateEl.textContent = '已保存并重新调度';
    setTimeout(() => { saveStateEl.textContent = ''; }, 2500);
}

async function resetSettings() {
    await storage.set({ settings: DEFAULT_SETTINGS });
    await runtime.sendMessage({ type: 'CHATGPT_EXPORTER_RESCHEDULE' });
    loadSettings();
    saveStateEl.textContent = '已恢复默认设置';
    setTimeout(() => { saveStateEl.textContent = ''; }, 2500);
}

