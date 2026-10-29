import * as Keychain from 'react-native-keychain';
import { parseOpperPrice, type OpperPrice } from './pricing';
import { parseOpperMeta, type OpperModelMeta } from './metadata';

export { formatOpperPrice, comparablePrice, type OpperPrice } from './pricing';
export { traits, contextLabel, resolutionLabel, regionLabel, type OpperModelMeta } from './metadata';
export {
    activeFilterCount, matchesFilters, noModelTrains, normalizeFilters, EMPTY_FILTERS, PRICE_STEPS,
    type OpperModelFilters, type OpperModelKind, type OpperCapabilityFilter,
} from './filters';

/**
 * Opper (https://opper.ai) image generation. Lets the chat model hand image requests to an
 * image model while the conversation itself stays on whatever LLM the user picked.
 *
 * Settings (API key + optional model) live in the keychain, readable after first unlock so
 * scheduled jobs running in the background can use them too.
 */

const KEYCHAIN_SERVICE = 'com.anythingllm.opper';
export const OPPER_BASE_URL = 'https://api.opper.ai';
/** Opper's built-in image function. The model is picked by Opper unless the user set one. */
const IMAGE_FUNCTION_NAME = 'image-gen';
export const OPPER_MODEL_PLACEHOLDER = 'openai/gpt-image-1';

export type OpperSettings = {
    apiKey: string;
    /** Empty = let Opper pick its default image model */
    model: string;
};

export type OpperImage = {
    /** Base64 image data, no data: prefix */
    base64: string;
    mimeType: string;
    /** What Opper billed in USD (`meta.cost`), when it says */
    cost?: number;
    /** The model that made it (`meta.models_used`), when Opper says */
    model?: string;
};

function log(text: string, ...args: any[]) {
    console.log(`\x1b[35m[Opper] ${text}\x1b[0m`, ...args);
}

let cached: OpperSettings | null | undefined;

export async function getOpperSettings(): Promise<OpperSettings | null> {
    if (cached !== undefined) return cached;
    try {
        const stored = await Keychain.getGenericPassword({ service: KEYCHAIN_SERVICE });
        const parsed = stored ? JSON.parse(stored.password) : null;
        cached = parsed?.apiKey ? { apiKey: String(parsed.apiKey), model: String(parsed.model ?? '') } : null;
    } catch (error) {
        log('Could not read stored settings', error);
        cached = null;
    }
    return cached;
}

export async function hasOpperApiKey(): Promise<boolean> {
    return !!(await getOpperSettings())?.apiKey;
}

export async function saveOpperSettings(settings: OpperSettings): Promise<void> {
    const next = { apiKey: settings.apiKey.trim(), model: settings.model.trim() };
    if (!next.apiKey) return clearOpperSettings();
    await Keychain.setGenericPassword('opper', JSON.stringify(next), {
        service: KEYCHAIN_SERVICE,
        accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    });
    cached = next;
}

export async function clearOpperSettings(): Promise<void> {
    cached = null;
    await Keychain.resetGenericPassword({ service: KEYCHAIN_SERVICE }).catch(() => false);
}

/** Pull a readable message out of an Opper error body */
function errorMessage(status: number, body: string): string {
    try {
        const parsed = JSON.parse(body);
        const message = parsed?.error?.message ?? parsed?.detail ?? parsed?.message;
        if (message) return `Opper error ${status}: ${typeof message === 'string' ? message : JSON.stringify(message)}`;
    } catch { }
    return `Opper error ${status}${body ? `: ${body.slice(0, 300)}` : ''}`;
}

/**
 * Generate one image. Mirrors `opper.generateImage()` from the `opperai` SDK: a call to the
 * `image-gen` function with a `{ description }` input and an `{ image, mime_type }` output.
 */
