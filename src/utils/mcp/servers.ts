import * as Keychain from 'react-native-keychain';
import uiStore from '@/store/UIStore';
import { generateUUID } from '@/utils/constants';
import { McpAuthRequiredError, McpClient, type McpTool } from './client';
import { refresh, signIn, type McpOAuthClient, type McpTokens } from './oauth';

/**
 * The user's remote MCP servers. Settings (name, URL, which tools are on, the last tool list) live in
 * app storage under `mcp_servers`; secrets (API key, OAuth registration and tokens) in the keychain,
 * one entry per server, readable after first unlock so scheduled jobs can use them too.
 */

export type McpAuthKind = 'oauth' | 'header' | 'none';

export type McpServer = {
    id: string;
    name: string;
    url: string;
    auth: McpAuthKind;
    /** For `header` auth eg "Authorization" (the value is in the keychain) */
    headerName?: string;
    enabled: boolean;
    /** Tool names switched off by the user */
    disabledTools: string[];
    /** Last tool list fetched, so tools are offered without a network round trip */
    tools: McpTool[];
    toolsFetchedAt?: number;
    /** Last connection problem, shown on the settings page */
    lastError?: string | null;
};

type McpSecrets = {
    headerValue?: string;
    oauthClient?: McpOAuthClient;
    tokens?: McpTokens;
};

const KEYCHAIN_PREFIX = 'com.anythingllm.mcp.';
/** Refresh this long before the access token expires */
const REFRESH_SKEW_MS = 60_000;

function log(text: string, ...args: any[]) {
    console.log(`\x1b[35m[MCP] ${text}\x1b[0m`, ...args);
}

export async function listServers(): Promise<McpServer[]> {
    const stored = await uiStore.getFromStorage('mcp_servers', [] as McpServer[]);
    return Array.isArray(stored) ? stored : [];
}

async function saveServers(servers: McpServer[]): Promise<void> {
    await uiStore.setToStorage('mcp_servers', servers);
    // Tools come from servers, so the cached tool list must be rebuilt
    const { default: ToolsManager } = await import('@/utils/ToolsManager');
    ToolsManager.resetTools();
}

export async function updateServer(id: string, changes: Partial<McpServer>): Promise<McpServer | null> {
    const servers = await listServers();
    const index = servers.findIndex((server) => server.id === id);
    if (index < 0) return null;
    servers[index] = { ...servers[index], ...changes };
    await saveServers(servers);
    return servers[index];
}

async function readSecrets(id: string): Promise<McpSecrets> {
    try {
        const stored = await Keychain.getGenericPassword({ service: KEYCHAIN_PREFIX + id });
        return stored ? JSON.parse(stored.password) : {};
    } catch (error) {
        log('Could not read secrets', error);
        return {};
    }
}

async function writeSecrets(id: string, secrets: McpSecrets): Promise<void> {
    await Keychain.setGenericPassword('mcp', JSON.stringify(secrets), {
        service: KEYCHAIN_PREFIX + id,
        accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    });
}

export async function addServer(input: { name: string; url: string; auth: McpAuthKind; headerName?: string; headerValue?: string }): Promise<McpServer> {
    const server: McpServer = {
        id: generateUUID(),
        name: input.name.trim() || new URL(input.url).hostname,
        url: input.url.trim(),
        auth: input.auth,
        headerName: input.auth === 'header' ? (input.headerName?.trim() || 'Authorization') : undefined,
        enabled: true,
        disabledTools: [],
        tools: [],
    };
    if (input.auth === 'header' && input.headerValue) await writeSecrets(server.id, { headerValue: input.headerValue.trim() });
    await saveServers([...(await listServers()), server]);
    return server;
}

export async function removeServer(id: string): Promise<void> {
    await Keychain.resetGenericPassword({ service: KEYCHAIN_PREFIX + id }).catch(() => false);
    await saveServers((await listServers()).filter((server) => server.id !== id));
}

/** Forget the sign-in (keeps the app registration so signing in again is quick) */
export async function signOut(id: string): Promise<void> {
    const secrets = await readSecrets(id);
    await writeSecrets(id, { ...secrets, tokens: undefined });
    await updateServer(id, { lastError: null });
}

export async function isSignedIn(server: McpServer): Promise<boolean> {
    if (server.auth !== 'oauth') return true;
    return !!(await readSecrets(server.id)).tokens?.accessToken;
}

/** Headers for one request, refreshing an OAuth token that is about to expire */
async function authHeaders(server: McpServer): Promise<Record<string, string>> {
    if (server.auth === 'none') return {};
    const secrets = await readSecrets(server.id);
    if (server.auth === 'header') {
        return secrets.headerValue ? { [server.headerName || 'Authorization']: secrets.headerValue } : {};
    }
    let tokens = secrets.tokens;
    if (!tokens?.accessToken) throw new McpAuthRequiredError(null);
    if (tokens.expiresAt && tokens.expiresAt - REFRESH_SKEW_MS < Date.now() && tokens.refreshToken && secrets.oauthClient) {
        try {
            tokens = await refresh(secrets.oauthClient, tokens.refreshToken);
            await writeSecrets(server.id, { ...secrets, tokens });
        } catch (error) {
            log('Token refresh failed', error);
            throw new McpAuthRequiredError(null);
        }
    }
    return { Authorization: `Bearer ${tokens.accessToken}` };
}

function clientFor(server: McpServer, signal?: AbortSignal | null): McpClient {
    return new McpClient({ url: server.url, headers: () => authHeaders(server), signal });
}

/** Browser sign-in for an OAuth server; reuses the earlier app registration when there is one */
export async function signInToServer(id: string): Promise<void> {
    const server = (await listServers()).find((s) => s.id === id);
    if (!server) throw new Error('Server not found');
    const secrets = await readSecrets(id);
    // Ask the server once without a token, so its WWW-Authenticate header can point at the sign-in server
    let hint: string | null = null;
    try {
        await new McpClient({ url: server.url }).initialize();
    } catch (error) {
        if (error instanceof McpAuthRequiredError) hint = error.wwwAuthenticate;
    }
    const { client, tokens } = await signIn(server.url, hint, secrets.oauthClient);
    await writeSecrets(id, { ...secrets, oauthClient: client, tokens });
    await updateServer(id, { lastError: null });
}

/**
 * Connect and fetch the server's tools, saving them for the chat. Throws McpAuthRequiredError when
 * the server needs a (new) sign-in.
 */
export async function refreshTools(id: string): Promise<McpServer> {
    const server = (await listServers()).find((s) => s.id === id);
    if (!server) throw new Error('Server not found');
    try {
        const tools = await clientFor(server).listTools();
        return (await updateServer(id, { tools, toolsFetchedAt: Date.now(), lastError: null })) ?? server;
    } catch (error: any) {
        await updateServer(id, { lastError: error instanceof McpAuthRequiredError ? 'auth' : (error?.message || 'error') });
        throw error;
    }
}

/** Run one tool on a server */
export async function callServerTool(server: McpServer, name: string, args: Record<string, any>, signal?: AbortSignal | null) {
    return clientFor(server, signal).callTool(name, args);
}
