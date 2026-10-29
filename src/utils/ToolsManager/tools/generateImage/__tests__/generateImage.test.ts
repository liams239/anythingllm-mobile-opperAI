/**
 * The generate-image tool against a mocked Opper endpoint: request shape, saving the image and
 * reporting it to the chat as a `generated_image` action, and the missing-key / error paths.
 */
const mockKeychain: { value: { username: string; password: string } | null } = { value: null };
const mockFiles = new Map<string, { content: string; encoding: string }>();

jest.mock('react-native-keychain', () => ({
    ACCESSIBLE: { AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY' },
    setGenericPassword: async (username: string, password: string) => {
        mockKeychain.value = { username, password };
        return true;
    },
    getGenericPassword: async () => mockKeychain.value ?? false,
    resetGenericPassword: async () => {
        mockKeychain.value = null;
        return true;
    },
}));
jest.mock('@dr.pogodin/react-native-fs', () => ({
    DocumentDirectoryPath: '/docs',
    exists: async () => true,
    mkdir: async () => undefined,
    writeFile: async (path: string, content: string, encoding: string) => { mockFiles.set(path, { content, encoding }); },
    stat: async (path: string) => ({ size: mockFiles.get(path)?.content.length ?? 0 }),
}));
let mockUuid = 0;
jest.mock('@/utils/constants', () => ({ generateUUID: () => `00000000-0000-4000-8000-${String(++mockUuid).padStart(12, '0')}` }));
jest.mock('@/i18n', () => ({ __esModule: true, default: { t: (key: string) => key } }));
jest.mock('@/utils/ToolsManager', () => ({}));
jest.mock('@/store/UIStore', () => ({ __esModule: true, default: { getFromStorage: async (_key: string, fallback: any) => fallback, setToStorage: async () => undefined } }));

import generateImage from '../index';
import { clearOpperSettings, saveOpperSettings } from '@/utils/opper';

const fetchMock = jest.fn();
global.fetch = fetchMock as any;

function okResponse(body: any) {
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

beforeEach(async () => {
    fetchMock.mockReset();
    mockFiles.clear();
    await clearOpperSettings();
});

test('asks for an API key when none is saved', async () => {
    const emitter = jest.fn();
    const result = await generateImage.execute(JSON.stringify({ prompt: 'a cat' }), emitter);
    expect(result).toMatch(/Opper API key/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await generateImage.requestPermission()).toBe(false);
});

test('generates, saves and reports the image', async () => {
    await saveOpperSettings({ apiKey: ' op-key ', model: 'openai/gpt-image-1' });
    expect(await generateImage.requestPermission()).toBe(true);
    fetchMock.mockResolvedValue(okResponse({ data: { image: 'aGVsbG8=', mime_type: 'image/jpeg' }, meta: { cost: 0.042, models_used: ['openai/gpt-image-1'] } }));

    const emitter = jest.fn();
    const result = await generateImage.execute({ prompt: 'a cat on a bike', size: '1536x1024' }, emitter);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.opper.ai/v3/functions/image-gen/call');
    expect(init.headers.Authorization).toBe('Bearer op-key');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('openai/gpt-image-1');
    expect(body.input).toEqual({ description: 'a cat on a bike', size: '1536x1024' });
    expect(body.output_schema.required).toEqual(['image', 'mime_type']);

    const [[savedPath, saved]] = [...mockFiles.entries()];
    expect(savedPath).toMatch(/^\/docs\/generated-documents\/image-[a-f0-9-]{36}\.jpg$/);
    expect(saved).toEqual({ content: 'aGVsbG8=', encoding: 'base64' });

    const action = emitter.mock.calls.find(([event]) => event === 'report_action')?.[1];
    expect(action).toMatchObject({
        type: 'generated_image',
        action: { prompt: 'a cat on a bike', mimeType: 'image/jpeg', storageFilename: savedPath.split('/').pop(), cost: 0.042, model: 'openai/gpt-image-1' },
    });
    expect(result).toMatch(/already shown to the user/);
});

test('omits model and unknown sizes so Opper picks its defaults', async () => {
    await saveOpperSettings({ apiKey: 'op-key', model: '' });
    fetchMock.mockResolvedValue(okResponse({ data: { image: 'data:image/png;base64,aGk=' } }));

    await generateImage.execute({ prompt: 'a tree', size: '9x9' }, jest.fn());

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBeUndefined();
    expect(body.input).toEqual({ description: 'a tree' });
    const [[savedPath, saved]] = [...mockFiles.entries()];
    expect(savedPath).toMatch(/\.png$/);
    expect(saved.content).toBe('aGk=');
});

test('returns the Opper error to the model instead of throwing', async () => {
    await saveOpperSettings({ apiKey: 'bad', model: '' });
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => JSON.stringify({ error: { message: 'Invalid API key' } }) });

    const emitter = jest.fn();
    const result = await generateImage.execute({ prompt: 'a cat' }, emitter);

    expect(result).toBe('There was an error generating the image: Opper error 401: Invalid API key');
    expect(emitter).not.toHaveBeenCalledWith('report_action', expect.anything());
});
