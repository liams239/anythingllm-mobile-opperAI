/**
 * Minimal MCP client over the Streamable HTTP transport (spec 2025-06-18): JSON-RPC requests are
 * POSTed to the server URL and answered as JSON or as a short SSE stream. Remote servers only - a
 * phone cannot start local (stdio) servers.
 */

export const MCP_PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'AnythingLLM Mobile', version: '1.0' };
const REQUEST_TIMEOUT_MS = 60_000;

export type McpTool = {
    name: string;
    title?: string;
    description?: string;
    inputSchema?: { type?: string; properties?: Record<string, any>; required?: string[] };
    annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
};

export type McpContent =
    | { type: 'text'; text: string }
    | { type: 'image' | 'audio'; data: string; mimeType: string }
    | { type: 'resource'; resource: { uri: string; text?: string; mimeType?: string } }
    | { type: 'resource_link'; uri: string; name?: string }
    | { type: string; [key: string]: any };

export type McpToolResult = {
    content?: McpContent[];
    structuredContent?: unknown;
    isError?: boolean;
};

/** The server wants a (new) sign-in. `wwwAuthenticate` carries the resource metadata hint, if any. */
export class McpAuthRequiredError extends Error {
    constructor(public wwwAuthenticate: string | null) {
        super('This MCP server needs you to sign in.');
        this.name = 'McpAuthRequiredError';
    }
}

export class McpError extends Error {
    constructor(message: string, public status?: number) {
        super(message);
        this.name = 'McpError';
    }
}

/** Pull the JSON-RPC messages out of an SSE body (`data:` lines, events split by a blank line) */
export function parseSseMessages(body: string): any[] {
    const messages: any[] = [];
    for (const block of body.split(/\r?\n\r?\n/)) {
        const data = block
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).replace(/^ /, ''))
            .join('\n');
        if (!data.trim()) continue;
        try {
            messages.push(JSON.parse(data));
        } catch {
            // Not JSON (eg: a keep-alive) - skip
        }
    }
    return messages;
}

/** Find the answer to request `id` in a JSON or SSE body */
export function findResponse(body: string, contentType: string, id: number): any {
    const messages = contentType.includes('text/event-stream')
        ? parseSseMessages(body)
        : (() => {
            const parsed = JSON.parse(body);
            return Array.isArray(parsed) ? parsed : [parsed];
        })();
    return messages.find((message) => message && message.id === id && ('result' in message || 'error' in message));
}

export type McpClientOptions = {
    url: string;
    /** Extra headers for every request, eg: `{ Authorization: 'Bearer ...' }` - looked up per request so refreshed tokens apply */
    headers?: () => Promise<Record<string, string>>;
    signal?: AbortSignal | null;
};

export class McpClient {
    private nextId = 1;
    private sessionId: string | null = null;
    private initialized = false;

    constructor(private options: McpClientOptions) {}

    private async post(payload: Record<string, any>, expectResponse: boolean): Promise<any> {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        const onAbort = () => controller.abort();
        this.options.signal?.addEventListener('abort', onAbort);
        try {
            const response = await fetch(this.options.url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream',
                    ...(this.initialized ? { 'MCP-Protocol-Version': MCP_PROTOCOL_VERSION } : {}),
                    ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
                    ...(await this.options.headers?.() ?? {}),
                },
                body: JSON.stringify(payload),
                signal: controller.signal,
            });
            const sessionId = response.headers.get('mcp-session-id');
            if (sessionId) this.sessionId = sessionId;
            const authHeader = response.headers.get('www-authenticate');
            if (response.status === 401 || (response.status === 403 && /invalid_token|insufficient_scope/.test(authHeader ?? ''))) {
                throw new McpAuthRequiredError(authHeader);
            }
            if (!expectResponse) return null;
            const body = await response.text();
            if (!response.ok) {
                // The server dropped our session - the caller starts a new one
                if (response.status === 404 && this.sessionId) throw new McpError('session_expired', 404);
                throw new McpError(`MCP server error ${response.status}${body ? `: ${body.slice(0, 300)}` : ''}`, response.status);
            }
            const message = findResponse(body, response.headers.get('content-type') ?? '', payload.id);
            if (!message) throw new McpError('The MCP server sent no answer.');
            if (message.error) throw new McpError(message.error.message || `MCP error ${message.error.code}`);
            return message.result;
        } finally {
            clearTimeout(timeout);
            this.options.signal?.removeEventListener('abort', onAbort);
        }
    }

    private async request(method: string, params?: Record<string, any>): Promise<any> {
        return this.post({ jsonrpc: '2.0', id: this.nextId++, method, ...(params ? { params } : {}) }, true);
    }

    async initialize(): Promise<{ serverInfo?: { name?: string; version?: string }; instructions?: string }> {
        this.sessionId = null;
        this.initialized = false;
        const result = await this.request('initialize', {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: CLIENT_INFO,
        });
        this.initialized = true;
        await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, false).catch(() => null);
        return result ?? {};
    }

    /** Run a request, starting (or restarting an expired) session first */
    private async call<T>(method: string, params?: Record<string, any>): Promise<T> {
        if (!this.initialized) await this.initialize();
        try {
            return await this.request(method, params);
        } catch (error) {
            if (error instanceof McpError && error.message === 'session_expired') {
                await this.initialize();
                return this.request(method, params);
            }
            throw error;
        }
    }

    /** Every tool, following `nextCursor` pages */
    async listTools(): Promise<McpTool[]> {
        const tools: McpTool[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 20; page++) {
            const result: any = await this.call('tools/list', cursor ? { cursor } : undefined);
            for (const tool of result?.tools ?? []) if (tool?.name) tools.push(tool);
            cursor = result?.nextCursor;
            if (!cursor) break;
        }
        return tools;
    }

    callTool(name: string, args: Record<string, any>): Promise<McpToolResult> {
        return this.call('tools/call', { name, arguments: args });
    }
}
