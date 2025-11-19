export const ALARM_NAME = 'chatgpt-exporter::schedule';

export const DEFAULT_SETTINGS = {
    frequency: 'off', // "off" | "daily" | "weekly"
    timeOfDay: '09:00',
    weekday: 1
};

export function normalizeSettings(settings = {}) {
    return {
        ...DEFAULT_SETTINGS,
        ...settings
    };
}

export function calculateNextTrigger(settings) {
    const normalized = normalizeSettings(settings);
    if (normalized.frequency === 'off') return null;

    const now = new Date();
    const [hour, minute] = (normalized.timeOfDay || '09:00').split(':').map(Number);
    const target = new Date(now);
    target.setSeconds(0, 0);
    target.setHours(Number.isFinite(hour) ? hour : 9, Number.isFinite(minute) ? minute : 0, 0, 0);

    if (normalized.frequency === 'daily') {
        if (target <= now) {
            target.setDate(target.getDate() + 1);
        }
        return target.getTime();
    }

    if (normalized.frequency === 'weekly') {
        const desiredWeekday = typeof normalized.weekday === 'number' ? normalized.weekday : 1;
        const currentWeekday = target.getDay();
        let diff = desiredWeekday - currentWeekday;
        if (diff < 0) diff += 7;
        if (diff === 0 && target <= now) diff = 7;
        target.setDate(target.getDate() + diff);
        return target.getTime();
    }
    return null;
}

