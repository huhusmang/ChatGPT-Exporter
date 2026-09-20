(function () {
    const EXPORT_READY_EVENT = 'CHATGPT_EXPORTER_READY';
    const COMMAND_TYPE = 'CHATGPT_EXPORTER_COMMAND';
    const EXPECTED_VERSION = '2.0';
    const CONTENT_INSTANCE_ID = `content-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const CONTENT_INSTANCE_ATTRIBUTE = 'data-chatgpt-exporter-content-instance';
    document.documentElement.setAttribute(CONTENT_INSTANCE_ATTRIBUTE, CONTENT_INSTANCE_ID);
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

    function sendRuntimeMessage(message) {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(message, (response) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }
                resolve(response);
            });
        });
    }

    // The exporter runs in the page world to access ChatGPT's session.  Downloads
    // and durable progress live in the extension, so bridge only explicit requests.
    window.addEventListener('message', async (event) => {
        if (document.documentElement.getAttribute(CONTENT_INSTANCE_ATTRIBUTE) !== CONTENT_INSTANCE_ID) return;
        if (event.source !== window || event.data?.type !== 'CHATGPT_EXPORTER_BRIDGE_REQUEST') return;
        const { requestId, message } = event.data;
        try {
            const response = await sendRuntimeMessage(message);
            window.postMessage({
                type: 'CHATGPT_EXPORTER_BRIDGE_RESPONSE', requestId, response
            }, '*');
        } catch (error) {
            window.postMessage({
                type: 'CHATGPT_EXPORTER_BRIDGE_RESPONSE', requestId,
                response: { ok: false, error: error.message }
            }, '*');
        }
    });

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

    async function resumePendingExport() {
        try {
            const response = await sendRuntimeMessage({ type: 'CHATGPT_EXPORTER_CLAIM_RESUME_JOB' });
            if (response?.ok && response.job?.options) {
                queueCommand('RESUME_EXPORT', response.job.options);
            }
        } catch (error) {
            console.warn('[ChatGPT Exporter] failed to resume rate-limited export', error);
        }
    }

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (document.documentElement.getAttribute(CONTENT_INSTANCE_ATTRIBUTE) !== CONTENT_INSTANCE_ID) return false;
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

    resumePendingExport();
})();
