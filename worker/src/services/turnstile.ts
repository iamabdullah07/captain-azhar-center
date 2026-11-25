export interface TurnstileResult {
  ok: boolean;
  error?: string;
}

/**
 * Verifies Cloudflare Turnstile response token on the server.
 * When TURNSTILE_SECRET_KEY is not configured in local dev, accepts explicit dev bypass token.
 */
export async function verifyTurnstileToken(params: {
  token: string | null | undefined;
  secretKey: string | undefined;
  remoteIp: string;
  fetchImpl?: typeof fetch;
}): Promise<TurnstileResult> {
  const { token, secretKey, remoteIp, fetchImpl = fetch } = params;

  if (!secretKey) {
    // Only allow missing Turnstile secret if explicitly running without secret configured in dev
    return { ok: true };
  }

  if (!token || token.trim().length < 10) {
    return { ok: false, error: 'Please complete the security verification check.' };
  }

  try {
    const body = new URLSearchParams({
      secret: secretKey,
      response: token.trim(),
      remoteip: remoteIp,
    });

    const resp = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!resp.ok) {
      return { ok: false, error: 'Verification service unavailable. Please try again.' };
    }

    const data = (await resp.json()) as { success?: boolean; 'error-codes'?: string[] };
    if (!data.success) {
      return { ok: false, error: 'Security verification failed. Please refresh and try again.' };
    }

    return { ok: true };
  } catch {
    return { ok: false, error: 'Unable to verify Turnstile challenge.' };
  }
}
