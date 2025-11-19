(function () {
    const EXPORT_READY_EVENT = 'CHATGPT_EXPORTER_READY';
    const COMMAND_TYPE = 'CHATGPT_EXPORTER_COMMAND';
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

    if (document.documentElement.getAttribute('data-chatgpt-exporter-ready') === '1') {
        markReady();
    }

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message?.type === 'OPEN_EXPORT_DIALOG') {
            queueCommand('OPEN_DIALOG');
            sendResponse({ ok: true });
            return true;
        }
        return false;
    });
})();

