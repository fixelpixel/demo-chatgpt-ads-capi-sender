import { createHash } from 'node:crypto';

export function normalize(kind, input) {
  if (typeof input !== 'string') throw new Error('Identifier must be a string');
  switch (kind) {
    case 'email': return input.trim().toLowerCase();
    case 'phone': {
      const value = input.replace(/[\s().-]/g, '').replace(/^\+/, '').replace(/^0+/, '');
      if (!/^\d{8,15}$/.test(value)) throw new Error('Phone must normalize to 8-15 digits including country code');
      return value;
    }
    case 'external': return input.trim();
    case 'name': return input.toLowerCase().replace(/[\s!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, '');
    default: throw new Error('Unsupported identifier kind');
  }
}

export function hashIdentifier(kind, input) {
  const value = normalize(kind, input);
  if (!value) throw new Error('Identifier cannot be empty after normalization');
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function userData(customer = {}, obref) {
  const user = {};
  for (const [field, kind, target] of [
    ['email', 'email', 'emails_sha256'],
    ['phone', 'phone', 'phone_numbers_sha256'],
    ['id', 'external', 'external_ids_sha256'],
    ['first_name', 'name', 'first_names_sha256'],
    ['last_name', 'name', 'last_names_sha256'],
  ]) {
    if (customer[field] !== undefined && customer[field] !== null && customer[field] !== '') {
      user[target] = [hashIdentifier(kind, customer[field])];
    }
  }
  if (obref !== undefined && typeof obref === 'string' && obref.trim()) user.obref = obref;
  return user;
}
