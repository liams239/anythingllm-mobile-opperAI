/**
 * MCP OAuth: discovery, dynamic client registration and the PKCE code exchange.
 */
const mockAuthorize = jest.fn();
jest.mock('react-native', () => ({
    NativeModules: {
        LoopbackAuthModule: {
            sha256Base64Url: (input: string) => Promise.resolve(require('crypto').createHash('sha256').update(input).digest('base64url')),
            authorizeOnPort: (...args: any[]) => mockAuthorize(...args),
        },
    },
}));

import { createHash } from 'crypto';
import { canonicalResource, discover, MCP_REDIRECT_URI, refresh, resourceMetadataFromHeader, signIn, wellKnownUrls } from '../oauth';

const fetchMock = jest.fn();
global.fetch = fetchMock as any;
const json = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body });

const SERVER = 'https://mcp.athom.com/';
const AS = 'https://auth.athom.com';
function routes(table: Record<string, any>) {
    fetchMock.mockImplementation(async (url: string) => (url in table ? (typeof table[url] === 'function' ? table[url]() : json(table[url])) : json({}, 404)));
}

beforeEach(() => { fetchMock.mockReset(); mockAuthorize.mockReset(); });

test('helpers', () => {
    expect(canonicalResource('https://mcp.athom.com/')).toBe('https://mcp.athom.com');
    expect(resourceMetadataFromHeader('Bearer realm="x", resource_metadata="https://a.b/meta"')).toBe('https://a.b/meta');
    expect(wellKnownUrls('https://a.b/tenant/1', 'oauth-authorization-server')).toEqual([
        'https://a.b/.well-known/oauth-authorization-server/tenant/1',
        'https://a.b/.well-known/oauth-authorization-server',
    ]);
});

test('discovers the authorization server through resource metadata', async () => {
    routes({
        'https://mcp.athom.com/.well-known/oauth-protected-resource': { authorization_servers: [AS], scopes_supported: ['homey'] },
        [`${AS}/.well-known/oauth-authorization-server`]: { authorization_endpoint: `${AS}/authorize`, token_endpoint: `${AS}/token`, registration_endpoint: `${AS}/register` },
    });
    const { metadata, scope } = await discover(SERVER, null);
    expect(metadata.token_endpoint).toBe(`${AS}/token`);
    expect(scope).toBe('homey');
});

test('falls back to default endpoints on the server origin', async () => {
    routes({});
    const { metadata } = await discover(SERVER, null);
    expect(metadata).toEqual({ authorization_endpoint: 'https://mcp.athom.com/authorize', token_endpoint: 'https://mcp.athom.com/token', registration_endpoint: 'https://mcp.athom.com/register' });
});

test('registers, signs in with PKCE and exchanges the code for the right resource', async () => {
    routes({
        [`${AS}/.well-known/oauth-protected-resource`]: null,
        'https://mcp.athom.com/.well-known/oauth-protected-resource': { authorization_servers: [AS] },
        [`${AS}/.well-known/oauth-authorization-server`]: { authorization_endpoint: `${AS}/authorize`, token_endpoint: `${AS}/token`, registration_endpoint: `${AS}/register` },
        [`${AS}/register`]: { client_id: 'client-1' },
        [`${AS}/token`]: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 },
    });
    mockAuthorize.mockImplementation(async (url: string) => {
        const state = new URL(url).searchParams.get('state');
        return `http://127.0.0.1:33418/mcp/callback?code=the-code&state=${state}`;
    });

    const { client, tokens } = await signIn(SERVER, null, null);

    const registration = JSON.parse(fetchMock.mock.calls.find(([url]) => url === `${AS}/register`)[1].body);
    expect(registration.redirect_uris).toEqual([MCP_REDIRECT_URI]);
    expect(registration.token_endpoint_auth_method).toBe('none');

    const [authorizeUrl, path, port] = mockAuthorize.mock.calls[0];
    const params = new URL(authorizeUrl).searchParams;
    expect(path).toBe('/mcp/callback');
    expect(port).toBe(33418);
    expect(params.get('client_id')).toBe('client-1');
    expect(params.get('resource')).toBe('https://mcp.athom.com');
    expect(params.get('code_challenge_method')).toBe('S256');

    const tokenBody = new URLSearchParams(fetchMock.mock.calls.find(([url]) => url === `${AS}/token`)[1].body);
    expect(tokenBody.get('grant_type')).toBe('authorization_code');
    expect(tokenBody.get('resource')).toBe('https://mcp.athom.com');
    const verifier = tokenBody.get('code_verifier')!;
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(params.get('code_challenge'));

    expect(client.clientId).toBe('client-1');
    expect(tokens.accessToken).toBe('at');
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
});

test('rejects a callback for another sign in, and reports a refusal', async () => {
    const client = { clientId: 'c', authorizationEndpoint: `${AS}/authorize`, tokenEndpoint: `${AS}/token`, resource: 'https://mcp.athom.com' };
    mockAuthorize.mockResolvedValueOnce('http://127.0.0.1:33418/mcp/callback?code=x&state=other');
    await expect(signIn(SERVER, null, client)).rejects.toThrow('did not match');
    mockAuthorize.mockImplementationOnce(async (url: string) => `http://127.0.0.1:33418/mcp/callback?error=access_denied&state=${new URL(url).searchParams.get('state')}`);
    await expect(signIn(SERVER, null, client)).rejects.toMatchObject({ code: 'denied' });
});

test('refresh keeps the old refresh token when the server does not rotate it', async () => {
    routes({ [`${AS}/token`]: { access_token: 'new', expires_in: 60 } });
    const tokens = await refresh({ clientId: 'c', authorizationEndpoint: '', tokenEndpoint: `${AS}/token`, resource: 'https://mcp.athom.com' }, 'rt');
    expect(tokens).toMatchObject({ accessToken: 'new', refreshToken: 'rt' });
});
