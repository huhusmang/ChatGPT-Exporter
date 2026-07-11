(function injectExporter() {
    const EXPECTED_VERSION = '1.5.0';
    const activeVersion = document.documentElement.getAttribute('data-chatgpt-exporter-version');
    if (window.__CHATGPT_EXPORTER_INJECTED__ === EXPECTED_VERSION && activeVersion === EXPECTED_VERSION) return;
    window.__CHATGPT_EXPORTER_INJECTED__ = EXPECTED_VERSION;

    // Only skip when the page is already running this exact version.
    if (activeVersion === EXPECTED_VERSION) {
        return;
    }

    const jszipScript = document.createElement('script');
    jszipScript.src = chrome.runtime.getURL('jszip.min.js');
    jszipScript.type = 'text/javascript';
    jszipScript.onload = () => {
        jszipScript.remove();
        // Inject main script only after JSZip is loaded
        const script = document.createElement('script');
        script.src = chrome.runtime.getURL('exporter.user.js');
        script.type = 'text/javascript';
        script.onload = () => script.remove();
        document.documentElement.appendChild(script);
    };
    document.documentElement.appendChild(jszipScript);
})();
