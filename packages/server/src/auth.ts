// Who is calling. Humans sign in with GitHub in the browser (session cookie)
// or from a terminal (device flow, then a long-lived API token). Each
// GitHub token is encrypted at rest. In development the server can run with
// COALFACE_DEV_USER set, which signs every request in as that user without
// GitHub; the UI shows it.

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Actor } from '@coalface/core';
import type { Db } from './db.js';
import type { GitHub, GitHubUser } from './github.js';

export interface User {
  id: string;
  login: string;
  name?: string;
  avatar?: string;
}

export type AuthMode = 'github' | 'dev';

const SESSION_DAYS = 30;
const DEVICE_MINUTES = 15;

export function actorFor(user: User): Actor {
  return { id: user.id, kind: 'human', name: user.login };
}

export function agentActor(user: User, label: string): Actor {
  return { id: `agent:${label}`, kind: 'agent', name: `agent ${label}`, principal: user.id };
}

export class Auth {
  private key: Buffer;
  private pending = new Map<string, { verifier: string; created: number }>();

  constructor(
    readonly db: Db,
    secret: string,
    readonly github: GitHub | undefined,
    readonly devUser?: string,
  ) {
    this.key = createHash('sha256').update(secret).digest();
  }

  get mode(): AuthMode {
    return this.devUser ? 'dev' : 'github';
  }

  // ---- users -----------------------------------------------------------

  async upsertGitHubUser(gh: GitHubUser, token: string): Promise<User> {
    const u: User = { id: `github:${gh.id}`, login: gh.login, name: gh.name ?? undefined, avatar: gh.avatar_url };
    await this.db.run(
      `INSERT INTO users (id, login, name, avatar, token_enc, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET login = excluded.login, name = excluded.name, avatar = excluded.avatar, token_enc = excluded.token_enc`,
      [u.id, u.login, u.name ?? null, u.avatar ?? null, this.encrypt(token), new Date().toISOString()],
    );
    return u;
  }

  async user(id: string): Promise<User | undefined> {
    const r = await this.db.get(`SELECT id, login, name, avatar FROM users WHERE id = ?`, [id]);
    return r ? toUser(r) : undefined;
  }

  /** The user's GitHub token, for calls the server makes on their behalf. */
  async githubToken(userId: string): Promise<string | undefined> {
    const r = await this.db.get<{ token_enc: string | null }>(`SELECT token_enc FROM users WHERE id = ?`, [userId]);
    return r?.token_enc ? this.decrypt(r.token_enc) : undefined;
  }

  private async devUserRecord(): Promise<User> {
    const login = this.devUser!;
    const id = `dev:${login}`;
    const existing = await this.user(id);
    if (existing) return existing;
    await this.db.run(`INSERT INTO users (id, login, name, avatar, token_enc, created_at) VALUES (?, ?, ?, NULL, NULL, ?) ON CONFLICT(id) DO NOTHING`, [
      id,
      login,
      login,
      new Date().toISOString(),
    ]);
    return { id, login, name: login };
  }

  // ---- web flow --------------------------------------------------------

  startWebFlow(redirectUri: string): { url: string; state: string } {
    if (!this.github) throw new Error('GitHub sign-in is not configured');
    const state = randomBytes(16).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    this.pending.set(state, { verifier, created: Date.now() });
    for (const [k, v] of this.pending) if (Date.now() - v.created > 10 * 60_000) this.pending.delete(k);
    return { url: this.github.authorizeUrl({ state, codeChallenge: challenge, redirectUri }), state };
  }

  async finishWebFlow(input: { code: string; state: string; redirectUri: string }): Promise<{ user: User; cookie: string }> {
    if (!this.github) throw new Error('GitHub sign-in is not configured');
    const p = this.pending.get(input.state);
    if (!p) throw new Error('sign-in state unknown or expired; start again');
    this.pending.delete(input.state);
    const token = await this.github.exchangeCode({ code: input.code, codeVerifier: p.verifier, redirectUri: input.redirectUri });
    const user = await this.upsertGitHubUser(await this.github.user(token), token);
    return { user, cookie: await this.createSession(user.id) };
  }

  // ---- device flow (terminals) ------------------------------------------

  async startDeviceFlow(label?: string): Promise<{ id: string; userCode: string; verificationUri: string; interval: number; expiresIn: number }> {
    if (!this.github) throw new Error('GitHub sign-in is not configured');
    const d = await this.github.deviceCode();
    const id = randomBytes(16).toString('base64url');
    await this.db.run(`INSERT INTO device_grants (id, github_device_code, label, created_at) VALUES (?, ?, ?, ?)`, [
      id,
      d.device_code,
      label ?? null,
      new Date().toISOString(),
    ]);
    return { id, userCode: d.user_code, verificationUri: d.verification_uri, interval: d.interval, expiresIn: d.expires_in };
  }

