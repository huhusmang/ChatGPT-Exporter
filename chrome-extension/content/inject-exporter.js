(function injectExporter() {
    if (window.__CHATGPT_EXPORTER_INJECTED__) return;
    window.__CHATGPT_EXPORTER_INJECTED__ = true;

    // Prevent double injection if the page script is already running
    if (document.documentElement.getAttribute('data-chatgpt-exporter-ready') === '1') {
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

