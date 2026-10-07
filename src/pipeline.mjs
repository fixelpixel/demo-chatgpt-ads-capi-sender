import { attributes, buildPayload } from './payload.mjs';
import { dedupKey } from './shared.mjs';
import { requestUrl, sendPayload } from './sender.mjs';

export function createPipeline({ journal, config, clock = Date.now, transport = sendPayload, log = () => {} }) {
  return order => journal.exclusive(async () => {
    const attrs = attributes(order);
    // Check before hashing, collecting matching fields, dedup or any send/retry.
    if (!journal.permits(attrs)) {
      await journal.append({ kind: 'delivery', status: 'consent_blocked' });
      return { status: 'consent_blocked' };
    }
    const payload = buildPayload(order, attrs, clock());
    const event = payload.events[0];
    const identity = dedupKey(config.pixelId, event.type, event.id);
    // A previous dry run must never suppress a later explicit live send.
    const key = JSON.stringify([config.mode, identity]);
    if (journal.completed.has(key)) return { status: 'duplicate', event_id: event.id };
    const record = { kind: 'delivery', key, event_id: event.id, url: requestUrl(config.pixelId), payload };
    if (config.mode === 'send') {
      // Recheck at the sending boundary. Updates and sends are serialized.
      if (!journal.permits(attrs)) return { status: 'consent_blocked' };
      try {
        const receipt = await transport(payload, config);
        await journal.append({ ...record, status: 'sent', ...receipt });
      } catch {
        await journal.append({ kind: 'delivery', status: 'send_failed', event_id: event.id });
        return { status: 'send_failed', event_id: event.id };
      }
    } else {
      await journal.append({ ...record, status: 'dry_run' });
      log({ mode: 'dry-run', url: record.url, payload });
    }
    return { status: config.mode === 'send' ? 'sent' : 'dry_run', event_id: event.id };
  });
}
