export const storage = {
    get: (keys) => new Promise((resolve) => chrome.storage.sync.get(keys, resolve)),
    set: (items) => new Promise((resolve) => chrome.storage.sync.set(items, resolve))
};

export const runtime = {
    sendMessage: (message) => new Promise((resolve) => {
        chrome.runtime.sendMessage(message, (response) => {
            resolve(response);
        });
    })
};

export const tabs = {
    query: (queryOptions) => new Promise((resolve) => chrome.tabs.query(queryOptions, resolve)),
    sendMessage: (tabId, payload) => new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, payload, (response) => {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
            } else {
                resolve(response);
            }
        });
    })
};

