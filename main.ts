// Entry lifecycle for the make.fun agent/v1 harness: bind an ephemeral port, register
// it with the env, serve until the env reports the trial is done, then exit cleanly.

import { createApp } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envUrl === '') {
  process.stderr.write('[forge] MAKEFUN_ENV_URL is not set; nowhere to register\n');
  process.exit(1);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Backoff between registration/poll attempts: 200ms doubling, capped at 2s. */
function backoff(attempt: number): number {
  return Math.min(2000, 200 * 2 ** Math.min(attempt, 6));
}

async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`register refused with HTTP ${response.status}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register refused')) throw err;
    }
    await sleep(backoff(attempt));
  }
}

async function waitUntilDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(30_000) });
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Env not answering yet: keep polling.
    }
    await sleep(backoff(attempt));
  }
}

const server = createApp();
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, () => resolve());
});
const address = server.address();
if (address === null || typeof address === 'string') {
  process.stderr.write('[forge] server did not bind a TCP port\n');
  process.exit(1);
}
process.stdout.write(`[forge] listening on ${address.port}\n`);
await register(address.port);
process.stdout.write('[forge] registered with the env\n');
await waitUntilDone();
server.close();
process.stdout.write('[forge] trial done, exiting\n');
process.exit(0);
