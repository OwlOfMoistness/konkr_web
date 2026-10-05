import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** A signed random browser identity, not proof of a unique person or a completed game. */
export class VotingIdentity {
  private readonly secret: string;
  constructor(secret: string) {
    if (!/^[a-f0-9]{64}$/i.test(secret)) throw new Error('VOTING_SECRET must be 32 random bytes encoded as 64 hexadecimal characters');
    this.secret = secret;
  }
  private signature(id: string): string {
    return createHmac('sha256', this.secret).update(`konkr-voter-v1:${id}`).digest('base64url');
  }
  issue(): string {
    const id = randomBytes(32).toString('base64url');
    return `v1.${id}.${this.signature(id)}`;
  }
  verify(token: string): string | null {
    const match = /^v1\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (!match || !timingSafeEqual(Buffer.from(match[2]), Buffer.from(this.signature(match[1])))) return null;
    return createHash('sha256').update(match[1]).digest('hex');
  }
  quotaKey(value: string): string {
    return createHmac('sha256', this.secret).update(`konkr-quota-v1:${value}`).digest('hex');
  }
}
