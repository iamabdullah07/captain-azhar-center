function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderStatusHtml(params: {
  title: string;
  heading: string;
  message: string;
  appName?: string;
  homeUrl?: string;
  badgeText?: string;
}): string {
  const appName = escapeHtml(params.appName ?? 'Captain Azhar Center');
  const title = escapeHtml(params.title);
  const heading = escapeHtml(params.heading);
  const message = escapeHtml(params.message);
  const badgeText = escapeHtml(params.badgeText ?? 'QR Code Service');
  const homeUrl = params.homeUrl && /^https?:\/\//i.test(params.homeUrl)
    ? escapeHtml(params.homeUrl)
    : '/';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title} — ${appName}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: linear-gradient(180deg, #F8FAFC 0%, #EFF3F9 100%);
      color: #0A1832;
    }
    .card {
      max-width: 460px;
      width: 100%;
      background: #FFFFFF;
      border-radius: 20px;
      padding: 32px 28px;
      box-shadow: 0 20px 50px -15px rgba(10, 24, 50, 0.12);
      border: 1px solid #E2E8F0;
      text-align: center;
    }
    .badge {
      display: inline-block;
      background: #FEF3C7;
      color: #92400E;
      border: 1px solid #FDE68A;
      border-radius: 999px;
      padding: 4px 12px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      margin-bottom: 16px;
    }
    h1 {
      margin: 0 0 10px;
      font-size: 22px;
      color: #0A1832;
    }
    p {
      margin: 0 0 24px;
      color: #475569;
      line-height: 1.6;
      font-size: 15px;
    }
    .btn {
      display: inline-block;
      background: #0A1832;
      color: #D9A441;
      text-decoration: none;
      font-weight: 700;
      font-size: 14px;
      padding: 12px 22px;
      border-radius: 10px;
    }
    .brand {
      margin-top: 24px;
      font-size: 12px;
      color: #94A3B8;
    }
  </style>
</head>
<body>
  <main class="card">
    <div class="badge">${badgeText}</div>
    <h1>${heading}</h1>
    <p>${message}</p>
    <a class="btn" href="${homeUrl}">Create a New QR Code</a>
    <div class="brand">${appName}</div>
  </main>
</body>
</html>`;
}
