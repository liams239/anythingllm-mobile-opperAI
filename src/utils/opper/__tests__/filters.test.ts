/**
 * Model metadata and filters against real Opper listing entries.
 */
import { contextLabel, parseOpperMeta, regionLabel, resolutionLabel, traits } from '../metadata';
import { activeFilterCount, EMPTY_FILTERS, matchesFilters, noModelTrains, normalizeFilters } from '../filters';
import { parseOpperPrice } from '../pricing';

const CHAT = require('./fixtures-models.json').models as any[];
const IMAGES = require('./fixtures-image-models.json').models as any[];
const chat = (id: string) => CHAT.find((m) => m.id === id);
const image = (id: string) => IMAGES.find((m) => m.id === id);

test('reads maker, route, region, capabilities and privacy', () => {
    const meta = parseOpperMeta(chat('aws/claude-sonnet-5'));
    expect(meta).toMatchObject({ maker: 'Anthropic', host: 'AWS', region: 'EU' });
    expect(meta.privacy).toMatchObject({ training: 'no', logging: 'none', transferMechanism: 'eu_resident', dpa: true });
    expect(traits.vision(meta) && traits.pdf(meta) && traits.reasoning(meta)).toBe(true);
    expect(traits.noLogging(meta)).toBe(true);
    expect(contextLabel(meta.contextWindow)).toBe('1M');
});

test('only claims ZDR when nothing is stored, not when storage is unknown', () => {
    const metas = CHAT.map(parseOpperMeta);
    for (const meta of metas) {
        if (traits.zdr(meta)) expect(meta.privacy.contentStorage).toBe('ephemeral');
    }
    expect(metas.some((m) => traits.noLogging(m) && !traits.zdr(m))).toBe(true);
});

test('image traits: edit, largest size, region label', () => {
    const grok = parseOpperMeta(image('xai/grok-imagine-image-2.0'));
    expect(traits.canEdit(grok)).toBe(true);
    expect(regionLabel(grok.region)).toBe('US');
    expect(resolutionLabel(parseOpperMeta(image('bytedance:ap/seedream-4.5')).maxImageSide)).toBe('3K');
    expect(regionLabel('GLOBAL')).toBe('Global');
    expect(traits.veryFast(parseOpperMeta(image('pruna/p-image')))).toBe(true);
});

test('nothing in the real listings trains on your data', () => {
    expect(noModelTrains(CHAT.map(parseOpperMeta))).toBe(true);
    expect(noModelTrains(IMAGES.map(parseOpperMeta))).toBe(true);
    expect(noModelTrains([{ ...parseOpperMeta(CHAT[0]), privacy: { training: 'yes' } }])).toBe(false);
    expect(noModelTrains([null])).toBe(false);
});

test('filters by region, privacy, capability and price', () => {
    const pass = (entry: any, filters: any) => matchesFilters(parseOpperMeta(entry), parseOpperPrice(entry), { ...EMPTY_FILTERS, ...filters });
    expect(pass(chat('aws/claude-sonnet-5'), { regions: ['EU'], noLogging: true })).toBe(true);
    expect(pass(chat('arcee/moonshotai/kimi-k3'), { regions: ['EU'] })).toBe(false);
    expect(pass(chat('arcee/moonshotai/kimi-k3'), { capabilities: ['vision', 'reasoning'] })).toBe(true);
    expect(pass(chat('aws/claude-sonnet-5'), { maxPrice: 1 })).toBe(false);
    expect(pass(chat('aws/claude-sonnet-5'), { maxPrice: 3 })).toBe(true);
    // Image price filter uses the cheapest per-image price
    expect(pass(image('openai/gpt-image-1'), { maxPrice: 0.03 })).toBe(true);
    expect(pass(image('fal/flux-1-schnell'), { maxPrice: 0.01 })).toBe(true);
    expect(pass(image('pruna/p-image'), { capabilities: ['edit'] })).toBe(false);
});

test('a model without details only shows when no filter is on', () => {
    expect(matchesFilters(null, null, EMPTY_FILTERS)).toBe(true);
    expect(matchesFilters(null, null, { ...EMPTY_FILTERS, fast: true })).toBe(false);
});

test('counts active filters and repairs stored ones', () => {
    expect(activeFilterCount({ ...EMPTY_FILTERS, regions: ['EU', 'US'], noLogging: true, capabilities: ['pdf'], maxPrice: 1 })).toBe(4);
    expect(normalizeFilters({ regions: ['EU', 3], capabilities: ['vision', 'bogus'], fast: 'yes', maxPrice: '2' }))
        .toEqual({ ...EMPTY_FILTERS, regions: ['EU'], capabilities: ['vision'] });
    expect(normalizeFilters(undefined)).toEqual(EMPTY_FILTERS);
});
