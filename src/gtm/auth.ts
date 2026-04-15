import { ClientAuthentication, CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as crypto from 'crypto';
import { AddressInfo } from 'net';
import open from 'open';

// OAuth client metadata is embedded in obfuscated form in the codebase.
// User-granted OAuth tokens are cached inside each artifact directory.
const DEFAULT_OUTPUT_ROOT = path.join(process.cwd(), 'output');
const LEGACY_CREDENTIALS_FILES = [
  path.join(process.cwd(), 'output', 'auth', 'credentials.json'),
  path.join(process.cwd(), 'credentials', 'credentials.json'),
  path.join(process.env.HOME || '~', '.event-tracking', 'credentials.json'),
];
const OAUTH_CLIENT_ID_ENV = 'GOOGLE_OAUTH_CLIENT_ID';
const OAUTH_CLIENT_SECRET_ENV = 'GOOGLE_OAUTH_CLIENT_SECRET';
// Keep this seed stable unless EMBEDDED_CLIENT_ID and EMBEDDED_CLIENT_SECRET
// are re-encrypted together. Renaming it breaks OAuth bootstrap for every sync.
const EMBEDDED_OAUTH_KEY_SEED = 'event-tracking-skill::embedded-google-oauth::v1';
const EMBEDDED_CLIENT_ID = {
  iv: '4s+RgoYk7o+BncoX',
  data: 'i2meCXHJekMYwpY73pgBXbf6tLCd4GYul8FAEmVkI8q2R/oT2tWSOvyfO0TvqJR1c01MnGXRzR9W7MqhornnmhqLmDYOXxk2',
  tag: 'kUgZLkjObJqbOCgDZz39Gg==',
} as const;
const EMBEDDED_CLIENT_SECRET = {
  iv: 'URtYDu90sp7cFruy',
  data: 'dcoVNgEssDu7Ay3fE+StoMawuPqfgcdAX7uZRCCU2KJzOHs=',
  tag: 'kTCruiYchh+k5yh76lY2aA==',
} as const;

// GTM API requires these scopes
const SCOPES = [
  'https://www.googleapis.com/auth/tagmanager.edit.containers',
  'https://www.googleapis.com/auth/tagmanager.edit.containerversions',
  'https://www.googleapis.com/auth/tagmanager.manage.accounts',
  'https://www.googleapis.com/auth/tagmanager.readonly',
  'https://www.googleapis.com/auth/tagmanager.publish',
];
const TOKEN_EXPIRY_SKEW_MS = 5 * 60 * 1000;

interface StoredCredentials {
  access_token: string;
  refresh_token: string;
  expiry_date: number;
  client_id: string;
  client_secret?: string;
  granted_scopes?: string[];
}

interface OAuthClientConfig {
  client_id: string;
  client_secret: string;
}

interface EmbeddedCiphertext {
  iv: string;
  data: string;
  tag: string;
}

interface LoadedStoredCredentials {
  credentials: StoredCredentials;
  sourceFile: string;
}

class MissingScopesError extends Error {
  missingScopes: string[];
  grantedScopes: string[];

  constructor(missingScopes: string[], grantedScopes: string[]) {
    super(`Missing required GTM OAuth scopes: ${missingScopes.join(', ')}`);
    this.name = 'MissingScopesError';
    this.missingScopes = missingScopes;
    this.grantedScopes = grantedScopes;
  }
}

function getCredentialsFile(artifactDir: string): string {
  return path.join(path.resolve(artifactDir), 'credentials.json');
}

function ensureCredentialsDir(artifactDir: string): void {
  const dir = path.dirname(getCredentialsFile(artifactDir));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function loadStoredCredentials(artifactDir: string): LoadedStoredCredentials | null {
  const credentialsFile = getCredentialsFile(artifactDir);
  for (const file of [credentialsFile, ...LEGACY_CREDENTIALS_FILES]) {
    if (!fs.existsSync(file)) continue;
    const credentials = loadJsonFile<StoredCredentials>(file);
    if (isStoredCredentials(credentials)) {
      return { credentials, sourceFile: file };
    }
  }
  return null;
}

function saveCredentials(artifactDir: string, creds: StoredCredentials): void {
  const credentialsFile = getCredentialsFile(artifactDir);
  ensureCredentialsDir(artifactDir);
  fs.writeFileSync(credentialsFile, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

function findArtifactCredentialFiles(outputRoot: string): string[] {
  const resolvedRoot = path.resolve(outputRoot);
  if (!fs.existsSync(resolvedRoot)) return [];

  const files: string[] = [];
  for (const entry of fs.readdirSync(resolvedRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(resolvedRoot, entry.name, 'credentials.json');
    if (fs.existsSync(file)) files.push(file);
  }
  return files;
}

function normalizeScopes(scopes: string[] | string | null | undefined): string[] {
  if (!scopes) return [];
  const values = Array.isArray(scopes) ? scopes : scopes.split(/\s+/);
  return [...new Set(values.map(scope => scope.trim()).filter(Boolean))].sort();
}

function getMissingScopes(grantedScopes: string[]): string[] {
  const granted = new Set(normalizeScopes(grantedScopes));
  return SCOPES.filter(scope => !granted.has(scope));
}

function formatScopes(scopes: string[]): string {
  return scopes.length > 0 ? scopes.join(', ') : '(none)';
}

function isStoredCredentials(value: unknown): value is StoredCredentials {
  return !!value
    && typeof value === 'object'
    && typeof (value as StoredCredentials).access_token === 'string'
    && typeof (value as StoredCredentials).refresh_token === 'string'
    && typeof (value as StoredCredentials).expiry_date === 'number'
    && typeof (value as StoredCredentials).client_id === 'string';
}

function toBase64Url(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function createOAuthState(): string {
  return toBase64Url(crypto.randomBytes(32));
}

function decryptEmbeddedValue(ciphertext: EmbeddedCiphertext): string {
  const key = crypto.createHash('sha256').update(EMBEDDED_OAUTH_KEY_SEED).digest();
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(ciphertext.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(ciphertext.tag, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertext.data, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

function buildStoredCredentials(input: {
  accessToken: string;
  refreshToken: string;
  expiryDate: number;
  clientId: string;
  grantedScopes: string[];
}): StoredCredentials {
  return {
    access_token: input.accessToken,
    refresh_token: input.refreshToken,
    expiry_date: input.expiryDate,
    client_id: input.clientId,
    granted_scopes: input.grantedScopes,
  };
}

function createOAuthClient(
  clientId: string,
  options: {
    redirectUri?: string;
    clientSecret: string;
  },
): OAuth2Client {
  const { redirectUri, clientSecret } = options;
  return new OAuth2Client({
    clientId,
    clientSecret,
    redirectUri,
    clientAuthentication: ClientAuthentication.ClientSecretPost,
  });
}

function renderOAuthResultPage(title: string, color: 'green' | 'red', details: string[]): string {
  const items = details.map(detail => `<li>${detail}</li>`).join('');
  return `<html><body style="font-family:sans-serif;padding:40px;line-height:1.5">
    <h2 style="color:${color}">${title}</h2>
    <ul>${items}</ul>
  </body></html>`;
}

async function fetchGrantedScopes(
  oauth2Client: OAuth2Client,
  fallbackScopes?: string[] | string | null,
): Promise<string[]> {
  const accessToken = oauth2Client.credentials.access_token;
  const fallback = normalizeScopes(fallbackScopes);

  if (!accessToken) return fallback;

  try {
    const tokenInfo = await oauth2Client.getTokenInfo(accessToken);
    return normalizeScopes(tokenInfo.scopes);
  } catch (err) {
    if (fallback.length > 0) return fallback;
    throw new Error(`Failed to verify granted OAuth scopes: ${(err as Error).message}`);
  }
}

async function assertRequiredScopes(
  oauth2Client: OAuth2Client,
  fallbackScopes?: string[] | string | null,
): Promise<string[]> {
  const grantedScopes = await fetchGrantedScopes(oauth2Client, fallbackScopes);
  const missingScopes = getMissingScopes(grantedScopes);

  if (missingScopes.length > 0) {
    throw new MissingScopesError(missingScopes, grantedScopes);
  }

  return grantedScopes;
}

async function refreshAccessTokenIfNeeded(oauth2Client: OAuth2Client): Promise<void> {
  const current = oauth2Client.credentials;
  const expiryDate = current.expiry_date ?? 0;
  const tokenMissing = !current.access_token;
  const tokenExpiring = !!expiryDate && expiryDate < Date.now() + TOKEN_EXPIRY_SKEW_MS;

  if (!tokenMissing && !tokenExpiring) return;
  if (!current.refresh_token) return;

  const { credentials } = await oauth2Client.refreshAccessToken();
  oauth2Client.setCredentials({
    ...current,
    ...credentials,
    refresh_token: current.refresh_token,
  });
}

function loadOAuthClientConfig(): OAuthClientConfig | null {
  const embedded = {
    client_id: decryptEmbeddedValue(EMBEDDED_CLIENT_ID),
    client_secret: decryptEmbeddedValue(EMBEDDED_CLIENT_SECRET),
  };

  return {
    client_id: process.env[OAUTH_CLIENT_ID_ENV]?.trim() || embedded.client_id,
    client_secret: process.env[OAUTH_CLIENT_SECRET_ENV]?.trim() || embedded.client_secret,
  };
}

async function runOAuthAttempt(
  artifactDir: string,
  clientId: string,
  clientSecret: string,
): Promise<OAuth2Client> {
  return new Promise((resolve, reject) => {
    // Start local callback server
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', async () => {
      const port = (server.address() as AddressInfo).port;
      const redirectUri = `http://127.0.0.1:${port}`;
      const oauth2Client = createOAuthClient(clientId, { redirectUri, clientSecret });
      const { codeVerifier: verifier, codeChallenge: challenge } = await oauth2Client.generateCodeVerifierAsync();
      const state = createOAuthState();
      if (!challenge) {
        throw new Error('Failed to generate PKCE code challenge.');
      }

      const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        include_granted_scopes: false,
        prompt: 'consent', // Force refresh token
        state,
        code_challenge_method: CodeChallengeMethod.S256,
        code_challenge: challenge,
      });

      console.log('\n🔐 Opening browser for Google authorization...');
      console.log(`If browser does not open, visit:\n${authUrl}\n`);

      await open(authUrl).catch(() => {
        console.log(`Please open this URL manually:\n${authUrl}`);
      });

      server.on('request', async (req, res) => {
        if (!req.url?.startsWith('/')) return;

        const url = new URL(req.url, `http://127.0.0.1:${port}`);
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');
        const errorDescription = url.searchParams.get('error_description');
        const errorSubtype = url.searchParams.get('error_subtype');
        const returnedState = url.searchParams.get('state');

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(renderOAuthResultPage('Authorization failed', 'red', [
            `Google returned: ${error}`,
            ...(errorDescription ? [`Description: ${errorDescription}`] : []),
            ...(errorSubtype ? [`Subtype: ${errorSubtype}`] : []),
            'Return to the terminal and start the authorization again.',
          ]));
          server.close();
          const details = [error, errorDescription, errorSubtype].filter(Boolean).join(' | ');
          reject(new Error(`OAuth error: ${details}`));
          return;
        }

        if (!returnedState || returnedState !== state) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(renderOAuthResultPage('Authorization failed', 'red', [
            'The OAuth state token did not match the original authorization request.',
            'Return to the terminal and start the authorization again.',
          ]));
          server.close();
          reject(new Error('Invalid OAuth state received'));
          return;
        }

        if (!code) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(renderOAuthResultPage('Authorization failed', 'red', [
            'No authorization code was received from Google.',
            'Return to the terminal and start the authorization again.',
          ]));
          server.close();
          reject(new Error('No authorization code received'));
          return;
        }

        try {
          const { tokens } = await oauth2Client.getToken({
            code,
            codeVerifier: verifier,
          });
          oauth2Client.setCredentials(tokens);

          const grantedScopes = await assertRequiredScopes(oauth2Client, tokens.scope);
          const refreshToken = tokens.refresh_token;
          const accessToken = tokens.access_token;
          const expiryDate = tokens.expiry_date;

          if (!refreshToken || !accessToken || !expiryDate) {
            throw new Error('OAuth token response is missing access_token, refresh_token, or expiry_date.');
          }

          // Save credentials for reuse only after scope validation succeeds.
          const stored = buildStoredCredentials({
            accessToken,
            refreshToken,
            expiryDate,
            clientId,
            grantedScopes,
          });
          saveCredentials(artifactDir, stored);

          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(renderOAuthResultPage('Authorization successful', 'green', [
            'All required GTM OAuth scopes were granted.',
            'You can close this tab and return to the terminal.',
          ]));
          server.close();

          console.log(`✅ Credentials saved to ${getCredentialsFile(artifactDir)}\n`);
          resolve(oauth2Client);
        } catch (err) {
          const responseData = (err as { response?: { data?: unknown } }).response?.data;
          if (
            responseData
            && typeof responseData === 'object'
            && 'error_description' in responseData
            && typeof responseData.error_description === 'string'
          ) {
            err = new Error(`OAuth token exchange failed: ${responseData.error_description}`);
          }
          if (err instanceof MissingScopesError) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(renderOAuthResultPage('Authorization incomplete', 'red', [
              'Not all required GTM permissions were granted.',
              `Missing scopes: ${formatScopes(err.missingScopes)}`,
              'Return to the terminal. The authorization flow will restart and you must allow every requested permission.',
            ]));
          } else {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(renderOAuthResultPage('Authorization failed', 'red', [
              (err as Error).message,
              'Return to the terminal and try again.',
            ]));
          }
          server.close();
          reject(err);
        }
      });
    });
  });
}

async function startOAuthFlow(
  artifactDir: string,
  clientId: string,
  clientSecret: string,
): Promise<OAuth2Client> {
  while (true) {
    try {
      return await runOAuthAttempt(artifactDir, clientId, clientSecret);
    } catch (err) {
      if (!(err instanceof MissingScopesError)) {
        throw err;
      }

      console.error('\n❌ Google authorization did not include all required GTM scopes.');
      console.error(`   Missing scopes: ${formatScopes(err.missingScopes)}`);
      console.error(`   Granted scopes: ${formatScopes(err.grantedScopes)}`);
      console.error('   Re-opening the Google consent screen. Approve every requested permission to continue.\n');
    }
  }
}

export async function getAuthClient(artifactDir: string): Promise<OAuth2Client> {
  const config = loadOAuthClientConfig();
  const credentialsFile = getCredentialsFile(artifactDir);
  const storedRecord = loadStoredCredentials(artifactDir);
  const stored = storedRecord?.credentials;

  if (!config) {
    throw new Error('Embedded OAuth client metadata could not be loaded.');
  }

  if (stored) {
    if (stored.client_id !== config.client_id) {
      console.log('Stored Google credentials belong to a different OAuth client. Re-authorizing...');
      clearCredentials({ artifactDir });
      return reAuthenticate(artifactDir, config);
    }

    const oauth2Client = createOAuthClient(config.client_id, {
      clientSecret: config.client_secret,
    });
    oauth2Client.setCredentials({
      access_token: stored.access_token,
      refresh_token: stored.refresh_token,
      expiry_date: stored.expiry_date,
    });

    try {
      await refreshAccessTokenIfNeeded(oauth2Client);
      const grantedScopes = await assertRequiredScopes(oauth2Client, stored.granted_scopes);

      const accessToken = oauth2Client.credentials.access_token;
      const expiryDate = oauth2Client.credentials.expiry_date;
      if (accessToken && expiryDate) {
        saveCredentials(artifactDir, buildStoredCredentials({
          accessToken,
          refreshToken: stored.refresh_token,
          expiryDate,
          clientId: stored.client_id,
          grantedScopes,
        }));
        if (storedRecord && storedRecord.sourceFile !== credentialsFile) {
          console.log(`✅ Stored credentials migrated to ${credentialsFile}`);
        }
      }

      return oauth2Client;
    } catch (err) {
      if (err instanceof MissingScopesError) {
        console.log('\nStored Google credentials are missing required GTM scopes. Re-authorizing...');
      } else {
        console.log('Stored credentials could not be reused, re-authorizing...');
      }
      clearCredentials({ artifactDir });
      return reAuthenticate(artifactDir, config);
    }
  }

  return reAuthenticate(artifactDir, config);
}

async function reAuthenticate(artifactDir: string, config: OAuthClientConfig): Promise<OAuth2Client> {
  return startOAuthFlow(artifactDir, config.client_id, config.client_secret);
}

export function clearCredentials(options: { artifactDir?: string; outputRoot?: string } = {}): void {
  const artifactDir = options.artifactDir?.trim();
  const outputRoot = options.outputRoot?.trim();
  const artifactFiles = artifactDir
    ? [getCredentialsFile(artifactDir)]
    : findArtifactCredentialFiles(outputRoot || DEFAULT_OUTPUT_ROOT);
  const files = [...artifactFiles, ...LEGACY_CREDENTIALS_FILES];
  const uniqueFiles = [...new Set(files)];
  let cleared = 0;

  for (const file of uniqueFiles) {
    if (!fs.existsSync(file)) continue;
    try {
      fs.unlinkSync(file);
      console.log(`✅ Credentials cleared: ${file}`);
      cleared += 1;
    } catch (err) {
      console.warn(`⚠️  Failed to clear credentials at ${file}: ${(err as Error).message}`);
    }
  }

  if (cleared === 0) {
    if (artifactDir) {
      console.log(`ℹ️ No stored credentials found for artifact directory ${path.resolve(artifactDir)}`);
      return;
    }
    console.log(`ℹ️ No stored credentials found under ${path.resolve(outputRoot || DEFAULT_OUTPUT_ROOT)}`);
  }
}
