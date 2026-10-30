/**
 * Tool narrowing: tools flagged alwaysOffer are never ranked away, and prompts with images are
 * ranked on their text.
 */
jest.mock('@/store/UIStore', () => ({ __esModule: true, default: { getFromStorage: jest.fn() } }));
jest.mock('@/utils/Telemetry', () => ({ __esModule: true, default: { logEvent: jest.fn(), CUSTOM_EVENTS: { ACTIONS: {} } } }));
jest.mock('@/i18n', () => ({ __esModule: true, default: { t: (key: string) => key } }));
jest.mock('../tools', () => ({ __esModule: true, default: { default: {}, createFiles: {}, appConnections: {}, calendar: {} } }));
const mockRerank = jest.fn();
jest.mock('../toolReranker', () => ({
    __esModule: true,
    default: class {
        static ON_DEVICE_THRESHOLD = 4;
        static CLOUD_THRESHOLD = 10;
        rerank(args: any) { return mockRerank(args); }
    },
}));
jest.mock('../../chat/contextCompaction', () => ({ truncateMiddle: (text: string) => text }));
jest.mock('../../constants', () => ({ generateUUID: () => 'x' }));

import ToolsManager, { promptText } from '@/utils/ToolsManager';

const def = (name: string) => ({ type: 'function', function: { name, parameters: { type: 'object', properties: {}, required: [] } } }) as any;

test('pinned tools stay and do not take a slot', async () => {
    const names = Array.from({ length: 14 }, (_, i) => `homey__tool_${i}`);
    const defs = [def('generate_image'), ...names.map(def)];
    (ToolsManager as any)._tools = [{ alwaysOffer: true, definition: def('generate_image') }, ...names.map((name) => ({ definition: def(name) }))];
    mockRerank.mockImplementation(async ({ tools, topN }: any) => tools.slice(0, topN));

    const result = await ToolsManager.rerankTools(defs, 'maak de tuin vlakker', 'cloud');

    expect(mockRerank.mock.calls[0][0].tools.map((t: any) => t.function.name)).not.toContain('generate_image');
    expect(result.map((t) => t.function.name)).toContain('generate_image');
    expect(result).toHaveLength(11);
});

test('reads the text out of prompts with images', () => {
    expect(promptText('hello')).toBe('hello');
    expect(promptText([{ type: 'image_url', image_url: { url: 'data:...' } }, { type: 'text', text: 'maak de tuin vlakker' }])).toBe('maak de tuin vlakker');
    expect(promptText(undefined)).toBe('');
});
