import { NativeModules } from 'react-native';
import { Buffer } from 'buffer';

/**
 * OAuth for remote MCP servers, per the MCP authorization spec (2025-06-18):
 *  1. find the authorization server through the server's protected resource metadata (RFC 9728)
 *  2. read its metadata (RFC 8414 / OpenID discovery)
 *  3. register this app with dynamic client registration (RFC 7591)
 *  4. sign in with authorization code + PKCE in a browser tab, redirecting to a loopback address
 *  5. exchange the code, and later refresh, always naming the MCP server as `resource` (RFC 8707)
 * The browser part reuses `LoopbackAuthModule` (also behind Sign in with ChatGPT).
 */

const { LoopbackAuthModule } = NativeModules;

/** Fixed so the redirect URI registered with the server never changes between sign-ins */
export const MCP_REDIRECT_PORT = 33418;
const CALLBACK_PATH = '/mcp/callback';
export const MCP_REDIRECT_URI = `http://127.0.0.1:${MCP_REDIRECT_PORT}${CALLBACK_PATH}`;
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
const CLIENT_NAME = 'AnythingLLM Mobile';

export type McpOAuthClient = {
    clientId: string;
    clientSecret?: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    /** The MCP server URL the tokens are for */
    resource: string;
    scope?: string;
};

export type McpTokens = {
    accessToken: string;
    refreshToken?: string;
    /** Epoch millis, when the server says */
    expiresAt?: number;
};

export class McpOAuthError extends Error {
    constructor(public code: 'cancelled' | 'timeout' | 'no_browser' | 'unavailable' | 'denied' | 'discovery' | 'registration' | 'token' | 'port_in_use', message: string) {
        super(message);
        this.name = 'McpOAuthError';
    }
}

function base64Url(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/[=]+$/, '');
}

function randomToken(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return base64Url(bytes);
}

function formBody(params: Record<string, string | undefined>): string {
    return Object.entries(params)
        .filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== '')
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join('&');
}

function parseQuery(url: string): Record<string, string> {
    const query = url.split('?')[1]?.split('#')[0] ?? '';
    const params: Record<string, string> = {};
    for (const pair of query.split('&')) {
        if (!pair) continue;
        const [key, value = ''] = pair.split('=');
        params[decodeURIComponent(key)] = decodeURIComponent(value.replace(/\+/g, ' '));
    }
    return params;
}

/** The server URL without fragment and trailing slash - the `resource` tokens are bound to */
export function canonicalResource(url: string): string {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
}

/** `resource_metadata="https://..."` from a WWW-Authenticate header */
export function resourceMetadataFromHeader(header: string | null | undefined): string | null {
    const match = /resource_metadata\s*=\s*"([^"]+)"/i.exec(header ?? '');
    return match?.[1] ?? null;
}

/** Well-known URLs to try, path-aware first (RFC 8414 section 3.1 / RFC 9728 section 3.1) */
export function wellKnownUrls(base: string, suffix: string): string[] {
    const parsed = new URL(base);
    const path = parsed.pathname.replace(/\/$/, '');
    const urls = path && path !== '/' ? [`${parsed.origin}/.well-known/${suffix}${path}`] : [];
    urls.push(`${parsed.origin}/.well-known/${suffix}`);
    return urls;
}

async function getJson(url: string): Promise<any | null> {
    try {
        const response = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!response.ok) return null;
        return await response.json();
    } catch {
        return null;
    }
}

type AuthServerMetadata = {
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint?: string;
    scopes_supported?: string[];
    code_challenge_methods_supported?: string[];
};

