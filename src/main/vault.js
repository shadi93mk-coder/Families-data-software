'use strict';
// Encryption of the database file.
//
// File layout:  MAGIC(8) | headerLen(uint32 BE) | header JSON | iv(12) | tag(16) | ciphertext
//
// The database is encrypted with a random 256-bit data key (DEK) using AES-256-GCM.
// The DEK itself is never stored in clear: it is "wrapped" (encrypted) once per user with a key
// derived from that user's password (scrypt), and once with a recovery key shown to the admin.
// Logging in = unwrapping the DEK with the password. Without a valid password or the recovery
// key the data cannot be read.

const crypto = require('crypto');

const MAGIC = Buffer.from('FDENC01\n', 'ascii');
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'ascii');
const KDF = { N: 1 << 15, r: 8, p: 1 };
const B32 = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789'; // no I, L, O, U (avoid confusion)

function isEncrypted(buf) { return buf.length > MAGIC.length && buf.subarray(0, MAGIC.length).equals(MAGIC); }
function isPlainSqlite(buf) { return buf.length >= SQLITE_MAGIC.length && buf.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC); }

function userId(username) {
  return crypto.createHash('sha256').update('fd-user:' + String(username).trim().toLowerCase()).digest('hex').slice(0, 32);
}

function derive(secret, salt, kdf = KDF) {
  return crypto.scryptSync(Buffer.from(String(secret).normalize('NFC'), 'utf8'), salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * 1024 * 1024 });
}

function seal(key, plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return { iv, tag: c.getAuthTag(), ct };
}

function open(key, iv, tag, ct) {
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]);
  } catch (_) {
    return null;
  }
}

function wrap(secret, dek, kdf) {
  const salt = crypto.randomBytes(16);
  const s = seal(derive(secret, salt, kdf), dek);
  return { salt: salt.toString('base64'), iv: s.iv.toString('base64'), tag: s.tag.toString('base64'), key: s.ct.toString('base64') };
}

function unwrap(secret, w, kdf) {
  if (!w) return null;
  const k = derive(secret, Buffer.from(w.salt, 'base64'), kdf);
  return open(k, Buffer.from(w.iv, 'base64'), Buffer.from(w.tag, 'base64'), Buffer.from(w.key, 'base64'));
}

function normalizeRecovery(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1').replace(/U/g, 'V');
}

function newRecoveryKey() {
  const bytes = crypto.randomBytes(25); // 200 bits -> 40 base32 chars
  let bits = 0; let value = 0; let out = '';
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return out.match(/.{5}/g).join('-');
}

class Vault {
  constructor(header, dek) {
    this.header = header;
    this.dek = dek;
  }

  static create() {
    return new Vault({ v: 1, kdf: { ...KDF }, users: {}, pendingReset: [], recovery: null }, crypto.randomBytes(32));
  }

  static readHeader(buf) {
    if (!isEncrypted(buf)) throw Object.assign(new Error('not_encrypted'), { code: 'invalid_file' });
    const len = buf.readUInt32BE(MAGIC.length);
    const start = MAGIC.length + 4;
    const header = JSON.parse(buf.subarray(start, start + len).toString('utf8'));
    return { header, body: buf.subarray(start + len) };
  }

  /** Returns a Vault if the password opens the file, null otherwise. */
  static unlockWithPassword(buf, username, password) {
    const { header } = Vault.readHeader(buf);
    const dek = unwrap(password, header.users[userId(username)], header.kdf);
    return dek ? new Vault(header, dek) : null;
  }

  static unlockWithRecovery(buf, recoveryKey) {
    const { header } = Vault.readHeader(buf);
    const dek = unwrap(normalizeRecovery(recoveryKey), header.recovery, header.kdf);
    return dek ? new Vault(header, dek) : null;
  }

  static needsReset(buf, username) {
    const { header } = Vault.readHeader(buf);
    return (header.pendingReset || []).includes(userId(username));
  }

  hasUser(username) { return !!this.header.users[userId(username)]; }

  setPassword(username, password) {
    const id = userId(username);
    this.header.users[id] = wrap(password, this.dek, this.header.kdf);
    this.header.pendingReset = (this.header.pendingReset || []).filter(x => x !== id);
  }

  removeUser(username) {
    const id = userId(username);
    delete this.header.users[id];
    this.header.pendingReset = (this.header.pendingReset || []).filter(x => x !== id);
  }

  renameUser(oldName, newName) {
    const a = userId(oldName); const b = userId(newName);
    if (a === b) return;
    if (this.header.users[a]) { this.header.users[b] = this.header.users[a]; delete this.header.users[a]; }
    this.header.pendingReset = (this.header.pendingReset || []).map(x => (x === a ? b : x));
  }

  markPendingReset(usernames) {
    const set = new Set(this.header.pendingReset || []);
    for (const u of usernames) { const id = userId(u); if (!this.header.users[id]) set.add(id); }
    this.header.pendingReset = [...set];
  }

  /** Creates a new recovery key (the previous one stops working). Returns it for display. */
  newRecovery() {
    const key = newRecoveryKey();
    this.header.recovery = wrap(normalizeRecovery(key), this.dek, this.header.kdf);
    return key;
  }

  encrypt(plain) {
    const s = seal(this.dek, plain);
    const h = Buffer.from(JSON.stringify(this.header), 'utf8');
    const len = Buffer.alloc(4); len.writeUInt32BE(h.length);
    return Buffer.concat([MAGIC, len, h, s.iv, s.tag, s.ct]);
  }

  decrypt(buf) {
    const { body } = Vault.readHeader(buf);
    if (body.length < 28) return null;
    return open(this.dek, body.subarray(0, 12), body.subarray(12, 28), body.subarray(28));
  }
}

module.exports = { Vault, isEncrypted, isPlainSqlite, normalizeRecovery, newRecoveryKey, userId };
