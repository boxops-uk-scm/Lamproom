// The GitHub calls the server makes: user authorization (web flow with
// PKCE, device flow for terminals) and the two lookups behind sign-in and
// project registration. GitHub still requires the client secret at the
// token exchange, so the server is a confidential client and the browser
// only starts the flow. Base URLs are configurable so tests run against a
// fake.

export interface GitHubConfig {
  clientId: string;
  clientSecret: string;
  /** Web base, default https://github.com */
  url: string;
  /** API base, default https://api.github.com */
  apiUrl: string;
  /** Extra OAuth scopes (OAuth Apps only; GitHub Apps take permissions from the installation). */
  scope?: string;
}

export interface GitHubUser {
  id: number;
  login: string;
  name?: string | null;
  avatar_url?: string;
}

export interface GitHubRepo {
  id: number;
  full_name: string;
  private: boolean;
  permissions?: { admin?: boolean; push?: boolean; pull?: boolean };
}

export function githubFromEnv(env: NodeJS.ProcessEnv = process.env): GitHubConfig | undefined {
  const clientId = env.COALFACE_GITHUB_CLIENT_ID;
  if (!clientId) return undefined;
  return {
    clientId,
    clientSecret: env.COALFACE_GITHUB_CLIENT_SECRET ?? '',
    url: (env.COALFACE_GITHUB_URL ?? 'https://github.com').replace(/\/$/, ''),
    apiUrl: (env.COALFACE_GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, ''),
    scope: env.COALFACE_GITHUB_SCOPE,
  };
}

export class GitHub {
  constructor(readonly cfg: GitHubConfig) {}

  authorizeUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string {
    const q = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: input.redirectUri,
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
    });
    if (this.cfg.scope) q.set('scope', this.cfg.scope);
    return `${this.cfg.url}/login/oauth/authorize?${q}`;
  }

  async exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<string> {
    const r = await this.form(`${this.cfg.url}/login/oauth/access_token`, {
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    });
    if (typeof r.access_token !== 'string') throw new Error(`GitHub refused the code: ${String(r.error_description ?? r.error ?? 'no token')}`);
    return r.access_token;
  }

  async deviceCode(): Promise<{ device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number }> {
    const body: Record<string, string> = { client_id: this.cfg.clientId };
    if (this.cfg.scope) body.scope = this.cfg.scope;
    const r = await this.form(`${this.cfg.url}/login/device/code`, body);
    if (typeof r.device_code !== 'string') throw new Error(`GitHub device flow unavailable: ${String(r.error ?? 'no device code')}`);
    return r as unknown as { device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number };
  }

  /** One poll of the device grant. */
  async pollDevice(deviceCode: string): Promise<{ token: string } | { pending: 'authorization_pending' | 'slow_down' } | { failed: string }> {
    const r = await this.form(`${this.cfg.url}/login/oauth/access_token`, {
      client_id: this.cfg.clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    if (typeof r.access_token === 'string') return { token: r.access_token };
    const err = String(r.error ?? 'unknown');
    if (err === 'authorization_pending' || err === 'slow_down') return { pending: err };
    return { failed: err };
  }

  async user(token: string): Promise<GitHubUser> {
    return (await this.api(token, '/user')) as GitHubUser;
  }

  /** The repository as this user sees it; undefined when they cannot see it. */
  async repo(token: string, owner: string, name: string): Promise<GitHubRepo | undefined> {
    try {
      return (await this.api(token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`)) as GitHubRepo;
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return undefined;
      throw e;
    }
  }

  private async form(url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    });
    if (!res.ok) throw new HttpError(res.status, `${url}: ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  private async api(token: string, path: string): Promise<unknown> {
    const res = await fetch(`${this.cfg.apiUrl}${path}`, {
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': 'coalface' },
    });
    if (!res.ok) throw new HttpError(res.status, `GitHub ${path}: ${res.status}`);
    return res.json();
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
