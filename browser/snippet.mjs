import { captureAttribution, eventId, EVENT, DEMO_PIXEL_ID } from '../src/shared.mjs';

// Adapter functions are supplied by the storefront/CMP. This module itself has no network calls.
export function createConsentGatedPixel({
  pixelId = DEMO_PIXEL_ID, sessionId,
  loadSdk, getLandingUrl, getCookies, recordConsent, saveCartAttributes,
}) {
  let state = 'unknown', revision, oaiq;
  let generation = 0;
  let consentWrites = Promise.resolve();

  async function setConsent(next) {
    if (!['granted', 'denied', 'unknown'].includes(next)) throw new Error('Invalid consent');
    const currentGeneration = ++generation;
    state = next === 'granted' ? 'unknown' : next;
    if (oaiq) oaiq('consent', false);
    const write = consentWrites.then(async () => {
      await saveCartAttributes({ chatgpt_oppref: '', chatgpt_obref: '', measurement_consent: 'denied' });
      return recordConsent(sessionId, next);
    });
    consentWrites = write.catch(() => {});
    const receipt = await write;
    if (currentGeneration !== generation) return;
    revision = receipt.revision;
    if (next !== 'granted') return;
    // No SDK loading, landing-URL capture or cookie reads before permission.
    const loaded = oaiq ?? await loadSdk();
    if (currentGeneration !== generation) { loaded('consent', false); return; }
    oaiq = loaded;
    oaiq('consent', false); // The SDK otherwise defaults to granted.
    oaiq('init', { pixelId });
    oaiq('consent', true);
    state = 'granted';
  }

  async function purchase({ orderId, amount, currency }) {
    if (state !== 'granted') return { status: 'consent_blocked' };
    if (!Number.isSafeInteger(amount) || amount < 0 || !['USD', 'EUR', 'JPY', 'KWD'].includes(currency)) {
      throw new Error('Purchase requires integer minor units and a supported currency');
    }
    const currentGeneration = generation;
    const refs = captureAttribution(getLandingUrl(), getCookies());
    const id = eventId(orderId);
    const attrs = {
      measurement_session_id: sessionId, measurement_consent: 'granted',
      measurement_consent_revision: String(revision), chatgpt_event_id: id,
      chatgpt_oppref: refs.oppref ?? '', chatgpt_obref: refs.obref ?? '',
    };
    // Storefront adapter must attach these to the order; no direct store API calls here.
    await saveCartAttributes(attrs);
    if (state !== 'granted' || currentGeneration !== generation) {
      await saveCartAttributes({ chatgpt_oppref: '', chatgpt_obref: '', measurement_consent: 'denied' });
      return { status: 'consent_blocked' };
    }
    oaiq('measure', EVENT, { type: 'contents', amount, currency }, { event_id: id, opt_out: true });
    return { status: 'measured', event_id: id, attributes: attrs };
  }
  return { setConsent, purchase };
}

// Optional real-browser adapter; never invoked by the demo or tests.
// Supply when the site operator enables the real Pixel.
export function loadOpenAiSdk(window, document) {
  if (window.oaiq) return Promise.resolve(window.oaiq);
  return new Promise((resolve, reject) => {
    const queue = function (...args) { queue.q.push(args); };
    queue.q = [];
    window.oaiq = queue;
    queue('consent', false);
    const script = document.createElement('script');
    script.async = true;
    script.src = 'https://bzrcdn.openai.com/sdk/oaiq.min.js';
    script.onload = () => resolve(window.oaiq);
    script.onerror = () => { delete window.oaiq; script.remove(); reject(new Error('Pixel SDK failed to load')); };
    document.head.append(script);
  });
}
