import crypto from 'node:crypto';

const DEFAULT_KEY = '2b591c1b056bd55b00938aba1f98db63f67801fa945f060ad085f2b0a3f96d58';

const keyFromEnv = () => {
  const raw = process.env.CREDENTIAL_ENCRYPTION_KEY || DEFAULT_KEY;
  if (!/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(DEFAULT_KEY, 'hex');
  return Buffer.from(raw, 'hex');
};

export function encryptJson(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFromEnv(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { v: 1, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') };
}

export function decryptJson(record) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFromEnv(), Buffer.from(record.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(record.tag, 'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64url')), decipher.final()]).toString('utf8'));
}

export function sha256Fingerprint(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
