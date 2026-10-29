import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { ArrowLeft } from 'phosphor-react-native';
import { useTranslation } from 'react-i18next';
import { contextLabel, formatOpperPrice, regionLabel, resolutionLabel, traits, type OpperModel, type OpperModelKind } from '@/utils/opper';
import { ModelBadges } from './Badges';

type Tone = 'ok' | 'warn' | 'unknown' | undefined;
const TONE_COLORS: Record<Exclude<Tone, undefined>, string> = { ok: '#86efac', warn: '#f87171', unknown: '#fcd34d' };

function Fact({ label, value, tone }: { label: string; value?: string | null; tone?: Tone }) {
    if (!value) return null;
    return (
        <View className="flex flex-row justify-between" style={{ gap: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#2f3033' }}>
            <Text style={{ color: '#9F9FA0', fontSize: 13.5 }}>{label}</Text>
            <Text style={{ color: tone ? TONE_COLORS[tone] : '#FFF', fontSize: 13.5, fontWeight: '500', textAlign: 'right', flexShrink: 1 }}>{value}</Text>
        </View>
    );
}

/**
 * Everything Opper's listing says about one route: where it runs, how your data is handled, and
 * what it can do and costs. Values Opper reports as unknown are shown as such, never guessed.
 */
export default function OpperModelInfo({ model, kind, onBack }: { model: OpperModel; kind: OpperModelKind; onBack: () => void }) {
    const { t } = useTranslation();
    const meta = model.meta;
    const privacy = meta?.privacy ?? {};
    const yesNo = (value?: boolean) => (value === undefined ? null : value ? t('opper_models.info.available') : t('opper_models.info.not_available'));
    const known = (value?: string) => (value && value !== 'unknown' ? value : undefined);

    const logging = privacy.logging === 'none'
        ? { value: t('opper_models.info.none'), tone: 'ok' as Tone }
        : privacy.logging === 'abuse_monitoring'
            ? { value: t('opper_models.info.abuse_monitoring'), tone: undefined }
            : { value: privacy.logging ? (known(privacy.logging) ?? t('opper_models.info.unknown')) : null, tone: privacy.logging === 'unknown' ? 'unknown' as Tone : undefined };
    const storage = privacy.contentStorage === 'ephemeral'
        ? { value: t('opper_models.info.not_stored'), tone: 'ok' as Tone }
        : privacy.contentStorage === 'retained'
            ? {
                value: privacy.retentionDays ? t('opper_models.info.stored_days', { count: privacy.retentionDays }) : t('opper_models.info.stored'),
                tone: undefined,
            }
            : { value: privacy.contentStorage ? t('opper_models.info.unknown') : null, tone: 'unknown' as Tone };
    const transfer = privacy.transferMechanism === 'eu_resident'
        ? t('opper_models.info.stays_in_eu')
        : privacy.transferMechanism === 'sccs'
            ? t('opper_models.info.sccs')
            : known(privacy.transferMechanism);
    const location = [privacy.country, regionLabel(meta?.region)].filter(Boolean).join(' · ') || privacy.inferenceLocation;
    const size = kind === 'image'
        ? (meta?.maxImageSide ? `${resolutionLabel(meta.maxImageSide) ?? ''} (${meta.maxImageSide}px)`.trim() : null)
        : (meta?.contextWindow ? t('opper_models.info.context_tokens', { size: contextLabel(meta.contextWindow) }) : null);

    return (
        <View className="flex-1 w-full" style={{ gap: 12 }}>
            <View className="flex flex-row items-center px-5" style={{ gap: 12 }}>
                <TouchableOpacity onPress={onBack} hitSlop={10} accessibilityLabel={t('common.back')}>
                    <ArrowLeft size={22} color="white" weight="bold" />
                </TouchableOpacity>
                <Text className="text-white text-lg font-semibold flex-1" numberOfLines={1}>{model.name}</Text>
            </View>
            <BottomSheetScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 100 }}>
                <Text style={{ color: '#9F9FA0', fontSize: 12 }} selectable>{model.id}</Text>
                <ModelBadges meta={meta} kind={kind} />
                <View style={{ marginTop: 12 }}>
                    <Fact label={t('opper_models.info.maker')} value={meta?.maker} />
                    <Fact label={t('opper_models.info.route')} value={[meta?.host, privacy.routeId].filter(Boolean).join(' · ')} />
                    <Fact label={t('opper_models.info.runs_in')} value={location} />
                    <Fact
                        label={t('opper_models.info.training')}
                        value={privacy.training ? (meta && traits.trains(meta) ? t('opper_models.info.yes') : t('opper_models.info.no')) : null}
                        tone={meta && traits.trains(meta) ? 'warn' : 'ok'}
                    />
                    <Fact label={t('opper_models.info.logging')} value={logging.value} tone={logging.tone} />
                    <Fact label={t('opper_models.info.storage')} value={storage.value} tone={storage.tone} />
                    <Fact label={t('opper_models.info.moderation')} value={known(privacy.moderation)} />
                    <Fact label={t('opper_models.info.transfer')} value={transfer} />
                    <Fact label={t('opper_models.info.dpa')} value={yesNo(privacy.dpa)} tone={privacy.dpa ? 'ok' : undefined} />
                    <Fact label={kind === 'image' ? t('opper_models.info.max_size') : t('opper_models.info.context')} value={size} />
                    <Fact label={t('opper_models.info.price')} value={formatOpperPrice(model.price)} />
                </View>
            </BottomSheetScrollView>
        </View>
    );
}
