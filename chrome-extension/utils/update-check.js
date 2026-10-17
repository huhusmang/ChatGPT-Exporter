const RELEASES_API = 'https://api.github.com/repos/huhusmang/ChatGPT-Exporter/releases/latest';
const CACHE_KEY = 'latestRelease';
// 未登录的 GitHub API 每小时只允许 60 次请求，弹窗频繁打开时用缓存结果。
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

export function compareVersions(a, b) {
    const left = String(a).split('.').map(Number);
    const right = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const diff = (left[i] || 0) - (right[i] || 0);
        if (diff !== 0) return diff > 0 ? 1 : -1;
    }
    return 0;
}

async function fetchLatestRelease() {
    const response = await fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } });
    if (!response.ok) throw new Error(`GitHub API ${response.status}`);
    const release = await response.json();
    return {
        version: String(release.tag_name || '').replace(/^v/, ''),
        url: release.html_url,
        checkedAt: Date.now()
    };
}

// 返回比当前版本更新的 Release；没有更新或检查失败时返回 null。
export async function findNewerRelease(currentVersion) {
    try {
        const { [CACHE_KEY]: cached } = await chrome.storage.local.get(CACHE_KEY);
        let latest = cached && Date.now() - cached.checkedAt < CACHE_TTL_MS ? cached : null;
        if (!latest) {
            latest = await fetchLatestRelease();
            await chrome.storage.local.set({ [CACHE_KEY]: latest });
        }
        return latest.version && compareVersions(latest.version, currentVersion) > 0 ? latest : null;
    } catch (error) {
        console.warn('检查更新失败:', error);
        return null;
    }
}
