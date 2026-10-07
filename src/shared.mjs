// Browser-safe identity contract. Cart attributes must survive into the order.
export const SHOP = 'demo-store.example';
export const EVENT = 'order_created';
export const DEMO_PIXEL_ID = 'demo-pixel-001';

export function eventId(orderId) {
  if (typeof orderId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(orderId)) {
    throw new Error('A synthetic string order id is required');
  }
  return `${SHOP}:order:${orderId}`;
}

export function dedupKey(pixelId, eventName, id) {
  return JSON.stringify([pixelId, eventName, id]);
}

function opaque(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

export function readCookie(cookieString, name) {
  for (const part of cookieString.split(';')) {
    const index = part.indexOf('=');
    if (part.slice(0, index).trim() !== name) continue;
    try { return opaque(decodeURIComponent(part.slice(index + 1))); }
    catch { return undefined; }
  }
  return undefined;
}

export function captureAttribution(landingUrl, cookieString) {
  const url = new URL(landingUrl);
  if (url.protocol !== 'https:' || url.hostname !== SHOP || url.username || url.password) {
    throw new Error('Only the synthetic shop landing URL is supported');
  }
  // Decode URL/cookie encoding once; never trim, lowercase or hash opaque refs.
  const oppref = opaque(url.searchParams.get('oppref')) ?? readCookie(cookieString, '__oppref');
  const obref = readCookie(cookieString, '__obref');
  return { ...(oppref === undefined ? {} : { oppref }), ...(obref === undefined ? {} : { obref }) };
}
