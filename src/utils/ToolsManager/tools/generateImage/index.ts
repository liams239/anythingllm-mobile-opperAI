import { type IGeneratedImageAction } from "@/database/models/WorkspaceChat";
import { saveGeneratedDocument } from "@/utils/fs/generatedDocuments";
import { generateOpperImage, getOpperSettings, hasOpperApiKey, imageExtension } from "@/utils/opper";
import { parseToolArgs, type StreamEmitter } from "../createFiles/shared";
import { type ToolExecutionContext } from "@/utils/ToolsManager";
import i18n from "@/i18n";

type Args = { prompt: string; size?: string };

const SIZES = ['1024x1024', '1536x1024', '1024x1536'] as const;

/**
 * Hands image requests to an image model on Opper so the user can mix normal chat and image
 * generation in one thread, whatever LLM they chat with. The image is saved to the
 * generated-documents folder and shown inline under the reply as a `generated_image` action.
 */
export default {
    id: 'generateImage',
    get name() { return i18n.t('tools.generate_image.name'); },
    get description() { return i18n.t('tools.generate_image.description'); },
    defaultEnabled: false,
    category: 'default',
    supportsOnDevice: true,
    requestPermission: hasOpperApiKey,
    get permissionDeniedMessage() { return i18n.t('tools.generate_image.needs_api_key'); },
    definition: {
        type: 'function',
        function: {
            name: 'generate_image',
            description:
                'Generate an image from a text description and show it to the user in the chat. ' +
                'Use this whenever the user asks to create, draw, design or visualize an image. ' +
                'Write a detailed visual description in English: subject, style, composition, colors and lighting.',
            parameters: {
                type: 'object',
                properties: {
                    prompt: {
                        type: 'string',
                        description: 'Detailed description of the image to generate.',
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
            const { prompt, size } = parseToolArgs<Args>(args, { prompt: '' });
            const description = String(prompt ?? '').trim();
            if (!description) return 'No image description provided. No image was generated.';

            const settings = await getOpperSettings();
            if (!settings?.apiKey) return 'Image generation is not set up: the user has to add an Opper API key in Settings > Image generation. Tell them so.';

            streamEmitter('report_status', i18n.t('tools.generate_image.status_generating'));
            const image = await generateOpperImage({
                prompt: description,
                size: size && (SIZES as readonly string[]).includes(size) ? size : undefined,
                settings,
                signal: context?.signal,
            });

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
            streamEmitter('report_status', i18n.t('tools.generate_image.status_generated'));
            return 'The image was generated and is already shown to the user under your reply. Do not add image links or markdown images; briefly describe what you made or ask if they want changes.';
        } catch (e) {
            if (context?.signal?.aborted) return 'Image generation was stopped by the user.';
            console.error(`Generate Image Error: ${e instanceof Error ? e.message : 'Unknown error'}`);
            return `There was an error generating the image: ${e instanceof Error ? e.message : 'Unknown error'}`;
        }
    },
} as const;
