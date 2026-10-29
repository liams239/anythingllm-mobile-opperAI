import { type OpperModelMeta, traits } from './metadata';
import { comparablePrice, type OpperPrice } from './pricing';

/**
 * Filters for the Opper model pickers. Image and chat lists keep their own set; both are stored on
 * the phone so a choice like "EU + no logging" stays the default view until cleared.
 */
export type OpperModelKind = 'image' | 'chat';

export type OpperCapabilityFilter = 'edit' | 'vision' | 'pdf' | 'reasoning' | 'structured';

export type OpperModelFilters = {
    /** Empty = any region */
    regions: string[];
    noLogging: boolean;
    zdr: boolean;
    dpa: boolean;
    capabilities: OpperCapabilityFilter[];
    fast: boolean;
    best: boolean;
    /** Upper bound on `comparablePrice` (per 1M input tokens or per image), null = any */
    maxPrice: number | null;
};

export const EMPTY_FILTERS: OpperModelFilters = {
    regions: [],
    noLogging: false,
    zdr: false,
    dpa: false,
    capabilities: [],
    fast: false,
    best: false,
    maxPrice: null,
};

/** Price caps offered per list - per 1M input tokens for chat, per image for images */
export const PRICE_STEPS: Record<OpperModelKind, number[]> = {
    chat: [0.5, 1, 3, 10],
    image: [0.01, 0.03, 0.05, 0.1],
};

const CAPABILITY_TRAITS: Record<OpperCapabilityFilter, (meta: OpperModelMeta) => boolean> = {
    edit: traits.canEdit,
    vision: traits.vision,
    pdf: traits.pdf,
    reasoning: traits.reasoning,
    structured: traits.structured,
};

/** How many filters are on - shown on the "Filters" button */
export function activeFilterCount(filters: OpperModelFilters): number {
    return (filters.regions.length ? 1 : 0)
        + [filters.noLogging, filters.zdr, filters.dpa, filters.fast, filters.best].filter(Boolean).length
        + filters.capabilities.length
        + (filters.maxPrice !== null ? 1 : 0);
}

/**
 * Whether a model passes the filters. A model without metadata (eg: an id the OpenAI-compatible
 * list has but Opper's listing does not) only passes when no filter is on.
 */
export function matchesFilters(meta: OpperModelMeta | null | undefined, price: OpperPrice | null | undefined, filters: OpperModelFilters): boolean {
    if (!activeFilterCount(filters)) return true;
    if (!meta) return false;
    if (filters.regions.length && !filters.regions.includes(meta.region ?? '')) return false;
    if (filters.noLogging && !traits.noLogging(meta)) return false;
    if (filters.zdr && !traits.zdr(meta)) return false;
    if (filters.dpa && !traits.dpa(meta)) return false;
    if (filters.fast && !traits.fast(meta)) return false;
    if (filters.best && !traits.best(meta)) return false;
    for (const capability of filters.capabilities) if (!CAPABILITY_TRAITS[capability](meta)) return false;
    if (filters.maxPrice !== null) {
        const value = comparablePrice(price);
        if (value === null || value > filters.maxPrice) return false;
    }
    return true;
}

/** Fill gaps in stored filters (older versions, bad data) so the UI can rely on every field */
export function normalizeFilters(stored: unknown): OpperModelFilters {
    const raw = (stored && typeof stored === 'object' ? stored : {}) as Partial<OpperModelFilters>;
    return {
        regions: Array.isArray(raw.regions) ? raw.regions.filter((r) => typeof r === 'string') : [],
        noLogging: raw.noLogging === true,
        zdr: raw.zdr === true,
        dpa: raw.dpa === true,
        capabilities: Array.isArray(raw.capabilities)
            ? raw.capabilities.filter((c): c is OpperCapabilityFilter => c in CAPABILITY_TRAITS)
            : [],
        fast: raw.fast === true,
        best: raw.best === true,
        maxPrice: typeof raw.maxPrice === 'number' ? raw.maxPrice : null,
    };
}

/**
 * Whether every listed model says it does not train on your data - then a training filter would
 * remove nothing, and the list shows one reassuring line instead.
 */
export function noModelTrains(metas: Array<OpperModelMeta | null | undefined>): boolean {
    const known = metas.filter((meta): meta is OpperModelMeta => !!meta);
    return known.length > 0 && known.every((meta) => meta.privacy.training === 'no');
}
