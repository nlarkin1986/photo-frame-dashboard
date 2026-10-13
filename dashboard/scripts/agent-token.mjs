#!/usr/bin/env node
// Manage agent tokens for the family board (stored in Upstash Redis; only SHA-256 hashes are kept).
//
//   node scripts/agent-token.mjs create --label "Grocery agent" --scopes shopping:write,board:read [--mode review]
//   node scripts/agent-token.mjs list
//   node scripts/agent-token.mjs revoke <id>
//
// Production Redis credentials live in .env.board (git-ignored, mode 600) — run it as:
//   node --env-file=.env.board scripts/agent-token.mjs create --label "Grocery agent" --scopes shopping:write,board:read
// (Without --env-file the script loads .env.board itself if present; it never reads .env.local.)
// Needs KV_REST_API_URL/KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL/_TOKEN). Credential values are
// never printed. The token is printed once — store it in the agent.
// For local testing against `npm run dev` (in-memory store) set BOARD_DEV_TOKEN in .env.local instead.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRedisStore, redisEnv } from '../lib/board/store.js';
import { createToken, listTokens, MODES, revokeToken, SCOPES } from '../lib/board/tokens.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(root, '.env.board');
if (!redisEnv() && fs.existsSync(envFile)) process.loadEnvFile(envFile);

function usage(code = 1) {
  console.error(`usage:
  agent-token.mjs create --label "<label>" --scopes <a,b,…> [--mode direct|review]
  agent-token.mjs list
  agent-token.mjs revoke <id>
scopes: ${SCOPES.join(', ')}
modes:  ${MODES.join(', ')} (review = writes wait for Approve on the frame)`);
  process.exit(code);
}

function flag(args, name) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) usage();
  return v;
}

const [cmd, ...args] = process.argv.slice(2);
if (!cmd || cmd === '-h' || cmd === '--help') usage(cmd ? 0 : 1);

const env = redisEnv();
if (!env) {
  console.error('No Redis configured: set KV_REST_API_URL + KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN),');
  console.error('e.g. put them in .env.board and run: node --env-file=.env.board scripts/agent-token.mjs …');
  console.error('For local dev only, set BOARD_DEV_TOKEN in .env.local and use it as the bearer token with `npm run dev`.');
  process.exit(2);
}
const store = await createRedisStore(env);

try {
  if (cmd === 'create') {
    const label = flag(args, 'label');
    const scopes = flag(args, 'scopes');
    const mode = flag(args, 'mode') || 'direct';
    if (!label || !scopes) usage();
    const { token, record } = await createToken(store, { label, scopes, mode });
    console.log(`Created ${record.id} "${record.label}" scopes=${record.scopes.join(',')} mode=${record.mode}`);
    console.log('\nToken (shown once — store it in the agent now):\n');
    console.log(token);
  } else if (cmd === 'list') {
    const list = await listTokens(store);
    if (!list.length) console.log('No tokens.');
    for (const r of list) {
      console.log([r.id, JSON.stringify(r.label), r.scopes.join(','), r.mode, r.revokedAt ? `REVOKED ${r.revokedAt}` : 'active', `created ${r.createdAt}`, `last used ${r.lastUsedAt || 'never'}`].join('  '));
    }
  } else if (cmd === 'revoke') {
    const id = args[0];
    if (!id) usage();
    if (!(await revokeToken(store, id))) {
      console.error(`No token with id ${id}`);
      process.exit(1);
    }
    console.log(`Revoked ${id}`);
  } else {
    usage();
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
