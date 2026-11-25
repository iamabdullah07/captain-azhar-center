import { escapeHtml } from './statusPages';

export type OfficeExtension = 'doc' | 'docx' | 'xls' | 'xlsx' | 'ppt' | 'pptx';

export function renderOfficeViewerHtml(params: {
  filename: string;
  extension: OfficeExtension;
  rawPublicUrl: string;
  downloadUrl: string;
  nonce: string;
  appName?: string;
}): string {
  const appName = escapeHtml(params.appName ?? 'Captain Azhar Center');
  const filename = escapeHtml(params.filename);
  const extUpper = escapeHtml(params.extension.toUpperCase());
  const downloadUrl = escapeHtml(params.downloadUrl);
  const nonce = escapeHtml(params.nonce);
  const embedUrl = escapeHtml(
    `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(params.rawPublicUrl)}`
  );

  let rawHostname = '';
  try {
    rawHostname = new URL(params.rawPublicUrl).hostname;
  } catch {
    rawHostname = '';
  }
  const safeRawHost = escapeHtml(rawHostname);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${filename} — ${appName}</title>
  <style>
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: #F8FAFC;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #0A1832;
    }
    .viewer-frame {
      position: fixed;
      inset: 0;
      width: 100vw;
      height: 100dvh;
      border: 0;
      background: #FFFFFF;
    }
    .corner-download {
      position: fixed;
      right: 14px;
      bottom: 14px;
      z-index: 20;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: #0A1832;
      color: #D9A441;
      border: 1.5px solid #D9A441;
      border-radius: 999px;
      padding: 8px 14px;
      font-size: 12.5px;
      font-weight: 800;
      text-decoration: none;
      box-shadow: 0 8px 24px rgba(10, 24, 50, 0.24);
    }
    .corner-download:hover {
      background: #13294B;
    }
    .overlay {
      position: fixed;
      inset: 0;
      z-index: 30;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: rgba(248, 250, 252, 0.95);
    }
    .overlay[hidden] {
      display: none;
    }
    .card {
      max-width: 400px;
      width: 100%;
      background: #FFFFFF;
      border: 1px solid #E2E8F0;
      border-radius: 18px;
      padding: 26px 22px;
      text-align: center;
      box-shadow: 0 18px 40px -15px rgba(10, 24, 50, 0.16);
    }
    .spinner {
      width: 32px;
      height: 32px;
      border: 3px solid #E2E8F0;
      border-top-color: #D9A441;
      border-radius: 50%;
      margin: 0 auto 12px;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .card p {
      margin: 0 0 16px;
      font-size: 14px;
      color: #475569;
      line-height: 1.5;
    }
    .btn-fallback {
      display: inline-block;
      background: #0A1832;
      color: #D9A441;
      text-decoration: none;
      font-weight: 800;
      font-size: 14px;
      padding: 11px 20px;
      border-radius: 10px;
    }
  </style>
</head>
<body>
  <iframe
    id="doc-frame"
    class="viewer-frame"
    title="${filename}"
    src="${embedUrl}"
    loading="eager"
    allow="fullscreen"
    data-raw-host="${safeRawHost}"
  ></iframe>

  <a class="corner-download" href="${downloadUrl}" download="${filename}">Download ${extUpper}</a>

  <div class="overlay" id="viewer-loading">
    <div class="card">
      <div class="spinner" aria-hidden="true"></div>
      <p>Loading ${extUpper} preview&hellip;</p>
      <a class="btn-fallback" href="${downloadUrl}" download="${filename}">Download</a>
    </div>
  </div>

  <div class="overlay" id="viewer-fallback" hidden>
    <div class="card">
      <p id="fallback-msg">Preview could not be loaded in Microsoft Office Online Viewer.</p>
      <a class="btn-fallback" href="${downloadUrl}" download="${filename}">Download ${extUpper}</a>
    </div>
  </div>

  <script nonce="${nonce}">
    (function () {
      var frame = document.getElementById('doc-frame');
      var loadingEl = document.getElementById('viewer-loading');
      var fallbackEl = document.getElementById('viewer-fallback');
      var fallbackMsg = document.getElementById('fallback-msg');
      if (!frame) return;

      var rawHost = (frame.getAttribute('data-raw-host') || '').toLowerCase();
      var timer = null;

      function isLocalHost(host) {
        if (!host) return true;
        if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host === '0.0.0.0') return true;
        if (host.endsWith('.local') || host.endsWith('.internal')) return true;
        if (/^10\./.test(host) || /^192\.168\./.test(host)) return true;
        if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;
        return false;
      }

      function showFallback(msg) {
        if (loadingEl) loadingEl.hidden = true;
        if (fallbackMsg && msg) fallbackMsg.textContent = msg;
        if (fallbackEl) fallbackEl.hidden = false;
      }

      if (isLocalHost(rawHost)) {
        showFallback('Microsoft Office Online Viewer requires a public URL.');
        return;
      }

      timer = setTimeout(function () {
        showFallback('Viewer took too long to load.');
      }, 12000);

      frame.addEventListener('load', function () {
        if (timer) { clearTimeout(timer); timer = null; }
        if (loadingEl) loadingEl.hidden = true;
      });

      frame.addEventListener('error', function () {
        if (timer) { clearTimeout(timer); timer = null; }
        showFallback('Preview could not be loaded.');
      });
    })();
  </script>
</body>
</html>`;
}
