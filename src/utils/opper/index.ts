import * as Keychain from 'react-native-keychain';
import { Buffer } from 'buffer';
import uiStore from '@/store/UIStore';
import { parseOpperPrice, type OpperPrice } from './pricing';
import { parseOpperMeta, type OpperModelMeta } from './metadata';

export { formatOpperPrice, comparablePrice, type OpperPrice } from './pricing';
export { traits, contextLabel, resolutionLabel, regionLabel, fitImageSize, type OpperModelMeta } from './metadata';
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
    // Another key may have other providers connected - earlier failures no longer say anything
    if (cached?.apiKey !== next.apiKey) await uiStore.setToStorage('opper_provider_failures', {}).catch(() => null);
    cached = next;
}

/** The provider a route runs on, from its id: "deepinfra/ByteDance/Seedream-4" -> "deepinfra", "azure:global/x" -> "azure" */
export function routeProvider(modelId: string): string {
    return modelId.split('/')[0].split(':')[0].toLowerCase();
}

/** "... is not available: provider deepinfra is not configured" -> "deepinfra" */
export function unconfiguredProvider(message: string): string | null {
    return /provider\s+([\w.-]+)\s+is not configured/i.exec(message)?.[1]?.toLowerCase() ?? null;
}

export type ProviderFailure = {
    count: number;
    /** Epoch millis of the last failure */
    lastAt: number;
    message: string;
};

/**
 * Providers that failed for this Opper account ("provider deepinfra is not configured"), learned
 * from errors - Opper's listings show every route, not which providers an account can use. Their
 * routes stay pickable (it may be temporary) but are marked and listed last; a later success clears it.
 */
export async function providerFailures(): Promise<Record<string, ProviderFailure>> {
    const stored: unknown = await uiStore.getFromStorage('opper_provider_failures', {}).catch(() => ({}));
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Record<string, ProviderFailure>) : {};
}

export async function recordProviderFailure(provider: string, message: string): Promise<void> {
    const failures = await providerFailures();
    const previous = failures[provider];
    await uiStore.setToStorage('opper_provider_failures', {
        ...failures,
        [provider]: { count: (previous?.count ?? 0) + 1, lastAt: Date.now(), message: message.slice(0, 300) },
    });
}

