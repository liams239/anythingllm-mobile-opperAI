import { type IGeneratedImageAction } from "@/database/models/WorkspaceChat";
import { saveGeneratedDocument } from "@/utils/fs/generatedDocuments";
import { generateOpperImage, getOpperSettings, hasOpperApiKey, imageExtension, listOpperImageModels, markProviderUnavailable, traits, unconfiguredProvider } from "@/utils/opper";
import { setPreviousImagePath, sourceImage } from "@/utils/opper/imageSources";
import { parseToolArgs, type StreamEmitter } from "../createFiles/shared";
import { type ToolExecutionContext } from "@/utils/ToolsManager";
import i18n from "@/i18n";

type Args = { prompt: string; size?: string; source?: 'none' | 'attached' | 'previous'; attached_index?: number };

const SIZES = ['1024x1024', '1536x1024', '1024x1536'] as const;

/**
 * Hands image requests to an image model on Opper so the user can mix normal chat and image
 * generation in one thread, whatever LLM they chat with. It can also edit an image: a photo
 * attached to the prompt or the last image generated in the thread, sent as the reference image.
 * The result is saved to the generated-documents folder and shown inline under the reply as a
 * `generated_image` action.
 */
export default {
    id: 'generateImage',
    get name() { return i18n.t('tools.generate_image.name'); },
    get description() { return i18n.t('tools.generate_image.description'); },
    defaultEnabled: false,
    category: 'default',
    supportsOnDevice: true,
    // Image requests rarely name the tool ("make this garden flatter"), so it is never narrowed away
    alwaysOffer: true,
    requestPermission: hasOpperApiKey,
    get permissionDeniedMessage() { return i18n.t('tools.generate_image.needs_api_key'); },
    definition: {
        type: 'function',
        function: {
            name: 'generate_image',
            description:
                'Create or edit an image and show it to the user in the chat. ' +
                'Use this whenever the user asks to create, draw, design, visualize, change, edit or restyle an image - ' +
                'including "show me how this would look if...". ' +
                'To change a photo the user sent in this chat (the most recent one, also from an earlier message) set source to "attached"; to change the last image you made set source to "previous". ' +
                'Write the prompt in English: for a new image a detailed visual description (subject, style, composition, colors, lighting), ' +
                'for an edit the changes to make and what must stay the same.',
            parameters: {
                type: 'object',
                properties: {
                    prompt: {
                        type: 'string',
                        description: 'For a new image: what to draw. For an edit: what to change and what to keep.',
                    },
                    source: {
                        type: 'string',
                        enum: ['none', 'attached', 'previous'],
                        description: 'Image to edit: "attached" (the photos the user sent most recently in this chat), "previous" (the last image generated in this chat) or "none" for a new image (default).',
                    },
                    attached_index: {
                        type: 'number',
                        description: 'With source "attached": which of those photos to edit, 0 for the first (default).',
                    },
                    size: {
                        type: 'string',
                        enum: SIZES,
                        description: 'Optional image size: square 1024x1024 (default), landscape 1536x1024 or portrait 1024x1536.',
                    },
                },
                required: ['prompt'],
            },
        },
    },
    config: {},
    execute: async function (args: unknown, streamEmitter: StreamEmitter, context?: ToolExecutionContext): Promise<string> {
        try {
            const { prompt, size, source = 'none', attached_index: attachedIndex = 0 } = parseToolArgs<Args>(args, { prompt: '' });
            const description = String(prompt ?? '').trim();
            if (!description) return 'No image description provided. No image was generated.';

            const settings = await getOpperSettings();
            if (!settings?.apiKey) return 'Image generation is not set up: the user has to add an Opper API key in Settings > Image generation. Tell them so.';

            let reference: { base64: string } | null = null;
            if (source === 'attached' || source === 'previous') {
                reference = await sourceImage(source, Number(attachedIndex) || 0);
                if (!reference) {
                    return source === 'attached'
                        ? 'No photo has been sent in this chat, so there is nothing to edit. Ask the user to attach the photo, or generate a new image instead.'
                        : 'There is no earlier generated image in this chat to edit. Generate a new image instead.';
                }
                // A picked model that cannot edit would ignore the photo - say so instead of drawing something unrelated
                if (settings.model) {
                    const picked = (await listOpperImageModels(settings.apiKey).catch(() => [])).find((m) => m.id === settings.model);
                    if (picked?.meta && !traits.canEdit(picked.meta)) {
                        return `The selected image model (${picked.name}) cannot edit images. Tell the user to pick a model marked "Edit" in the image model list, or offer to generate a new image from a description instead.`;
                    }
                }
            }

            streamEmitter('report_status', i18n.t(reference ? 'tools.generate_image.status_editing' : 'tools.generate_image.status_generating'));
            const request = {
                prompt: description,
                referenceImage: reference?.base64,
                size: size && (SIZES as readonly string[]).includes(size) ? size : undefined,
            };
            let fallbackNote = '';
            let image;
            try {
                image = await generateOpperImage({ ...request, settings, signal: context?.signal });
            } catch (error) {
                // The picked route's provider is not set up on this Opper account: remember that (its
                // routes leave the list) and make the image with Opper's default model right away
                const provider = error instanceof Error && settings.model ? unconfiguredProvider(error.message) : null;
                if (!provider) throw error;
                await markProviderUnavailable(provider).catch(() => null);
                image = await generateOpperImage({ ...request, settings: { ...settings, model: '' }, signal: context?.signal });
                fallbackNote = ` Note: the selected image model (${settings.model}) is not available on the user's Opper account, so Opper's default model was used. Mention this briefly and suggest picking another model in the model chip.`;
            }

            const extension = imageExtension(image.mimeType);
            const saved = await saveGeneratedDocument({
                fileType: 'image',
                extension,
                displayFilename: `image.${extension}`,
                content: image.base64,
                encoding: 'base64',
            });
            const action: IGeneratedImageAction = {
                type: 'generated_image',
                action: {
                    prompt: description,
                    storageFilename: saved.storageFilename,
                    fileSize: saved.fileSize,
                    mimeType: image.mimeType,
                    ...(image.model ? { model: image.model } : {}),
                    ...(image.cost !== undefined ? { cost: image.cost } : {}),
                },
            };
            streamEmitter('report_action', action);
            // A follow-up "now make it at night" in the same turn edits this one
            setPreviousImagePath(saved.path);
            streamEmitter('report_status', i18n.t('tools.generate_image.status_generated'));
            return 'The image was generated and is already shown to the user under your reply. Do not add image links or markdown images; briefly describe what you made or ask if they want changes.' + fallbackNote;
        } catch (e) {
            if (context?.signal?.aborted) return 'Image generation was stopped by the user.';
            // A route that needs the user's own provider account in Opper (eg: an Azure route)
            if (e instanceof Error && /not available|not configured/i.test(e.message)) {
                return `The selected image model cannot be used with this Opper account (${e.message}). Tell the user to pick another image model in the model chip, eg one marked "Edit" for editing photos, and do not retry with the same model.`;
            }
            console.error(`Generate Image Error: ${e instanceof Error ? e.message : 'Unknown error'}`);
            return `There was an error generating the image: ${e instanceof Error ? e.message : 'Unknown error'}`;
        }
    },
} as const;
