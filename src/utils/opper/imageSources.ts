import * as RNFS from '@dr.pogodin/react-native-fs';

/**
 * Images the generate-image tool may edit in the current turn: the photos attached to the prompt,
 * and the last image generated in the thread. Set by the chat handler when a turn starts (tools
 * have no access to the chat itself) and updated by the tool after each image it makes.
 */

type TurnImages = {
    /** data: URIs of the images attached to this prompt */
    attachments: Array<{ contentString: string; mime?: string }>;
    /** Absolute path of the last generated image in this thread */
    previousImagePath: string | null;
};

let current: TurnImages = { attachments: [], previousImagePath: null };

export function setTurnImages(images: TurnImages) {
    current = { attachments: images.attachments.filter((a) => typeof a?.contentString === 'string'), previousImagePath: images.previousImagePath };
}

export function setPreviousImagePath(path: string) {
    current = { ...current, previousImagePath: path };
}

export function availableImageSources(): { attached: number; previous: boolean } {
    return { attached: current.attachments.length, previous: !!current.previousImagePath };
}

function mimeFromPath(path: string): string {
    const ext = path.split('.').pop()?.toLowerCase();
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'webp') return 'image/webp';
    return 'image/png';
}

/** Base64 (no data: prefix) of the image to edit, or null when there is none */
export async function sourceImage(kind: 'attached' | 'previous', index = 0): Promise<{ base64: string; mimeType: string } | null> {
    if (kind === 'attached') {
        const attachment = current.attachments[Math.max(0, Math.min(index, current.attachments.length - 1))];
        const match = attachment ? /^data:([^;]+);base64,(.*)$/s.exec(attachment.contentString) : null;
        return match ? { base64: match[2], mimeType: match[1] } : null;
    }
    const path = current.previousImagePath;
    if (!path || !(await RNFS.exists(path).catch(() => false))) return null;
    return { base64: await RNFS.readFile(path, 'base64'), mimeType: mimeFromPath(path) };
}
