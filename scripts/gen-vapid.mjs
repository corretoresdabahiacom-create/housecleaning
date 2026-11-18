// Generates a VAPID key pair in the format this app expects (raw base64url).
// Run on your own computer:  node scripts/gen-vapid.mjs
// Put VAPID_PUBLIC_KEY in wrangler.toml vars; set VAPID_PRIVATE_KEY with `wrangler secret put`. Never commit the private key.
import { generateKeyPairSync } from 'node:crypto';
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const j = privateKey.export({ format: 'jwk' });
const pub = Buffer.concat([Buffer.from([4]), Buffer.from(j.x, 'base64url'), Buffer.from(j.y, 'base64url')]).toString('base64url');
console.log('VAPID_PUBLIC_KEY  (goes in wrangler.toml [env.staging] vars):\n' + pub + '\n');
console.log('VAPID_PRIVATE_KEY (secret — paste when `npx wrangler secret put VAPID_PRIVATE_KEY --env staging` asks):\n' + j.d + '\n');
