import { memo, type ReactNode, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Image, Platform, Text, TouchableOpacity, View } from "react-native";
import { DownloadSimple, ImageBroken, ShareNetwork } from "phosphor-react-native";
import { useTranslation } from "react-i18next";
import { type IAgentAction, type IGeneratedImageAction } from "@/database/models/WorkspaceChat";
import { ImageLightbox } from "@/components/ImageAttachmentGrid";
import { generatedDocumentExists, generatedDocumentPath } from "@/utils/fs/generatedDocuments";
import { copyToDeviceDownloads, shareDeviceFile } from "@/utils/fs/deviceDownloads";
import { imageExtension } from "@/utils/opper";
import { showToast } from "@/utils/Notification";

/**
 * Images the assistant generated this turn (see the generate-image tool), shown inline under
 * the reply. The file lives in the generated-documents folder, so like `FileDownloadCard` the
 * card checks it is still there and shows a muted state once "Clear temporary files" removed it.
 */
export default memo(function GeneratedImageCards({ actions = [], isLoading = false }: { actions?: IAgentAction[]; isLoading?: boolean }) {
    // Held until the turn completes so the streaming text does not keep pushing it down - same as file cards.
    if (isLoading) return null;
    const images = actions.filter((action): action is IGeneratedImageAction => action.type === 'generated_image');
    if (images.length === 0) return null;
    return (
        <View style={{ width: '100%', gap: 8 }}>
            {images.map((action, index) => <GeneratedImageCard key={`${action.action.storageFilename}-${index}`} action={action} />)}
        </View>
    );
});

const COLORS = {
    /** zinc-800 - same surface as the file download card */
    card: '#27272A',
    /** zinc-600 */
    buttonBorder: '#52525B',
    text: '#FFFFFF',
    muted: '#A1A1AA',
} as const;

const IMAGE_SIZE = 260;

function GeneratedImageCard({ action }: { action: IGeneratedImageAction }) {
    const { t } = useTranslation();
    const { prompt, storageFilename, mimeType } = action.action;
    const path = generatedDocumentPath(storageFilename);
    const filename = `anythingllm-image-${storageFilename.slice(6, 14)}.${imageExtension(mimeType)}`;
    const [status, setStatus] = useState<'checking' | 'ready' | 'missing'>('checking');
    const [busy, setBusy] = useState(false);
    const [lightboxOpen, setLightboxOpen] = useState(false);
    const lightboxImages = useMemo(() => path ? [{ name: filename, mime: mimeType, contentString: `file://${path}` }] : [], [path, filename, mimeType]);

    useEffect(() => {
        let cancelled = false;
        generatedDocumentExists(storageFilename).then((exists) => {
            if (!cancelled) setStatus(exists ? 'ready' : 'missing');
        });
        return () => { cancelled = true; };
    }, [storageFilename]);

    async function withFile(run: (sourcePath: string) => Promise<void>) {
        if (busy || !path) return;
        if (!(await generatedDocumentExists(storageFilename))) return setStatus('missing');
        setBusy(true);
        try {
            await run(path);
        } catch (error: any) {
            console.error('[GeneratedImageCard] save/share failed', error);
            showToast(t('chat.file_download.save_failed', { error: error?.message ?? t('chat.unknown_error') }), 'long');
        } finally {
            setBusy(false);
        }
    }

    const handleSave = () => withFile(async (sourcePath) => {
        if (Platform.OS === 'android') {
            const saved = await copyToDeviceDownloads({ filename, sourcePath });
            showToast(t('chat.file_download.saved_to', { filename: saved.filename, location: saved.locationLabel }));
        } else {
            await shareDeviceFile({ path: sourcePath, filename, mimeType });
        }
    });
    const handleShare = () => withFile(async (sourcePath) => { await shareDeviceFile({ path: sourcePath, filename, mimeType }); });

    if (status === 'missing' || !path) {
        return (
            <View style={{ backgroundColor: COLORS.card, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, gap: 10, opacity: 0.65 }} className="flex flex-row items-center">
                <ImageBroken size={20} color={COLORS.muted} />
                <Text style={{ color: COLORS.muted, fontSize: 13, flex: 1 }} numberOfLines={2}>{t('chat.generated_image.missing')}</Text>
            </View>
        );
    }

    return (
        <View style={{ gap: 6, alignSelf: 'flex-start' }}>
            <TouchableOpacity
                activeOpacity={0.85}
                onPress={() => setLightboxOpen(true)}
                accessibilityRole="imagebutton"
                accessibilityLabel={t('chat.generated_image.open_label', { prompt })}
                style={{ width: IMAGE_SIZE, height: IMAGE_SIZE, borderRadius: 12, overflow: 'hidden', backgroundColor: COLORS.card }}
                className="flex items-center justify-center">
                {status === 'checking'
                    ? <ActivityIndicator color={COLORS.muted} />
                    : <Image source={{ uri: `file://${path}` }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />}
            </TouchableOpacity>
            <View style={{ gap: 6 }} className="flex flex-row items-center">
                <IconButton onPress={handleSave} disabled={busy || status !== 'ready'} label={t('common.download')} icon={<DownloadSimple size={16} color={COLORS.text} weight="bold" />} />
                {Platform.OS === 'android' && (
                    <IconButton onPress={handleShare} disabled={busy || status !== 'ready'} label={t('chat.generated_image.share')} icon={<ShareNetwork size={16} color={COLORS.text} weight="bold" />} />
                )}
                {busy && <ActivityIndicator size="small" color={COLORS.text} />}
            </View>
            <ImageLightbox images={lightboxImages} index={lightboxOpen ? 0 : null} onClose={() => setLightboxOpen(false)} />
        </View>
    );
}

function IconButton({ onPress, disabled, label, icon }: { onPress: () => void; disabled: boolean; label: string; icon: ReactNode }) {
    return (
        <TouchableOpacity
            onPress={onPress}
            disabled={disabled}
            activeOpacity={0.7}
            accessibilityLabel={label}
            style={{ gap: 6, paddingHorizontal: 12, height: 34, borderRadius: 8, borderWidth: 1, borderColor: COLORS.buttonBorder, opacity: disabled ? 0.6 : 1 }}
            className="flex flex-row items-center justify-center">
            {icon}
            <Text style={{ color: COLORS.text, fontSize: 13, fontWeight: '500' }}>{label}</Text>
        </TouchableOpacity>
    );
}
