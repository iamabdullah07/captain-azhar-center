const MAX_URL_LENGTH = 2048;

/**
 * Validates public link URLs:
 * - Only http:// and https:// allowed (blocks javascript:, data:, file:, etc.)
 * - Max 2,048 characters
 * - Blocks self-referential /f/:id redirect loops pointing back to this Worker host
 */
export function validateTargetUrl(
  rawUrl: string,
  workerOrigin?: string
): { ok: true; url: string } | { ok: false; error: string } {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { ok: false, error: 'Please enter a valid URL.' };
  }
  if (trimmed.length > MAX_URL_LENGTH) {
    return { ok: false, error: `URL must be ${MAX_URL_LENGTH} characters or less.` };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: 'Please enter a valid URL starting with https:// or http://' };
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    return { ok: false, error: 'Only http:// and https:// URLs are allowed.' };
  }

  if (!parsed.hostname || parsed.hostname.length > 253) {
    return { ok: false, error: 'Invalid URL hostname.' };
  }

  if (workerOrigin) {
    try {
      const selfUrl = new URL(workerOrigin);
      if (parsed.hostname.toLowerCase() === selfUrl.hostname.toLowerCase() && parsed.pathname.startsWith('/f/')) {
        return { ok: false, error: 'Shortened links cannot point back to this QR service.' };
      }
    } catch {
      // Ignore invalid workerOrigin
    }
  }

  return { ok: true, url: parsed.toString() };
}

/** Sanitizes user-provided filenames before storing in D1 or setting headers. */
export function sanitizeDisplayFilename(rawName: string): string {
  const base = rawName.split(/[/\\]/).pop() ?? 'file';
  const cleaned = base
    .replace(/[\u0000-\u001F\u007F"<>|:*?]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return 'file';
  return cleaned.slice(0, 180);
}
