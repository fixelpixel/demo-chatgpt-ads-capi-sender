export const ENDPOINT = 'https://bzr.openai.com/v1/events';

export function configuration(args = [], env = {}) {
  if (args.some(arg => arg !== '--send')) throw new Error('Only --send is supported');
  const send = args.includes('--send');
  if (send && (!env.OPENAI_PIXEL_ID?.trim() || !env.OPENAI_CONVERSIONS_API_KEY?.trim())) {
    throw new Error('--send requires OPENAI_PIXEL_ID and OPENAI_CONVERSIONS_API_KEY');
  }
  return {
    mode: send ? 'send' : 'dry-run',
    pixelId: send ? env.OPENAI_PIXEL_ID.trim() : 'demo-pixel-001',
    apiKey: send ? env.OPENAI_CONVERSIONS_API_KEY.trim() : undefined,
  };
}

export function requestUrl(pixelId) {
  const url = new URL(ENDPOINT);
  url.searchParams.set('pid', pixelId);
  return url.href;
}

export async function sendPayload(payload, config, fetchImpl = fetch) {
  if (config.mode !== 'send' || !config.pixelId || !config.apiKey) throw new Error('Send is not enabled');
  const response = await fetchImpl(requestUrl(config.pixelId), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  // Do not log response bodies: they may echo identifiers or credentials.
  await response.body?.cancel();
  if (!response.ok) throw new Error('Conversions API did not accept the request');
  return { http_status: response.status };
}
