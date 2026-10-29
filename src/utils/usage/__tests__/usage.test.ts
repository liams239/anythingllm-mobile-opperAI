/**
 * Usage totals: tokens per reply, Opper prices with cache, billed and estimated images.
 */
import { formatTokens, formatUsd, replyCost, startOfMonth, summarizeUsage, type UsagePrices } from '../index';

const SONNET_EU = { input: 2.2, output: 11, cacheRead: 0.22 };
const prices: UsagePrices = {
    chat: (model) => (model === 'aws/claude-sonnet-5' ? SONNET_EU : null),
    image: (model) => (model === 'xai/grok-imagine-image' ? { perImage: 0.02 } : null),
};

const reply = (usage: any, actions: any[] = []) => ({ response: { usage, actions } });
const image = (extra: any) => ({ type: 'generated_image', action: { prompt: 'x', storageFilename: 'image-1.png', fileSize: 1, mimeType: 'image/png', ...extra } });

test('prices a reply, cached prompt tokens at the cache rate', () => {
    // 10K fresh in, 90K cached, 2K out
    const cost = replyCost({ promptTokens: 100_000, cachedPromptTokens: 90_000, completionTokens: 2_000 }, SONNET_EU);
    expect(cost).toBeCloseTo((10_000 * 2.2 + 90_000 * 0.22 + 2_000 * 11) / 1_000_000, 10);
    expect(replyCost({ promptTokens: 1, completionTokens: 1 }, null)).toBeNull();
});

test('sums replies and images, keeping unpriced and untracked apart', () => {
    const summary = summarizeUsage([
        reply({ model: 'aws/claude-sonnet-5', opper: true, promptTokens: 10_000, completionTokens: 1_000 }),
        reply({ model: 'aws/claude-sonnet-5', opper: true, promptTokens: 20_000, completionTokens: 500 }, [
            image({ model: 'xai/grok-imagine-image', cost: 0.025 }),
            image({ model: 'xai/grok-imagine-image' }),
            image({ model: 'unknown/model' }),
        ]),
        // Not through Opper: tokens only
        reply({ model: 'gpt-local', opper: false, promptTokens: 500, completionTokens: 100 }),
        // Saved before usage tracking
        { response: { actions: [] } },
        // A failed turn that never reported usage
        reply({ model: 'aws/claude-sonnet-5', opper: true, promptTokens: 0, completionTokens: 0 }),
    ], prices);

    expect(summary.replies).toBe(3);
    expect(summary.untracked).toBe(1);
    expect(summary.promptTokens).toBe(30_500);
    expect(summary.completionTokens).toBe(1_600);
    expect(summary.chatCost).toBeCloseTo((30_000 * 2.2 + 1_500 * 11) / 1_000_000, 10);
    expect(summary.unpricedReplies).toBe(1);
    expect(summary.images).toBe(3);
    expect(summary.imagesBilled).toBe(1);
    expect(summary.imagesEstimated).toBe(1);
    expect(summary.imagesUnpriced).toBe(1);
    expect(summary.imageCost).toBeCloseTo(0.045, 10);
    expect(summary.models.map((m) => m.model)).toEqual(['aws/claude-sonnet-5', 'gpt-local']);
    expect(summary.models[1].cost).toBeNull();
});

test('formats money, tokens and the start of the month', () => {
    expect(formatUsd(0)).toBe('$0');
    expect(formatUsd(0.00004)).toBe('< $0.0001');
    expect(formatUsd(0.0825)).toBe('$0.083');
    expect(formatUsd(3.456)).toBe('$3.46');
    expect(formatTokens(850)).toBe('850');
    expect(formatTokens(12_340)).toBe('12.3K');
    expect(formatTokens(1_250_000)).toBe('1.3M');
    expect(new Date(startOfMonth(new Date(2026, 9, 9, 15))).getDate()).toBe(1);
});
