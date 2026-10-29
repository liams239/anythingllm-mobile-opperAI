/**
 * What an Opper model can do and how it treats your data, read from its listing entry
 * (GET /v3/models). Feeds the badges, filters and info sheet of the model pickers.
 *
 * Every route of a model is its own entry (eg: Claude Sonnet 5 via Anthropic in the US and via
 * AWS in the EU), so all of this is per route.
 */

export type OpperModelMeta = {
    /** Who made the model eg: "Anthropic" */
    maker?: string;
    /** Who serves this route eg: "AWS" */
    host?: string;
    /** "EU", "US", "GLOBAL", ... */
    region?: string;
    capabilities: string[];
    /** "very_fast", "fast", "medium", "slow" */
    speed?: string;
    /** "good", "great", "best" */
    quality?: string;
    contextWindow?: number;
    /** Largest image side in pixels the model offers (image models) */
    maxImageSide?: number;
    privacy: {
        /** "no" when the provider does not train on your data */
        training?: string;
        /** "none" or eg "abuse_monitoring" */
        logging?: string;
        /** "ephemeral", "retained" or "unknown" */
        contentStorage?: string;
        retentionDays?: number;
        moderation?: string;
        /** eg "eu_resident", "sccs" */
        transferMechanism?: string;
        dpa?: boolean;
        /** Country or region the model runs in eg "SE", "US" */
        inferenceLocation?: string;
        country?: string;
        routeId?: string;
    };
};

const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** Largest side out of sizes like "2048x2048" or "3840x2160" ("auto" and the like are skipped) */
function largestSide(sizes: unknown): number | undefined {
    if (!Array.isArray(sizes)) return undefined;
    let largest = 0;
    for (const size of sizes) {
        const match = /^(\d+)\s*x\s*(\d+)$/i.exec(String(size));
        if (match) largest = Math.max(largest, Number(match[1]), Number(match[2]));
    }
    return largest || undefined;
}

export function parseOpperMeta(entry: any): OpperModelMeta {
    const compliance = entry?.compliance ?? {};
    return {
        maker: str(entry?.maker?.display_name) ?? str(entry?.maker?.slug),
        host: str(entry?.provider?.display_name) ?? str(entry?.provider?.slug) ?? str(entry?.provider),
        region: (str(entry?.region) ?? str(compliance.residency))?.toUpperCase(),
        capabilities: Array.isArray(entry?.capabilities) ? entry.capabilities.filter((c: unknown): c is string => typeof c === 'string') : [],
        speed: str(entry?.speed),
        quality: str(entry?.quality),
        contextWindow: num(entry?.context_window) || undefined,
        maxImageSide: largestSide(entry?.params?.image?.sizes),
        privacy: {
            training: str(compliance.training),
            logging: str(compliance.logging),
            contentStorage: str(compliance.content_storage),
            retentionDays: num(compliance.retention_days),
            moderation: str(compliance.moderation),
            transferMechanism: str(compliance.transfer_mechanism),
            dpa: typeof compliance.dpa_available === 'boolean' ? compliance.dpa_available : undefined,
            inferenceLocation: str(compliance.inference_location),
            country: str(compliance.country),
            routeId: str(compliance.route_id) ?? str(entry?.service_route?.id),
        },
    };
}

/** Traits shown as badges and used as filters */
export const traits = {
    canEdit: (meta: OpperModelMeta) => meta.capabilities.includes('image_edit'),
    vision: (meta: OpperModelMeta) => meta.capabilities.includes('vision'),
    pdf: (meta: OpperModelMeta) => meta.capabilities.includes('pdf'),
    reasoning: (meta: OpperModelMeta) => meta.capabilities.includes('reasoning') || meta.capabilities.includes('thinking'),
    structured: (meta: OpperModelMeta) => meta.capabilities.includes('structured_output'),
    fast: (meta: OpperModelMeta) => meta.speed === 'fast' || meta.speed === 'very_fast',
    veryFast: (meta: OpperModelMeta) => meta.speed === 'very_fast',
    best: (meta: OpperModelMeta) => meta.quality === 'best',
    noLogging: (meta: OpperModelMeta) => meta.privacy.logging === 'none',
    /** No logging and nothing stored - "unknown" storage does not count */
    zdr: (meta: OpperModelMeta) => meta.privacy.logging === 'none' && meta.privacy.contentStorage === 'ephemeral',
    /** Only when the listing says so - a missing field is not taken as training */
    trains: (meta: OpperModelMeta) => !!meta.privacy.training && meta.privacy.training !== 'no',
    dpa: (meta: OpperModelMeta) => meta.privacy.dpa === true,
};

/** "1M", "200K" */
export function contextLabel(tokens?: number): string | null {
    if (!tokens) return null;
    if (tokens >= 950_000) return `${Math.round(tokens / 1_000_000)}M`;
    return `${Math.round(tokens / 1_000)}K`;
}

/** "4K", "3K", "2K", "1K" from the largest image side */
export function resolutionLabel(side?: number): string | null {
    if (!side) return null;
    if (side >= 3500) return '4K';
    if (side >= 2800) return '3K';
    if (side >= 1900) return '2K';
    if (side >= 900) return '1K';
    return null;
}

/** "EU", "US", "Global" */
export function regionLabel(region?: string): string | null {
    if (!region) return null;
    return region === 'GLOBAL' ? 'Global' : region;
}
