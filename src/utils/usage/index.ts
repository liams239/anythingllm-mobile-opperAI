import { type IChatUsage, type IGeneratedImageAction } from '@/database/models/WorkspaceChat';
import { type OpperPrice } from '@/utils/opper/pricing';

/**
 * Totals for the usage page: tokens and estimated cost of chat replies, and images with what Opper
 * billed for them. Costs are only computed where we know a price (Opper models); everything else is
 * counted but left unpriced rather than guessed.
 */

export type ModelUsage = {
    model: string;
    replies: number;
    promptTokens: number;
    completionTokens: number;
    /** Null when the model has no known price */
    cost: number | null;
};

export type UsageSummary = {
    /** Replies with usage data */
    replies: number;
    /** Replies saved before usage tracking (no data) */
    untracked: number;
    promptTokens: number;
    completionTokens: number;
    cachedPromptTokens: number;
    /** Sum over priced replies */
    chatCost: number;
    /** Replies with tokens but no known price (eg: not through Opper) */
    unpricedReplies: number;
    images: number;
    /** What Opper billed, plus list-price estimates for images without a reported cost */
    imageCost: number;
    /** Images whose cost Opper reported (exact) */
    imagesBilled: number;
    /** Images priced from the model's list price */
    imagesEstimated: number;
    imagesUnpriced: number;
    models: ModelUsage[];
};

export type UsagePrices = {
    /** Opper price of a chat model by id, when known */
    chat: (model: string) => OpperPrice | null | undefined;
    /** Opper price of an image model by id, when known */
    image: (model: string) => OpperPrice | null | undefined;
};

type ChatLike = { response?: { usage?: IChatUsage; actions?: Array<{ type: string }> } | null };

/**
 * USD for one reply. Cached prompt tokens use the cache price when there is one. Long-prompt
 * surcharges are not applied, so tiered models come out as a lower bound.
 */
export function replyCost(usage: IChatUsage, price: OpperPrice | null | undefined): number | null {
    if (!price || price.input === undefined || price.output === undefined) return null;
    const cached = Math.min(usage.cachedPromptTokens ?? 0, usage.promptTokens);
    const fresh = usage.promptTokens - cached;
    const cachedRate = price.cacheRead ?? price.input;
    return (fresh * price.input + cached * cachedRate + usage.completionTokens * price.output) / 1_000_000;
}

export function summarizeUsage(chats: ChatLike[], prices: UsagePrices): UsageSummary {
    const summary: UsageSummary = {
        replies: 0, untracked: 0, promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0, chatCost: 0, unpricedReplies: 0,
        images: 0, imageCost: 0, imagesBilled: 0, imagesEstimated: 0, imagesUnpriced: 0, models: [],
    };
    const byModel = new Map<string, ModelUsage>();

    for (const chat of chats) {
        const response = chat?.response;
        if (!response) continue;
        const usage = response.usage;
        if (usage && (usage.promptTokens || usage.completionTokens)) {
            summary.replies += 1;
            summary.promptTokens += usage.promptTokens;
            summary.completionTokens += usage.completionTokens;
            summary.cachedPromptTokens += usage.cachedPromptTokens ?? 0;
            const model = usage.model || '?';
            const cost = usage.opper ? replyCost(usage, prices.chat(model)) : null;
            if (cost === null) summary.unpricedReplies += 1;
            else summary.chatCost += cost;
            const entry = byModel.get(model) ?? { model, replies: 0, promptTokens: 0, completionTokens: 0, cost: null };
            entry.replies += 1;
            entry.promptTokens += usage.promptTokens;
            entry.completionTokens += usage.completionTokens;
            if (cost !== null) entry.cost = (entry.cost ?? 0) + cost;
            byModel.set(model, entry);
        } else if (!usage) {
            summary.untracked += 1;
        }

        for (const action of response.actions ?? []) {
            if (action?.type !== 'generated_image') continue;
            const image = (action as IGeneratedImageAction).action;
            summary.images += 1;
            if (typeof image?.cost === 'number') {
                summary.imageCost += image.cost;
                summary.imagesBilled += 1;
                continue;
            }
            const listPrice = image?.model ? prices.image(image.model) : null;
            const estimate = listPrice?.perImage ?? listPrice?.perMegapixel;
            if (estimate !== undefined && estimate !== null) {
                summary.imageCost += estimate;
                summary.imagesEstimated += 1;
            } else {
                summary.imagesUnpriced += 1;
            }
        }
    }

    summary.models = [...byModel.values()].sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1) || b.replies - a.replies);
    return summary;
}

/** "$0.12", "$0.0034", "< $0.0001" */
export function formatUsd(value: number): string {
    if (value === 0) return '$0';
    if (value < 0.0001) return '< $0.0001';
    if (value >= 1) return `$${value.toFixed(2)}`;
    return `$${Number(value.toPrecision(2))}`;
}

/** "12.3K", "1.2M", "850" */
export function formatTokens(value: number): string {
    if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
    if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}K`;
    return String(value);
}

/** Epoch millis of the first moment of the current month, local time */
export function startOfMonth(now = new Date()): number {
    return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}