export async function generateOpperImage({ prompt, size, settings, signal }: {
    prompt: string;
    size?: string;
    settings: OpperSettings;
    signal?: AbortSignal | null;
}): Promise<OpperImage> {
    const inputProperties: Record<string, any> = {
        description: { type: 'string', description: 'Text description of the image to generate' },
    };
    const input: Record<string, any> = { description: prompt };
    if (size) {
        inputProperties.size = { type: 'string', description: 'Image size' };
        input.size = size;
    }

    const body: Record<string, any> = {
        input_schema: { type: 'object', properties: inputProperties, required: ['description'] },
        output_schema: {
            type: 'object',
            properties: {
                image: { type: 'string', description: 'Base64-encoded image data' },
                mime_type: { type: 'string', description: 'MIME type of the generated image' },
            },
            required: ['image', 'mime_type'],
        },
        input,
    };
    if (settings.model) body.model = settings.model;

    const response = await fetch(`${OPPER_BASE_URL}/v3/functions/${IMAGE_FUNCTION_NAME}/call`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${settings.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: signal ?? undefined,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(errorMessage(response.status, text));

    const parsed = JSON.parse(text);
    const raw: string | undefined = parsed?.data?.image;
    if (!raw) throw new Error('Opper returned no image');
    // Be lenient if a data: URL comes back instead of bare base64
    const match = /^data:([^;]+);base64,(.*)$/s.exec(raw);
    const base64 = match ? match[2] : raw;
    const mimeType = match?.[1] || parsed?.data?.mime_type || 'image/png';
    const cost = typeof parsed?.meta?.cost === 'number' && Number.isFinite(parsed.meta.cost) ? parsed.meta.cost : undefined;
    const usedModel = Array.isArray(parsed?.meta?.models_used) && typeof parsed.meta.models_used[0] === 'string' ? parsed.meta.models_used[0] : undefined;
    return { base64, mimeType, cost, model: usedModel ?? (settings.model || undefined) };
}

/** File extension for an image MIME type */
export function imageExtension(mimeType: string): string {
    const sub = mimeType.split('/')[1]?.toLowerCase() ?? '';
    if (sub === 'jpeg' || sub === 'jpg') return 'jpg';
    if (sub === 'webp' || sub === 'gif' || sub === 'png') return sub;
    return 'png';
}

export type OpperModel = {
    id: string;
    name: string;
    provider: string;
    /** From the listing's `pricing`, when it has one */
    price?: OpperPrice | null;
    /** Other ids Opper accepts for this model */
    aliases?: string[];
    /** Capabilities and privacy - null for bare ids without a listing entry */
    meta?: OpperModelMeta | null;
};
/** @deprecated use OpperModel */
export type OpperImageModel = OpperModel;

/** Accepts the shapes the model listings come back in: a bare array, `{ models }` or `{ data }` */
function parseModelList(body: any): OpperImageModel[] {
    const list = Array.isArray(body) ? body : body?.models ?? body?.data ?? [];
    if (!Array.isArray(list)) return [];
    const models: OpperImageModel[] = [];
    for (const entry of list) {
        const id = typeof entry === 'string' ? entry : entry?.id ?? entry?.name;
        if (!id || typeof id !== 'string') continue;
        models.push({
            id,
            name: typeof entry?.name === 'string' ? entry.name : id,
            provider: typeof entry?.provider === 'string'
                ? entry.provider
                : entry?.provider?.display_name ?? entry?.provider?.slug ?? id.split('/')[0] ?? '',
            price: typeof entry === 'object' ? parseOpperPrice(entry) : null,
            // Only the aliases Opper lists - each route is its own entry with its own price, so the
            // route-less name (eg: "deepseek-v4-pro") is shared and would match the wrong route
            aliases: (Array.isArray(entry?.aliases) ? entry.aliases : [])
                .filter((a: unknown): a is string => typeof a === 'string' && a !== id),
            meta: typeof entry === 'object' ? parseOpperMeta(entry) : null,
        });
    }
    return models;
}

const MODELS_PAGE_SIZE = 500;
const MAX_MODEL_PAGES = 10;

/** Every page of one listing. The listings return 50 models unless asked for more, so page through. */
async function fetchAllModelPages(baseUrl: string, headers: Record<string, string>): Promise<OpperImageModel[]> {
    const seen = new Map<string, OpperImageModel>();
    for (let page = 0; page < MAX_MODEL_PAGES; page++) {
        const separator = baseUrl.includes('?') ? '&' : '?';
        const url = `${baseUrl}${separator}limit=${MODELS_PAGE_SIZE}&offset=${page * MODELS_PAGE_SIZE}`;
        const response = await fetch(url, { headers });
        if (!response.ok) throw new Error(errorMessage(response.status, await response.text()));
        const models = parseModelList(await response.json());
        const before = seen.size;
        for (const model of models) seen.set(model.id, model);
        // Stop on a short page, or when the endpoint ignores the offset and repeats itself
        if (models.length < MODELS_PAGE_SIZE || seen.size === before) break;
    }
    return [...seen.values()];
}

/**
 * Image models Opper offers: the dedicated image listing merged with the general listing
 * filtered on type, so a model missing from one still shows up. Both work without a key; it is
 * sent when we have one. Throws only when neither listing could be read.
 */
async function fetchOpperImageModels(apiKey?: string): Promise<OpperModel[]> {
    const headers: Record<string, string> = apiKey?.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {};
    const urls = [`${OPPER_BASE_URL}/v3/images/models`, `${OPPER_BASE_URL}/v3/models?type=image`];
    const results = await Promise.allSettled(urls.map((url) => fetchAllModelPages(url, headers)));
    const merged = new Map<string, OpperImageModel>();
    let lastError: unknown = null;
    results.forEach((result, index) => {
        if (result.status === 'rejected') {
            lastError = result.reason;
            log(`Could not list image models from ${urls[index]}`, result.reason);
            return;
        }
        for (const model of result.value) if (!merged.has(model.id)) merged.set(model.id, model);
    });
    if (!merged.size && lastError) throw lastError;
    return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Opper's chat models keyed by model id and alias, for the badges, filters and prices next to the
 * models of an OpenAI-compatible connection pointed at Opper (its /models carries none of that).
 */
async function fetchOpperChatModels(apiKey?: string): Promise<Map<string, OpperModel>> {
    const headers: Record<string, string> = apiKey?.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {};
    const models = await fetchAllModelPages(`${OPPER_BASE_URL}/v3/models?type=llm`, headers);
    const byId = new Map<string, OpperModel>();
    for (const model of models) {
        for (const id of [model.id, ...(model.aliases ?? [])]) if (!byId.has(id)) byId.set(id, model);
    }
    return byId;
}

/** Listings change rarely - reuse a fetch for a while so reopening the sheet is instant */
const CACHE_MS = 10 * 60 * 1000;
const listingCache = new Map<string, { at: number; promise: Promise<any> }>();

function cachedListing<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = listingCache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.promise;
    const promise = load();
    listingCache.set(key, { at: Date.now(), promise });
    // A failed fetch is not kept, so "Try again" really tries again
    promise.catch(() => { if (listingCache.get(key)?.promise === promise) listingCache.delete(key); });
    return promise;
}

/** Forget cached listings, eg: after the API key changed */
export function clearOpperModelCache() {
    listingCache.clear();
}

/**
 * Image models Opper offers: the dedicated image listing merged with the general listing
 * filtered on type, so a model missing from one still shows up. Throws only when neither listing
 * could be read.
 */
export function listOpperImageModels(apiKey?: string): Promise<OpperModel[]> {
    return cachedListing(`image:${apiKey?.trim() ?? ''}`, () => fetchOpperImageModels(apiKey));
}

export function listOpperChatModels(apiKey?: string): Promise<Map<string, OpperModel>> {
    return cachedListing(`chat:${apiKey?.trim() ?? ''}`, () => fetchOpperChatModels(apiKey));
}

/** Whether a base URL points at Opper (eg: an OpenAI-compatible connection to api.opper.ai) */
export function isOpperUrl(url?: string | null): boolean {
    return typeof url === 'string' && /(^|\/\/|\.)opper\.ai(\/|:|$)/i.test(url.trim());
}
