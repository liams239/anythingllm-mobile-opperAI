/**
 * MCP Streamable HTTP client against a mocked server: JSON and SSE answers, sessions, sign-in.
 */
import { findResponse, McpAuthRequiredError, McpClient, parseSseMessages } from '../client';

const fetchMock = jest.fn();
global.fetch = fetchMock as any;

function reply(body: any, { status = 200, type = 'application/json', headers = {} as Record<string, string> } = {}) {
    const all: Record<string, string> = { 'content-type': type, ...headers };
    return {
        ok: status < 400,
        status,
        headers: { get: (name: string) => all[name.toLowerCase()] ?? null },
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
}
const sse = (...messages: any[]) => messages.map((m) => `event: message\ndata: ${JSON.stringify(m)}\n\n`).join('');
const sent = () => fetchMock.mock.calls.map(([, init]) => ({ body: JSON.parse(init.body), headers: init.headers }));

beforeEach(() => fetchMock.mockReset());

test('parses SSE bodies and finds the answer by id', () => {
    const body = `: ping\n\n${sse({ jsonrpc: '2.0', method: 'notifications/progress' }, { jsonrpc: '2.0', id: 2, result: { ok: true } })}`;
    expect(parseSseMessages(body)).toHaveLength(2);
    expect(findResponse(body, 'text/event-stream', 2)).toEqual({ jsonrpc: '2.0', id: 2, result: { ok: true } });
    expect(findResponse(JSON.stringify([{ jsonrpc: '2.0', id: 5, result: 1 }]), 'application/json', 5).result).toBe(1);
});

test('initializes once, keeps the session id, and pages through tools', async () => {
    fetchMock
        .mockResolvedValueOnce(reply({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'Homey' } } }, { headers: { 'mcp-session-id': 'abc' } }))
        .mockResolvedValueOnce(reply('', { status: 202 }))
        .mockResolvedValueOnce(reply(sse({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'list_devices' }], nextCursor: 'p2' } }), { type: 'text/event-stream' }))
        .mockResolvedValueOnce(reply({ jsonrpc: '2.0', id: 3, result: { tools: [{ name: 'set_light' }] } }));

    const client = new McpClient({ url: 'https://mcp.example.com', headers: async () => ({ Authorization: 'Bearer t' }) });
    const tools = await client.listTools();

    expect(tools.map((t) => t.name)).toEqual(['list_devices', 'set_light']);
    const calls = sent();
    expect(calls[0].body.method).toBe('initialize');
    expect(calls[1].body).toEqual({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(calls[2].body.method).toBe('tools/list');
    expect(calls[3].body.params).toEqual({ cursor: 'p2' });
    expect(calls[2].headers['Mcp-Session-Id']).toBe('abc');
    expect(calls[2].headers['MCP-Protocol-Version']).toBe('2025-06-18');
    expect(calls[2].headers.Authorization).toBe('Bearer t');
});

test('a 401 becomes a sign-in request carrying the WWW-Authenticate hint', async () => {
    fetchMock.mockResolvedValue(reply('', { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"' } }));
    const error = await new McpClient({ url: 'https://mcp.example.com' }).initialize().catch((e) => e);
    expect(error).toBeInstanceOf(McpAuthRequiredError);
    expect(error.wwwAuthenticate).toContain('resource_metadata=');
});

test('starts a new session when the server dropped the old one', async () => {
    fetchMock
        .mockResolvedValueOnce(reply({ jsonrpc: '2.0', id: 1, result: {} }, { headers: { 'mcp-session-id': 'old' } }))
        .mockResolvedValueOnce(reply('', { status: 202 }))
        .mockResolvedValueOnce(reply('', { status: 404 }))
        .mockResolvedValueOnce(reply({ jsonrpc: '2.0', id: 3, result: {} }, { headers: { 'mcp-session-id': 'new' } }))
        .mockResolvedValueOnce(reply('', { status: 202 }))
        .mockResolvedValueOnce(reply({ jsonrpc: '2.0', id: 4, result: { content: [{ type: 'text', text: 'on' }] } }));

    const result = await new McpClient({ url: 'https://mcp.example.com' }).callTool('set_light', { on: true });

    expect(result.content?.[0]).toEqual({ type: 'text', text: 'on' });
    expect(sent()[5].headers['Mcp-Session-Id']).toBe('new');
});

test('JSON-RPC errors are thrown with their message', async () => {
    fetchMock
        .mockResolvedValueOnce(reply({ jsonrpc: '2.0', id: 1, result: {} }))
        .mockResolvedValueOnce(reply('', { status: 202 }))
        .mockResolvedValueOnce(reply({ jsonrpc: '2.0', id: 2, error: { code: -32602, message: 'Unknown tool' } }));
    await expect(new McpClient({ url: 'https://x.test' }).callTool('nope', {})).rejects.toThrow('Unknown tool');
});
