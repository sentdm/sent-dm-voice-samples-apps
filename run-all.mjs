#!/usr/bin/env node
// Runs the samples at the same time, each on its own port, with all their output in this terminal.
//
//   node run-all.mjs                   every sample
//   node run-all.mjs inbound chat      only the samples whose folder name starts with these words
//
// Each sample runs its `pnpm dev` script. A sample keeps the PORT from its own .env, because a
// tunnel you run yourself can point at it. The other samples get the next free port from 3000.
// Ctrl+C stops every sample the way Ctrl+C stops one, so the agents restore your Sent routing.
// Press Ctrl+C again to force them to stop.

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const FIRST_PORT = 3000;
// A free ngrok account allows this many agent sessions at once. Each sample opens its own.
const NGROK_SESSIONS = 3;
const root = path.dirname(fileURLToPath(import.meta.url));
const windows = process.platform === 'win32';
const colors = process.stdout.hasColors?.() ? [36, 35, 33, 32, 34, 31] : [];
const paint = (color, text) => (color ? `\x1b[${color}m${text}\x1b[0m` : text);

// The same rule as CI: every top-level folder with a package.json is a sample.
const all = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(path.join(root, entry.name, 'package.json')))
  .map((entry) => entry.name)
  .sort();
const words = process.argv.slice(2);
const unknown = words.filter((word) => !all.some((name) => name.startsWith(word)));
if (unknown.length) {
  console.error(`No sample folder starts with: ${unknown.join(', ')}\nSamples: ${all.join(', ')}`);
  process.exit(1);
}
const names = words.length ? all.filter((name) => words.some((word) => name.startsWith(word))) : all;
const label = (name) => name.replace(/-sent$/, '');
const width = Math.max(...names.map((name) => label(name).length));

const samples = names.map((name, i) => {
  const dir = path.join(root, name);
  const dotenv = readDotenv(dir);
  return {
    name,
    dir,
    dotenv,
    // What the sample sees: its .env, with shell variables winning, as each sample loads it.
    env: { ...dotenv, ...process.env },
    prefix: paint(colors[i % colors.length], `${label(name).padEnd(width)} | `),
    port: undefined,
    child: undefined,
  };
});

const taken = new Map();
for (const sample of samples) {
  const port = Number.parseInt(sample.dotenv.PORT ?? '', 10);
  if (Number.isNaN(port)) continue;
  if (taken.has(port)) {
    console.warn(`${sample.name}: PORT=${port} in its .env is used by ${taken.get(port)}, so it gets another port.`);
    continue;
  }
  sample.port = port;
  taken.set(port, sample.name);
}
let nextPort = FIRST_PORT;
for (const sample of samples.filter((sample) => !sample.port)) {
  while (taken.has(nextPort) || (await inUse(nextPort))) nextPort++;
  sample.port = nextPort;
  taken.set(nextPort, sample.name);
}

console.log(`Running ${samples.length} sample${samples.length === 1 ? '' : 's'}. Press Ctrl+C to stop them all.`);
for (const sample of samples) console.log(`  ${label(sample.name).padEnd(width)}  http://localhost:${sample.port}`);
warnAboutTunnels();
console.log('');

let stopping = false;
let failed = false;
for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(name, () => stop(name === 'SIGHUP' ? 'SIGTERM' : name));

await Promise.all(
  samples.map(async (sample) => {
    if (!existsSync(path.join(sample.dir, 'node_modules'))) {
      print(sample, 'Installing dependencies…');
      const code = await run(sample, ['install', '--frozen-lockfile']);
      if (code !== 0 && !stopping) {
        failed = true;
        print(sample, `pnpm install failed (exit code ${code}), so this sample does not start.`);
      }
      if (code !== 0) return;
    }
    if (stopping) return;
    const code = await run(sample, ['run', 'dev']);
    if (!stopping) {
      failed ||= code !== 0;
      print(sample, `Exited with code ${code}.`);
    }
  }),
);
if (stopping) console.log('All samples stopped.');
process.exitCode = failed ? 1 : 0;

function readDotenv(dir) {
  try {
    return parseEnv(readFileSync(path.join(dir, '.env'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

/** True when something already answers on localhost:port, over IPv4 or IPv6. */
function inUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: 'localhost' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/** Tunnel limits show only when a sample opens its tunnel, so name them before that. */
function warnAboutTunnels() {
  // The voice feature tour opens no tunnel when PUBLIC_BASE_URL names your own public URL.
  const ngrok = samples.filter(
    ({ env }) => (env.TUNNEL_PROVIDER?.trim() || 'ngrok').toLowerCase() === 'ngrok' && !env.PUBLIC_BASE_URL?.trim(),
  );
  if (ngrok.length >= NGROK_SESSIONS) {
    console.warn(
      `\n${ngrok.length} of these samples use ngrok. A free ngrok account allows ${NGROK_SESSIONS} sessions at once, and any ngrok you run yourself uses one too.` +
        `\nIf a Start fails with ERR_NGROK_108, set TUNNEL_PROVIDER=cloudflare in the .env of one sample.`,
    );
  }
  const byDomain = Map.groupBy(
    ngrok.filter(({ env }) => env.NGROK_DOMAIN?.trim()),
    ({ env }) => env.NGROK_DOMAIN.trim(),
  );
  for (const [domain, group] of byDomain) {
    if (group.length < 2) continue;
    console.warn(`\n${group.map(({ name }) => name).join(', ')} use NGROK_DOMAIN=${domain}. Only one of them can be started at a time.`);
  }
}

function print(sample, line) {
  process.stdout.write(`${sample.prefix}${line}\n`);
}

/** Runs pnpm in the sample's folder and resolves with its exit code. */
function run(sample, args) {
  return new Promise((resolve) => {
    const env = { ...process.env, PORT: String(sample.port) };
    if (colors.length) env.FORCE_COLOR = '1';
    // On macOS and Linux the sample gets its own process group, so a signal reaches pnpm, the shell
    // it starts, and the server under them. On Windows, Ctrl+C reaches every process in the console.
    const child = spawn('pnpm', args, {
      cwd: sample.dir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !windows,
      shell: windows,
    });
    sample.child = child;
    for (const [input, output] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ]) {
      readline.createInterface({ input, crlfDelay: Infinity }).on('line', (line) => output.write(`${sample.prefix}${line}\n`));
    }
    child.once('error', (error) => {
      print(sample, error.code === 'ENOENT' ? 'pnpm is not installed. Get it from https://pnpm.io/installation.' : error.message);
      resolve(1);
    });
    child.once('close', (code) => {
      sample.child = undefined;
      resolve(code ?? 1);
    });
  });
}

function stop(signal) {
  const running = samples.filter((sample) => sample.child);
  if (stopping) {
    console.log('\nForcing every sample to stop.');
    for (const sample of running) send(sample.child, 'SIGKILL');
    return;
  }
  stopping = true;
  console.log('\nStopping every sample. The agents restore your Sent routing first. Press Ctrl+C again to force.');
  for (const sample of running) send(sample.child, signal);
}

function send(child, signal) {
  try {
    if (!windows) process.kill(-child.pid, signal);
    else if (signal === 'SIGKILL') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
  } catch {
    // The process group has already exited.
  }
}
