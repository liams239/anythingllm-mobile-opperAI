/**
 * MCP tools as chat tools: names, results, approval and the enabled-server list.
 */
const mockStorage = new Map<string, any>();
jest.mock('@/store/UIStore', () => ({
    __esModule: true,
    default: {
        getFromStorage: async (key: string, fallback: any) => (mockStorage.has(key) ? mockStorage.get(key) : fallback),
        setToStorage: async (key: string, value: any) => { mockStorage.set(key, value); },
    },
}));
jest.mock('react-native-keychain', () => ({}));
jest.mock('@/i18n', () => ({ __esModule: true, default: { t: (key: string) => key } }));
jest.mock('@/utils/constants', () => ({ generateUUID: () => 'id-1' }));
jest.mock('@/utils/ToolsManager', () => ({}));
const mockApproval = jest.fn();
jest.mock('@/utils/ToolsManager/toolApproval', () => ({ __esModule: true, default: { request: (...args: any[]) => mockApproval(...args) } }));
const mockCall = jest.fn();
jest.mock('../servers', () => ({
    ...jest.requireActual('../servers'),
    callServerTool: (...args: any[]) => mockCall(...args),
}));

import { functionNameFor, mcpChatTools, needsApproval, resultToText } from '../tools';

const homey = {
    id: 'h1', name: 'Homey', url: 'https://mcp.athom.com', auth: 'oauth', enabled: true, disabledTools: ['delete_flow'],
    tools: [
        { name: 'list_devices', description: 'List devices', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: {} } },
        { name: 'set_capability', description: 'Turn things on or off', inputSchema: { type: 'object', properties: { device: { type: 'string' } }, required: ['device'] } },
        { name: 'delete_flow', description: 'Delete a flow' },
    ],
};

beforeEach(() => { mockStorage.clear(); mockApproval.mockReset(); mockCall.mockReset(); });

test('function names are valid, prefixed by server and unique when trimmed', () => {
    expect(functionNameFor('Homey Pro', 'set.light')).toBe('homey_pro__set_light');
    const long = functionNameFor('server', 'x'.repeat(80));
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long).toMatch(/^[a-z0-9_-]+$/);
    expect(functionNameFor('server', 'x'.repeat(80) + 'a')).not.toBe(long);
});

test('results become text for the model', () => {
    expect(resultToText({ content: [{ type: 'text', text: 'Lamp is on' }] })).toBe('Lamp is on');
    expect(resultToText({ content: [], structuredContent: { on: true } })).toBe('{"on":true}');
    expect(resultToText({ content: [{ type: 'text', text: 'Not found' }], isError: true })).toBe('The tool reported an error: Not found');
    expect(resultToText({ content: [{ type: 'image', data: 'x', mimeType: 'image/png' }] })).toBe('[image image/png returned]');
});

test('only read-only tools skip approval', () => {
    expect(needsApproval(homey.tools[0] as any)).toBe(false);
    expect(needsApproval(homey.tools[1] as any)).toBe(true);
});

test('enabled servers give chat tools, minus switched-off ones', async () => {
    mockStorage.set('mcp_servers', [homey, { ...homey, id: 'h2', name: 'Off', enabled: false }]);
    const tools = await mcpChatTools();
    expect(tools.map((t) => t.definition.function.name)).toEqual(['homey__list_devices', 'homey__set_capability']);
    expect(tools[1].definition.function.parameters.required).toEqual(['device']);
    expect(tools[1].hiddenFromScheduledJobs).toBe(true);
});

test('a tool that changes things asks first and does not run when declined', async () => {
    mockStorage.set('mcp_servers', [homey]);
    const [, setCapability] = await mcpChatTools();
    mockApproval.mockResolvedValueOnce({ approved: false, message: 'User denied' });
    expect(await setCapability.execute('{"device":"lamp"}', jest.fn())).toBe('User denied');
    expect(mockCall).not.toHaveBeenCalled();

    mockApproval.mockResolvedValueOnce({ approved: true, message: 'ok' });
    mockCall.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Lamp on' }] });
    expect(await setCapability.execute({ device: 'lamp' }, jest.fn())).toBe('Lamp on');
    expect(mockCall.mock.calls[0][1]).toBe('set_capability');
    expect(mockCall.mock.calls[0][2]).toEqual({ device: 'lamp' });
});

test('read-only tools run without asking', async () => {
    mockStorage.set('mcp_servers', [homey]);
    const [listDevices] = await mcpChatTools();
    mockCall.mockResolvedValueOnce({ content: [{ type: 'text', text: '3 devices' }] });
    expect(await listDevices.execute('{}', jest.fn())).toBe('3 devices');
    expect(mockApproval).not.toHaveBeenCalled();
});
