/**
 * Image model listing: both listings merged, paging past the default page size, and the
 * response shapes we accept.
 */
jest.mock('react-native-keychain', () => ({}));

import { clearOpperModelCache, listOpperImageModels } from '../index';

const fetchMock = jest.fn();
global.fetch = fetchMock as any;

const json = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
const IMAGES_URL = 'https://api.opper.ai/v3/images/models';
const MODELS_URL = 'https://api.opper.ai/v3/models?type=image';

/** Route each request by URL so the two listings can answer differently */
function serve(routes: Record<string, (offset: number) => any>) {
    fetchMock.mockImplementation(async (url: string) => {
        const [base] = url.split(/[?&]limit=/);
        const offset = Number(/offset=(\d+)/.exec(url)?.[1] ?? 0);
        const route = routes[base];
        return route ? route(offset) : json({ detail: 'not found' }, 404);
    });
}

beforeEach(() => {
    fetchMock.mockReset();
    clearOpperModelCache();
});

test('merges both listings, sorted and deduplicated, and sends the key', async () => {
    serve({
        [IMAGES_URL]: () => json({ models: [
            { id: 'openai/gpt-image-1', name: 'GPT Image 1', provider: 'openai' },
            { id: 'pruna/p-image', name: 'P-Image', provider: 'pruna' },
        ] }),
        [MODELS_URL]: () => json({ models: [
            { id: 'xai/grok-imagine-image-2.0', name: 'Grok Imagine Image 2.0', provider: 'xai' },
            { id: 'openai/gpt-image-1', name: 'GPT Image 1', provider: 'openai' },
        ] }),
    });

    const models = await listOpperImageModels(' key ');

    expect(fetchMock.mock.calls[0][0]).toBe(`${IMAGES_URL}?limit=500&offset=0`);
    expect(fetchMock.mock.calls[1][0]).toBe(`${MODELS_URL}&limit=500&offset=0`);
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer key' });
    expect(models.map((m) => m.id)).toEqual(['openai/gpt-image-1', 'pruna/p-image', 'xai/grok-imagine-image-2.0']);
});

test('pages past the first page so models late in the alphabet are not cut off', async () => {
    const page = (from: number, count: number) => Array.from({ length: count }, (_, i) => ({ id: `a/model-${String(from + i).padStart(4, '0')}` }));
    serve({
        [IMAGES_URL]: (offset) => json(offset === 0 ? page(0, 500) : [...page(500, 10), { id: 'xai/grok-imagine-image-2.0' }]),
        [MODELS_URL]: () => json([]),
    });

    const models = await listOpperImageModels();

    expect(models).toHaveLength(511);
    expect(models[models.length - 1].id).toBe('xai/grok-imagine-image-2.0');
});

test('stops when an endpoint ignores the offset and repeats the same page', async () => {
    const full = Array.from({ length: 500 }, (_, i) => `a/m-${i}`);
    serve({ [IMAGES_URL]: () => json(full), [MODELS_URL]: () => json([]) });

    const models = await listOpperImageModels();

    expect(models).toHaveLength(500);
    expect(fetchMock.mock.calls.filter(([url]) => url.startsWith(IMAGES_URL))).toHaveLength(2);
});

test('uses the other listing when one fails, throws only when both fail', async () => {
    serve({ [MODELS_URL]: () => json(['openai/dall-e-3']) });
    expect(await listOpperImageModels()).toEqual([{ id: 'openai/dall-e-3', name: 'openai/dall-e-3', provider: 'openai', price: null, aliases: [], meta: null }]);

    fetchMock.mockReset();
    clearOpperModelCache();
    fetchMock.mockResolvedValue(json({ detail: 'down' }, 503));
    await expect(listOpperImageModels()).rejects.toThrow('Opper error 503: down');
});

test('reuses a listing for a while instead of fetching it again', async () => {
    serve({ [IMAGES_URL]: () => json(['a/x']), [MODELS_URL]: () => json([]) });
    await listOpperImageModels('k');
    const calls = fetchMock.mock.calls.length;
    await listOpperImageModels('k');
    expect(fetchMock.mock.calls.length).toBe(calls);
});
