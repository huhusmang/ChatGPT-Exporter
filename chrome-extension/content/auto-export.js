(function () {
    const EXPORT_READY_EVENT = 'CHATGPT_EXPORTER_READY';
    const COMMAND_TYPE = 'CHATGPT_EXPORTER_COMMAND';
    // 版本号以 manifest 为准，避免多处硬编码导致升级时不同步
    const EXPECTED_VERSION = chrome.runtime.getManifest().version;
    let exporterReady = false;
    const pendingCommands = [];

    function queueCommand(action, payload) {
        if (exporterReady) {
            dispatchCommand(action, payload);
        } else {
            pendingCommands.push({ action, payload });
        }
    }

    function dispatchCommand(action, payload) {
        window.postMessage({
            type: COMMAND_TYPE,
            action,
            payload
        }, '*');
    }

    window.addEventListener(EXPORT_READY_EVENT, () => markReady());

    function markReady() {
        exporterReady = true;
        while (pendingCommands.length) {
            const cmd = pendingCommands.shift();
            dispatchCommand(cmd.action, cmd.payload);
        }
    }

    if (document.documentElement.getAttribute('data-chatgpt-exporter-version') === EXPECTED_VERSION) {
        markReady();
    }

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message?.type === 'OPEN_EXPORT_DIALOG') {
            queueCommand('OPEN_DIALOG');
            sendResponse({
                ok: true,
                version: document.documentElement.getAttribute('data-chatgpt-exporter-version')
            });
            return true;
        }
        return false;
    });
})();

