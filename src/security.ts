import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export const secret = () => randomBytes(32).toString('base64url');
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export class Vault {
  private key: Buffer;
  constructor(key: string) {
    this.key = Buffer.from(key, 'base64');
    if (this.key.length !== 32) throw new Error('ENCRYPTION_KEY must be a base64-encoded 32-byte key');
  }
  seal(value: unknown, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context));
    const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join('.');
  }
  open<T>(value: string, context: string): T {
    const [version, iv, tag, data] = value.split('.');
    if (version !== 'v1' || !iv || !tag || !data) throw new Error('Invalid encrypted record');
    const cipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    cipher.setAAD(Buffer.from(context));
    cipher.setAuthTag(Buffer.from(tag, 'base64'));
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(data, 'base64')), cipher.final()]).toString());
  }
}