  async pollDeviceFlow(id: string): Promise<{ status: 'pending' | 'slow_down' | 'expired' | 'denied' } | { status: 'ok'; token: string; user: User }> {
    if (!this.github) throw new Error('GitHub sign-in is not configured');
    const g = await this.db.get<{ github_device_code: string; label: string | null; created_at: string; token: string | null }>(
      `SELECT github_device_code, label, created_at, token FROM device_grants WHERE id = ?`,
      [id],
    );
    if (!g) return { status: 'expired' };
    if (Date.now() - Date.parse(g.created_at) > DEVICE_MINUTES * 60_000) return { status: 'expired' };
    const r = await this.github.pollDevice(g.github_device_code);
    if ('pending' in r) return { status: r.pending === 'slow_down' ? 'slow_down' : 'pending' };
    if ('failed' in r) return { status: r.failed === 'expired_token' ? 'expired' : 'denied' };
    const user = await this.upsertGitHubUser(await this.github.user(r.token), r.token);
    const token = await this.mintToken(user.id, g.label ?? undefined);
    await this.db.run(`DELETE FROM device_grants WHERE id = ?`, [id]);
    return { status: 'ok', token, user };
  }

  // ---- sessions and tokens ---------------------------------------------

  async createSession(userId: string): Promise<string> {
    const id = randomBytes(24).toString('base64url');
    const now = Date.now();
    await this.db.run(`INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`, [
      id,
      userId,
      new Date(now).toISOString(),
      new Date(now + SESSION_DAYS * 86_400_000).toISOString(),
    ]);
    return `${id}.${this.sign(id)}`;
  }

  async endSession(cookie: string | undefined): Promise<void> {
    const id = this.verifyCookie(cookie);
    if (id) await this.db.run(`DELETE FROM sessions WHERE id = ?`, [id]);
  }

  async mintToken(userId: string, label?: string): Promise<string> {
    const token = `cft_${randomBytes(24).toString('base64url')}`;
    await this.db.run(`INSERT INTO api_tokens (hash, user_id, label, created_at) VALUES (?, ?, ?, ?)`, [
      sha(token),
      userId,
      label ?? null,
      new Date().toISOString(),
    ]);
    return token;
  }

  /** The signed-in user for a request, from its bearer token or session cookie. */
  async authenticate(headers: { authorization?: string; cookie?: string }): Promise<User | undefined> {
    const bearer = /^Bearer\s+(\S+)$/i.exec(headers.authorization ?? '')?.[1];
    if (bearer) {
      const r = await this.db.get<{ user_id: string }>(`SELECT user_id FROM api_tokens WHERE hash = ?`, [sha(bearer)]);
      if (r) {
        await this.db.run(`UPDATE api_tokens SET last_used_at = ? WHERE hash = ?`, [new Date().toISOString(), sha(bearer)]);
        return this.user(r.user_id);
      }
      if (!this.devUser) return undefined;
    }
    const sid = this.verifyCookie(readCookie(headers.cookie, 'cf_session'));
    if (sid) {
      const r = await this.db.get<{ user_id: string; expires_at: string }>(`SELECT user_id, expires_at FROM sessions WHERE id = ?`, [sid]);
      if (r && Date.parse(r.expires_at) > Date.now()) return this.user(r.user_id);
    }
    if (this.devUser) return this.devUserRecord();
    return undefined;
  }

  private sign(v: string): string {
    return createHmac('sha256', this.key).update(v).digest('base64url');
  }

  private verifyCookie(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const dot = value.lastIndexOf('.');
    if (dot < 0) return undefined;
    const id = value.slice(0, dot);
    const sig = value.slice(dot + 1);
    const want = this.sign(id);
    if (sig.length !== want.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return undefined;
    return id;
  }

  private encrypt(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return `${iv.toString('base64url')}.${enc.toString('base64url')}.${c.getAuthTag().toString('base64url')}`;
  }

  private decrypt(value: string): string {
    const [iv, enc, tag] = value.split('.');
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv!, 'base64url'));
    d.setAuthTag(Buffer.from(tag!, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(enc!, 'base64url')), d.final()]).toString('utf8');
  }
}

function sha(v: string): string {
  return createHash('sha256').update(v).digest('hex');
}

function toUser(r: Record<string, unknown>): User {
  return { id: String(r.id), login: String(r.login), name: r.name == null ? undefined : String(r.name), avatar: r.avatar == null ? undefined : String(r.avatar) };
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}
