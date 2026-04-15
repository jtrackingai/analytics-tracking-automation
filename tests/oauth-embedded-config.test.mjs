import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const authSource = fs.readFileSync(path.join(repoRoot, 'src', 'gtm', 'auth.ts'), 'utf8');

function extractConst(name) {
  const stringMatch = authSource.match(new RegExp(`const ${name} = '([^']+)';`));
  if (stringMatch) {
    return stringMatch[1];
  }

  const objectMatch = authSource.match(
    new RegExp(`const ${name} = \\{\\s*iv: '([^']+)',\\s*data: '([^']+)',\\s*tag: '([^']+)'`, 's'),
  );
  if (objectMatch) {
    return {
      iv: objectMatch[1],
      data: objectMatch[2],
      tag: objectMatch[3],
    };
  }

  throw new Error(`Unable to extract constant ${name} from src/gtm/auth.ts`);
}

function decryptEmbeddedValue(seed, ciphertext) {
  const key = crypto.createHash('sha256').update(seed).digest();
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(ciphertext.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(ciphertext.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext.data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

test('embedded OAuth seed remains stable and decrypts bundled client metadata', () => {
  const seed = extractConst('EMBEDDED_OAUTH_KEY_SEED');
  const clientIdCiphertext = extractConst('EMBEDDED_CLIENT_ID');
  const clientSecretCiphertext = extractConst('EMBEDDED_CLIENT_SECRET');

  assert.equal(
    seed,
    'event-tracking-skill::embedded-google-oauth::v1',
    'Changing EMBEDDED_OAUTH_KEY_SEED without re-encrypting the bundled OAuth metadata breaks sync OAuth bootstrap.',
  );

  const clientId = decryptEmbeddedValue(seed, clientIdCiphertext);
  const clientSecret = decryptEmbeddedValue(seed, clientSecretCiphertext);

  assert.match(clientId, /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/);
  assert.ok(clientSecret.length >= 20, 'Expected a non-trivial embedded OAuth client secret.');
});
