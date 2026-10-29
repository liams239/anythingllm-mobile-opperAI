/**
 * Price parsing against the shapes Opper's model listings return.
 */
import { formatOpperPrice, parseOpperPrice } from '../pricing';

// Trimmed from GET /v3/models (an llm and an image entry)
const DEEPSEEK = {
    id: 'alibaba:global/deepseek-v4-pro',
    type: 'llm',
    cost: 0.22,
    pricing: { billing_unit: 'per_mtok', input: [1.7904], output: [3.5808], cached_input: [0.1492] },
};
const SEEDREAM = {
    id: 'bytedance:ap/seedream-4.5',
    type: 'image',
    pricing: { billing_unit: 'per_generation', rates: [{ unit: 'per_generation', amount: 0.04 }], price_per_generation: 0.04 },
};

test('reads per-million token prices, taking the first tier', () => {
    expect(parseOpperPrice(DEEPSEEK)).toEqual({ input: 1.7904, output: 3.5808, cacheRead: 0.1492 });
    expect(formatOpperPrice(parseOpperPrice(DEEPSEEK))).toBe('$1.79 in · $3.58 out · $0.15 cache /1M');
});

test('reads the per-generation price of image models', () => {
    expect(parseOpperPrice(SEEDREAM)).toEqual({ perImage: 0.04 });
    expect(formatOpperPrice(parseOpperPrice(SEEDREAM))).toBe('$0.04 /image');
    // Falls back to the first rate when the shortcut field is missing
    expect(parseOpperPrice({ pricing: { billing_unit: 'per_generation', rates: [{ amount: 0.12 }] } })).toEqual({ perImage: 0.12 });
});

test('never takes the relative cost score for a price', () => {
    expect(parseOpperPrice({ id: 'x', cost: 0.22 })).toBeNull();
    expect(formatOpperPrice(null)).toBeNull();
});

test('ignores pricing in a billing unit it does not know', () => {
    expect(parseOpperPrice({ pricing: { input: [1], output: [2] } })).toBeNull();
    expect(parseOpperPrice({ pricing: { billing_unit: 'per_second', input: [1] } })).toBeNull();
});

// One entry per pricing shape seen in a real GET /v3/models?type=llm page
const FIXTURE = require('./fixtures-models.json').models as Array<{ id: string; pricing: any }>;
const byId = (id: string) => FIXTURE.find((m) => m.id === id);

test('every real pricing shape gives base input and output prices', () => {
    for (const model of FIXTURE) {
        const price = parseOpperPrice(model);
        expect(price?.input).toBe(model.pricing.input[0]);
        expect(price?.output).toBe(model.pricing.output[0]);
    }
});

test('reads cache read and write, skips fees and surcharge fields', () => {
    expect(parseOpperPrice(byId('anthropic/claude-fable-5-1'))).toEqual({ input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 });
    expect(formatOpperPrice(parseOpperPrice(byId('anthropic/claude-fable-5-1')))).toBe('$10 in · $50 out · $0.25 cache · $12.5 cache write /1M');
    expect(parseOpperPrice(byId('alibaba:global/qwen3.8-max'))).toEqual({ input: 2, output: 6, cacheRead: 0.25 });
});

test('marks tiered and surcharged prices with a plus', () => {
    expect(formatOpperPrice(parseOpperPrice(byId('alibaba:eu/qwen3-vl-plus')))).toBe('$0.2+ in · $1.6+ out /1M');
    expect(parseOpperPrice(byId('anthropic/claude-haiku-5-5'))).toMatchObject({ input: 0.1, cacheWrite: 0.125, tiered: true });
    expect(parseOpperPrice(byId('abliteration/abliterated-model'))?.tiered).toBeUndefined();
});

describe('listOpperChatModels', () => {
    const fetchMock = jest.fn();
    beforeAll(() => { global.fetch = fetchMock as any; });

    test('keys models by route id and alias only, never the shared model name', async () => {
        jest.resetModules();
        jest.doMock('react-native-keychain', () => ({}));
        const { listOpperChatModels } = require('../index');
        const route = (id: string, input: number, aliases: string[] = []) => ({
            id, aliases, model_id: 'deepseek-v4-pro', pricing: { billing_unit: 'per_mtok', input: [input], output: [input * 2] },
        });
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({ models: [
            route('alibaba:global/deepseek-v4-pro', 1.79, ['alibaba:eu/deepseek-v4-pro']),
            route('deepseek/deepseek-v4-pro', 1.2),
        ] }) });

        const routes = await listOpperChatModels();

        expect(routes.get('alibaba:global/deepseek-v4-pro')?.price?.input).toBe(1.79);
        expect(routes.get('alibaba:eu/deepseek-v4-pro')?.price?.input).toBe(1.79);
        expect(routes.get('deepseek/deepseek-v4-pro')?.price?.input).toBe(1.2);
        expect(routes.has('deepseek-v4-pro')).toBe(false);
    });
});

// One entry per image pricing shape seen in a real GET /v3/models?type=image page
const IMAGES = require('./fixtures-image-models.json').models as Array<{ id: string; pricing: any }>;
const image = (id: string) => formatOpperPrice(parseOpperPrice(IMAGES.find((m) => m.id === id)));

test('reads every real image pricing shape', () => {
    expect(image('pruna/p-image')).toBe('$0.002 /image');
    expect(image('bytedance:ap/seedream-4.5')).toBe('$0.04 /image');
    // reported_cost with the real unit on the rate
    expect(image('deepinfra/Bria/Bria-3.2')).toBe('$0.04 /image');
    expect(image('deepinfra/black-forest-labs/FLUX-2-pro')).toBe('$0.015 /megapixel');
    expect(image('fal/flux-1-schnell')).toBe('$0.003 /megapixel');
    // One rate per quality and size: shown as a range
    expect(image('openai/gpt-image-1')).toBe('$0.011 – 0.25 /image');
    expect(image('xai/grok-imagine-image-2.0')).toMatch(/^\$0\.04 – 0\.\d+ \/image$/);
    expect(image('fal/ideogram-v4.5')).toBe('$0.03 – 0.22 /image');
    // Per-token billing that also lists per-image rates prefers the per-image price
    expect(image('openai/gpt-image-2')).toBe('$0.0047 – 0.43 /image');
    // Image tokens only
    expect(image('openai/gpt-image-2.5-sunburst')).toBe('$8 in · $30 out · $2 cache /1M image tokens');
});