/** Find where to sign in for an MCP server */
export async function discover(serverUrl: string, wwwAuthenticate: string | null): Promise<{ metadata: AuthServerMetadata; scope?: string }> {
    const hinted = resourceMetadataFromHeader(wwwAuthenticate);
    let resourceMeta: any = hinted ? await getJson(hinted) : null;
    if (!resourceMeta) {
        for (const url of wellKnownUrls(serverUrl, 'oauth-protected-resource')) {
            resourceMeta = await getJson(url);
            if (resourceMeta) break;
        }
    }
    // Older servers (spec 2025-03-26) have no resource metadata: the server's origin is the issuer
    const issuer: string = resourceMeta?.authorization_servers?.[0] ?? new URL(serverUrl).origin;

    let metadata: AuthServerMetadata | null = null;
    for (const url of [...wellKnownUrls(issuer, 'oauth-authorization-server'), ...wellKnownUrls(issuer, 'openid-configuration')]) {
        const found = await getJson(url);
        if (found?.authorization_endpoint && found?.token_endpoint) {
            metadata = found;
            break;
        }
    }
    if (!metadata) {
        // Last resort from the 2025-03-26 spec: default paths on the issuer
        const origin = new URL(issuer).origin;
        metadata = { authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register` };
    }
    const scopes: string[] | undefined = resourceMeta?.scopes_supported ?? undefined;
    return { metadata, scope: scopes?.length ? scopes.join(' ') : undefined };
}

async function register(metadata: AuthServerMetadata): Promise<{ clientId: string; clientSecret?: string }> {
    if (!metadata.registration_endpoint) {
        throw new McpOAuthError('registration', 'This server does not let apps register themselves, so it cannot be connected yet.');
    }
    let response: Response;
    try {
        response = await fetch(metadata.registration_endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
                client_name: CLIENT_NAME,
                redirect_uris: [MCP_REDIRECT_URI],
                grant_types: ['authorization_code', 'refresh_token'],
                response_types: ['code'],
                token_endpoint_auth_method: 'none',
            }),
        });
    } catch (error: any) {
        throw new McpOAuthError('registration', error?.message || 'Could not reach the server to register.');
    }
    const data: any = await response.json().catch(() => null);
    if (!response.ok || !data?.client_id) {
        throw new McpOAuthError('registration', data?.error_description || data?.error || `Registration failed (${response.status}).`);
    }
    return { clientId: data.client_id, clientSecret: data.client_secret || undefined };
}

async function postToken(client: McpOAuthClient, params: Record<string, string | undefined>): Promise<McpTokens> {
    let response: Response;
    try {
        response = await fetch(client.tokenEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body: formBody({ ...params, client_id: client.clientId, client_secret: client.clientSecret, resource: client.resource }),
        });
    } catch (error: any) {
        throw new McpOAuthError('token', error?.message || 'Could not reach the sign in server.');
    }
    const data: any = await response.json().catch(() => null);
    if (!response.ok || !data?.access_token) {
        throw new McpOAuthError('token', data?.error_description || data?.error || `Sign in failed (${response.status}).`);
    }
    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || params.refresh_token,
        expiresAt: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : undefined,
    };
}

/**
 * Full browser sign-in. Reuses an earlier registration when there is one, so signing in again does
 * not register the app twice.
 */
export async function signIn(serverUrl: string, wwwAuthenticate: string | null, existing?: McpOAuthClient | null): Promise<{ client: McpOAuthClient; tokens: McpTokens }> {
    if (!LoopbackAuthModule?.authorizeOnPort) throw new McpOAuthError('unavailable', 'Signing in is not available in this version of the app.');
    const resource = canonicalResource(serverUrl);
    let client = existing && existing.resource === resource ? existing : null;
    if (!client) {
        const { metadata, scope } = await discover(serverUrl, wwwAuthenticate);
        const registration = await register(metadata);
        client = {
            ...registration,
            authorizationEndpoint: metadata.authorization_endpoint,
            tokenEndpoint: metadata.token_endpoint,
            resource,
            scope,
        };
    }

    const verifier = randomToken();
    const state = randomToken();
    const challenge: string = await LoopbackAuthModule.sha256Base64Url(verifier);
    const separator = client.authorizationEndpoint.includes('?') ? '&' : '?';
    const authorizeUrl = `${client.authorizationEndpoint}${separator}${formBody({
        response_type: 'code',
        client_id: client.clientId,
        redirect_uri: MCP_REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        resource,
        scope: client.scope,
    })}`;

    let callbackUrl: string;
    try {
        callbackUrl = await LoopbackAuthModule.authorizeOnPort(authorizeUrl, CALLBACK_PATH, MCP_REDIRECT_PORT, SIGN_IN_TIMEOUT_MS);
    } catch (error: any) {
        const code = error?.code;
        if (code === 'cancelled' || code === 'timeout' || code === 'no_browser') throw new McpOAuthError(code, error?.message ?? code);
        if (code === 'listen_failed') throw new McpOAuthError('port_in_use', 'Another sign in is still open. Close it and try again.');
        throw new McpOAuthError('unavailable', error?.message || 'Could not open the sign in page.');
    }

    const callback = parseQuery(callbackUrl);
    if (callback.state !== state) throw new McpOAuthError('token', 'The sign in response did not match this request.');
    if (callback.error) {
        throw new McpOAuthError(callback.error === 'access_denied' ? 'denied' : 'token', callback.error_description || callback.error);
    }
    if (!callback.code) throw new McpOAuthError('token', 'The server did not return a sign in code.');

    const tokens = await postToken(client, {
        grant_type: 'authorization_code',
        code: callback.code,
        redirect_uri: MCP_REDIRECT_URI,
        code_verifier: verifier,
    });
    return { client, tokens };
}

export function refresh(client: McpOAuthClient, refreshToken: string): Promise<McpTokens> {
    return postToken(client, { grant_type: 'refresh_token', refresh_token: refreshToken });
}
