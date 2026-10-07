import { mkdir, readFile, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class Journal {
  constructor(path) {
    this.path = path;
    this.consents = new Map();
    this.completed = new Set();
    this.tail = Promise.resolve();
  }

  static async open(path) {
    const journal = new Journal(path);
    await mkdir(dirname(path), { recursive: true });
    let data;
    try { data = await readFile(path, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return journal; }
    // Fail closed on corrupt or partial records; do not silently lose dedup/consent.
    for (const line of data.split('\n').filter(Boolean)) journal.apply(JSON.parse(line));
    return journal;
  }

  apply(record) {
    if (record.kind === 'consent') this.consents.set(record.session_id, record);
    if (record.kind === 'delivery' && ['dry_run', 'sent'].includes(record.status)) this.completed.add(record.key);
  }

  async append(record) {
    await appendFile(this.path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    this.apply(record);
  }

  async exclusive(work) {
    const result = this.tail.then(work);
    this.tail = result.catch(() => {});
    return result;
  }

  setConsent(sessionId, state) {
    if (typeof sessionId !== 'string' || !/^demo-session-[A-Za-z0-9_-]{1,64}$/.test(sessionId)) {
      throw new Error('A synthetic measurement session id is required');
    }
    if (!['granted', 'denied', 'unknown'].includes(state)) throw new Error('Invalid consent state');
    return this.exclusive(async () => {
      const revision = (this.consents.get(sessionId)?.revision ?? 0) + 1;
      const record = { kind: 'consent', session_id: sessionId, state, revision };
      await this.append(record);
      return record;
    });
  }

  permits(attrs) {
    const current = this.consents.get(attrs.measurement_session_id);
    return current?.state === 'granted' && attrs.measurement_consent === 'granted' &&
      attrs.measurement_consent_revision === String(current.revision);
  }
}
