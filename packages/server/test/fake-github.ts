// A stand-in for github.com and api.github.com: approves every
// authorization, knows a few users and repositories. Enough to exercise
// both sign-in flows and project registration end to end.

import http from 'node:http';

export interface FakeGitHub {
  url: string;
  users: Record<string, { id: number; login: string; name: string; repos: string[] }>;
  /** device_code -> approved token, set by approveDevice */
  approveDevice(userCode: string, login: string): void;
  close(): Promise<void>;
}

export async function startFakeGitHub(): Promise<FakeGitHub> {
  const users: FakeGitHub['users'] = {
    tom: { id: 1001, login: 'tom', name: 'Tom Bates', repos: ['boxops/lamproom', 'boxops/www'] },
    ada: { id: 1002, login: 'ada', name: 'Ada', repos: ['boxops/lamproom'] },
  };
  const codes = new Map<string, string>(); // auth code -> login
  const tokens = new Map<string, string>(); // token -> login
  const devices = new Map<string, { userCode: string; login?: string }>();
  let n = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const body = await new Promise<string>((resolve) => {
      let d = '';
      req.on('data', (c) => (d += c));
      req.on('end', () => resolve(d));
    });
    const form = new URLSearchParams(body);
    const json = (status: number, b: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(b));
    };
    if (url.pathname === '/login/oauth/authorize') {
      // Pretend the user approved as `login` (query, default tom) and bounce back.
      const login = url.searchParams.get('login') ?? 'tom';
      const code = `code-${++n}`;
      codes.set(code, login);
      const back = new URL(url.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      res.writeHead(302, { location: back.toString() }).end();
      return;
    }
    if (url.pathname === '/login/oauth/access_token') {
      if (form.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') {
        const d = devices.get(form.get('device_code') ?? '');
        if (!d) return json(200, { error: 'expired_token' });
        if (!d.login) return json(200, { error: 'authorization_pending' });
        const token = `tok-${++n}`;
        tokens.set(token, d.login);
        return json(200, { access_token: token, token_type: 'bearer' });
      }
      const login = codes.get(form.get('code') ?? '');
      if (!login || !form.get('code_verifier')) return json(200, { error: 'bad_verification_code' });
      const token = `tok-${++n}`;
      tokens.set(token, login);
      return json(200, { access_token: token, token_type: 'bearer' });
    }
    if (url.pathname === '/login/device/code') {
      const deviceCode = `dev-${++n}`;
      const userCode = `ABCD-${n}`;
      devices.set(deviceCode, { userCode });
      return json(200, { device_code: deviceCode, user_code: userCode, verification_uri: 'http://x/login/device', expires_in: 900, interval: 1 });
    }
    const auth = /^Bearer (\S+)/.exec(req.headers.authorization ?? '')?.[1];
    const login = auth && tokens.get(auth);
    const me = login ? users[login] : undefined;
    if (url.pathname === '/user') {
      if (!me) return json(401, { message: 'bad credentials' });
      return json(200, { id: me.id, login: me.login, name: me.name, avatar_url: `http://x/${me.login}.png` });
    }
    const repo = /^\/repos\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (repo) {
      const full = `${repo[1]}/${repo[2]}`;
      if (!me || !me.repos.includes(full)) return json(404, { message: 'Not Found' });
      return json(200, { id: 500 + me.repos.indexOf(full), full_name: full, private: true, permissions: { push: true, pull: true } });
    }
    json(404, { message: 'nope' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}`,
    users,
    approveDevice(userCode, login) {
      for (const d of devices.values()) if (d.userCode === userCode) d.login = login;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}
