import { SHOP, EVENT, eventId } from './shared.mjs';
import { userData } from './identifiers.mjs';

export function attributes(order) {
  if (!Array.isArray(order.note_attributes)) throw new Error('note_attributes must be an array');
  const attrs = Object.create(null);
  for (const entry of order.note_attributes) {
    if (!entry || typeof entry.name !== 'string' || typeof entry.value !== 'string' || entry.name in attrs) {
      throw new Error('Order attributes must have unique names and string values');
    }
    attrs[entry.name] = entry.value;
  }
  return attrs;
}

export function minorUnits(price, currency) {
  // Explicit demo scope, rather than silently assuming two decimals for all ISO currencies.
  const digits = { USD: 2, EUR: 2, JPY: 0, KWD: 3 }[currency];
  if (digits === undefined) throw new Error('Demo supports USD, EUR, JPY and KWD only');
  if (typeof price !== 'string' || !/^\d+(?:\.\d+)?$/.test(price)) throw new Error('Price must be a non-negative decimal string');
  const [whole, fraction = ''] = price.split('.');
  if (fraction.length > digits && /[1-9]/.test(fraction.slice(digits))) throw new Error('Price exceeds currency precision');
  const amount = BigInt(whole) * (10n ** BigInt(digits)) + BigInt(fraction.slice(0, digits).padEnd(digits, '0') || '0');
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Amount exceeds safe integer range');
  return Number(amount);
}

export function buildPayload(order, attrs, now = Date.now()) {
  if (order.shop_domain !== SHOP) throw new Error('Only demo-store.example orders are supported');
  const id = eventId(order.id);
  if (attrs.chatgpt_event_id !== id) throw new Error('Browser event_id is missing or differs from the shared order identity');
  if (order.financial_status !== 'paid') throw new Error('Only paid orders are supported');
  if (typeof order.created_at !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(order.created_at)) {
    throw new Error('An ISO order timestamp with timezone is required');
  }
  const timestamp = Date.parse(order.created_at);
  if (!Number.isSafeInteger(timestamp) || timestamp < now - 7 * 86400000 || timestamp > now + 600000) {
    throw new Error('Timestamp is outside the API window');
  }
  if (typeof order.currency !== 'string') throw new Error('Currency is required');
  const currency = order.currency.toUpperCase();
  const event = {
    id, type: EVENT, timestamp_ms: timestamp,
    action_source: 'web', source_url: `https://${SHOP}`,
    opt_out: true,
    data: { type: 'contents', amount: minorUnits(order.total_price, currency), currency },
  };
  if (attrs.chatgpt_oppref?.trim()) event.oppref = attrs.chatgpt_oppref;
  const user = userData(order.customer, attrs.chatgpt_obref);
  if (Object.keys(user).length) event.user = user;
  // No invented API consent field. opt_out is not measurement consent.
  return { validate_only: false, integration_source: 'demo_chatgpt_ads_capi_sender', events: [event] };
}
