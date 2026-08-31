import crypto from 'node:crypto';

const keyFromEnv = () => {
  const raw = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!raw || !/^[0-9a-f]{64}$/i.test(raw)) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY must be a 32-byte hexadecimal key');
  }
  return Buffer.from(raw, 'hex');
};

export function encryptJson(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFromEnv(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { v: 1, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') };
}

export function decryptJson(record) {
  if (!record || record.v !== 1) throw new Error('Unsupported encrypted record');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFromEnv(), Buffer.from(record.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(record.tag, 'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64url')), decipher.final()]).toString('utf8'));
}

export function sha256Fingerprint(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