export async function clearProviderFailure(provider: string): Promise<void> {
    const failures = await providerFailures();
    if (!failures[provider]) return;
    const rest = { ...failures };
    delete rest[provider];
    await uiStore.setToStorage('opper_provider_failures', rest);
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
export async function generateOpperImage({ prompt, size, referenceImage, settings, signal }: {
    prompt: string;
    size?: string;
    /** Base64 image to edit (no data: prefix) - the prompt then describes the changes */
    referenceImage?: string;
    settings: OpperSettings;
    signal?: AbortSignal | null;
}): Promise<OpperImage> {
    const inputProperties: Record<string, any> = {
        description: { type: 'string', description: 'Text description of the image to generate' },
    };
    const input: Record<string, any> = { description: prompt };
    if (referenceImage) {
        inputProperties.reference_image = { type: 'string', description: 'Base64-encoded reference image' };
        input.reference_image = referenceImage;
    }
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
    const cost = typeof parsed?.meta?.cost === 'number' && Number.isFinite(parsed.meta.cost) ? parsed.meta.cost : undefined;
    const usedModel = Array.isArray(parsed?.meta?.models_used) && typeof parsed.meta.models_used[0] === 'string' ? parsed.meta.models_used[0] : undefined;

    const image = await imageFromResponse(parsed, settings, signal);
    return { ...image, cost, model: usedModel ?? (settings.model || undefined) };
}

const ARTIFACT_POLL_MS = 3_000;
const ARTIFACT_TIMEOUT_MS = 5 * 60_000;

/** What kind of image the bytes are, from their first bytes - null when they are not an image */
export function sniffImageType(bytes: Uint8Array): string | null {
    const startsWith = (...sig: number[]) => sig.every((byte, i) => bytes[i] === byte);
    if (startsWith(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
    if (startsWith(0xff, 0xd8, 0xff)) return 'image/jpeg';
    if (startsWith(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
    if (startsWith(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
    return null;
}

/** Base64 that really holds an image, with its actual type - or a clear error instead of a blank card */
function checkedImage(base64: string, claimedMime?: string): { base64: string; mimeType: string } {
    const clean = base64.replace(/\s+/g, '');
    const type = sniffImageType(new Uint8Array(Buffer.from(clean.slice(0, 64), 'base64')));
    if (!type) throw new Error(`Opper returned data that is not an image${claimedMime ? ` (said ${claimedMime})` : ''}`);
    return { base64: clean, mimeType: type };
}

async function download(url: string, signal?: AbortSignal | null): Promise<{ base64: string; mimeType: string }> {
    const response = await fetch(url, { signal: signal ?? undefined });
    if (!response.ok) throw new Error(`Could not download the image from Opper (${response.status})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    return checkedImage(bytes.toString('base64'), response.headers.get('content-type') ?? undefined);
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
    });
}

/**
 * The image in an Opper function answer. It comes as base64 or a data: URI in `data.image`, a URL,
 * or - for slow models - not yet: `meta.status` "pending" with an operation to poll at
 * /v3/artifacts/{id}/status until it has a download URL (how the Opper SDK waits for media).
 */
export async function imageFromResponse(parsed: any, settings: OpperSettings, signal?: AbortSignal | null): Promise<{ base64: string; mimeType: string }> {
    const data = parsed?.data ?? {};
    const candidate: unknown = data.image ?? data.images?.[0]?.image ?? data.images?.[0] ?? data.url ?? data.image_url;
    if (typeof candidate === 'string' && candidate) {
        if (/^https?:\/\//i.test(candidate)) return download(candidate, signal);
        const match = /^data:([^;]+);base64,(.*)$/s.exec(candidate);
        return checkedImage(match ? match[2] : candidate, match?.[1] ?? data.mime_type);
    }

    const pending = parsed?.meta?.status === 'pending' ? parsed?.meta?.pending_operations?.[0] : null;
    if (pending?.id) {
        const started = Date.now();
        while (Date.now() - started < ARTIFACT_TIMEOUT_MS) {
            await sleep(ARTIFACT_POLL_MS, signal);
            const response = await fetch(`${OPPER_BASE_URL}/v3/artifacts/${encodeURIComponent(pending.id)}/status`, {
                headers: { Authorization: `Bearer ${settings.apiKey}` },
                signal: signal ?? undefined,
            });
            const status: any = await response.json().catch(() => null);
            if (status?.status === 'completed' && status.url) return download(status.url, signal);
            if (status?.status === 'failed') throw new Error(`Opper could not make the image: ${status.error || 'generation failed'}`);
        }
        throw new Error('Opper took more than 5 minutes to make the image');
    }

    // Say what did come back, so the problem can be traced
    const fields = Object.keys(data).join(', ') || 'none';
    throw new Error(`Opper returned no image (data fields: ${fields}${parsed?.meta?.status ? `, status: ${parsed.meta.status}` : ''})`);
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
    /** Failures of this route's provider on the user's account, when there were any */
    failure?: ProviderFailure;
    /**
     * `pooled` from the listing: true when Opper serves the route with its own provider accounts.
     * False means it only works after the user connects that provider (eg: Azure) in Opper.
     */
    pooled?: boolean;
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
            ...(typeof entry?.pooled === 'boolean' ? { pooled: entry.pooled } : {}),
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
        for (const model of result.value) {
            const known = merged.get(model.id);
            merged.set(model.id, known ? mergeModelEntries(known, model) : model);
        }
    });
    if (!merged.size && lastError) throw lastError;
    // The general listing holds the routes Opper serves itself. The dedicated one can also list
    // routes that need the user's own provider account (eg: "azure:global/gpt-image-2" fails with
    // "provider azure is not configured"), so keep those only when they say they are pooled.
    // Only trusted when it answered with models - an empty or failed general listing filters nothing
    const general = results[1].status === 'fulfilled' && results[1].value.length ? new Set(results[1].value.map((model) => model.id)) : null;
    return [...merged.values()]
        .filter((model) => model.pooled !== false && (!general || general.has(model.id) || model.pooled === true))
        .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * One model listed by both image listings: keep what either one says. The dedicated image listing
 * can leave out details (eg: capabilities, so no model showed "Edit") that the general one has.
 */
export function mergeModelEntries(a: OpperModel, b: OpperModel): OpperModel {
    const metaA = a.meta;
    const metaB = b.meta;
    let meta = metaA ?? metaB ?? null;
    if (metaA && metaB) {
        const pick = <T,>(x: T | undefined, y: T | undefined) => (x !== undefined && x !== null && x !== '' ? x : y);
        meta = {
            maker: pick(metaA.maker, metaB.maker),
            host: pick(metaA.host, metaB.host),
            region: pick(metaA.region, metaB.region),
            capabilities: [...new Set([...metaA.capabilities, ...metaB.capabilities])],
            speed: pick(metaA.speed, metaB.speed),
            quality: pick(metaA.quality, metaB.quality),
            contextWindow: pick(metaA.contextWindow, metaB.contextWindow),
            maxImageSide: Math.max(metaA.maxImageSide ?? 0, metaB.maxImageSide ?? 0) || undefined,
            imageSizes: metaA.imageSizes?.length ? metaA.imageSizes : metaB.imageSizes,
            privacy: Object.fromEntries(
                [...new Set([...Object.keys(metaA.privacy), ...Object.keys(metaB.privacy)])]
                    .map((key) => [key, pick((metaA.privacy as any)[key], (metaB.privacy as any)[key])]),
            ) as OpperModelMeta['privacy'],
        };
    }
    return {
        ...a,
        name: a.name && a.name !== a.id ? a.name : b.name,
        provider: a.provider || b.provider,
        price: a.price ?? b.price,
        aliases: [...new Set([...(a.aliases ?? []), ...(b.aliases ?? [])])],
        meta,
        ...(a.pooled !== undefined || b.pooled !== undefined ? { pooled: a.pooled === false || b.pooled === false ? false : true } : {}),
    };
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
export async function listOpperImageModels(apiKey?: string): Promise<OpperModel[]> {
    const [models, failures] = await Promise.all([
        cachedListing(`image:${apiKey?.trim() ?? ''}`, () => fetchOpperImageModels(apiKey)),
        providerFailures(),
    ]);
    if (!Object.keys(failures).length) return models;
    // Routes whose provider failed are marked and listed last (stable, so the rest keeps its order)
    const marked = models.map((model) => {
        const failure = failures[routeProvider(model.id)];
        return failure ? { ...model, failure } : model;
    });
    return [...marked.filter((model) => !model.failure), ...marked.filter((model) => model.failure)];
}

export function listOpperChatModels(apiKey?: string): Promise<Map<string, OpperModel>> {
    return cachedListing(`chat:${apiKey?.trim() ?? ''}`, () => fetchOpperChatModels(apiKey));
}

/** Whether a base URL points at Opper (eg: an OpenAI-compatible connection to api.opper.ai) */
export function isOpperUrl(url?: string | null): boolean {
    return typeof url === 'string' && /(^|\/\/|\.)opper\.ai(\/|:|$)/i.test(url.trim());
}
