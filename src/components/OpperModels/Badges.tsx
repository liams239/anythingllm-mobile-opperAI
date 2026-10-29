import React from 'react';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Brain, CornersOut, Eye, FilePdf, Lightning, PencilSimple, ShieldCheck, Star, TextAlignLeft, Warning } from 'phosphor-react-native';
import { contextLabel, regionLabel, resolutionLabel, traits, type OpperModelKind, type OpperModelMeta } from '@/utils/opper';

export const BADGE_COLORS = {
    edit: '#c4b5fd',
    reasoning: '#c4b5fd',
    fast: '#fcd34d',
    best: '#86efac',
    privacy: '#86efac',
    vision: '#7cd4fd',
    pdf: '#fda4af',
    neutral: '#9F9FA0',
    warning: '#f87171',
    regionEu: '#7cd4fd',
    regionText: '#FFFFFF',
    regionBg: '#27282A',
    onAccent: '#062433',
} as const;

type Badge = {
    key: string;
    label: string;
    color: string;
    Icon?: React.ComponentType<{ size?: number; color?: string; weight?: any }>;
    /** Region chips are text-only, filled */
    region?: 'eu' | 'other';
};

/**
 * Badges for one Opper model route, most telling first: where it runs, how it treats your data,
 * then what it can do. Traits nearly every model has (text, tools) get none.
 */
export function useModelBadges(meta: OpperModelMeta | null | undefined, kind: OpperModelKind): Badge[] {
    const { t } = useTranslation();
    if (!meta) return [];
    const badges: Badge[] = [];
    const region = regionLabel(meta.region);
    if (region) badges.push({ key: 'region', label: region, color: BADGE_COLORS.regionText, region: meta.region === 'EU' ? 'eu' : 'other' });
    if (traits.trains(meta)) badges.push({ key: 'trains', label: t('opper_models.badges.trains'), color: BADGE_COLORS.warning, Icon: Warning });
    if (traits.zdr(meta)) badges.push({ key: 'zdr', label: t('opper_models.badges.zdr'), color: BADGE_COLORS.privacy, Icon: ShieldCheck });
    else if (traits.noLogging(meta)) badges.push({ key: 'no_logging', label: t('opper_models.badges.no_logging'), color: BADGE_COLORS.privacy, Icon: ShieldCheck });
    if (kind === 'image') {
        if (traits.canEdit(meta)) badges.push({ key: 'edit', label: t('opper_models.badges.edit'), color: BADGE_COLORS.edit, Icon: PencilSimple });
    } else {
        if (traits.vision(meta)) badges.push({ key: 'vision', label: t('opper_models.badges.vision'), color: BADGE_COLORS.vision, Icon: Eye });
        if (traits.pdf(meta)) badges.push({ key: 'pdf', label: t('opper_models.badges.pdf'), color: BADGE_COLORS.pdf, Icon: FilePdf });
        if (traits.reasoning(meta)) badges.push({ key: 'reasoning', label: t('opper_models.badges.reasoning'), color: BADGE_COLORS.reasoning, Icon: Brain });
    }
    if (traits.fast(meta)) {
        badges.push({ key: 'fast', label: traits.veryFast(meta) ? t('opper_models.badges.very_fast') : t('opper_models.badges.fast'), color: BADGE_COLORS.fast, Icon: Lightning });
    }
    if (traits.best(meta)) badges.push({ key: 'best', label: t('opper_models.badges.best'), color: BADGE_COLORS.best, Icon: Star });
    const size = kind === 'image' ? resolutionLabel(meta.maxImageSide) : contextLabel(meta.contextWindow);
    if (size) badges.push({ key: 'size', label: size, color: BADGE_COLORS.neutral, Icon: kind === 'image' ? CornersOut : TextAlignLeft });
    return badges;
}

function RegionChip({ badge, small }: { badge: Badge; small?: boolean }) {
    const eu = badge.region === 'eu';
    return (
        <View style={{ backgroundColor: eu ? BADGE_COLORS.regionEu : BADGE_COLORS.regionBg, borderRadius: 6, paddingHorizontal: small ? 5 : 7, paddingVertical: small ? 1 : 3 }}>
            <Text style={{ color: eu ? BADGE_COLORS.onAccent : BADGE_COLORS.regionText, fontSize: small ? 10.5 : 11.5, fontWeight: '600', letterSpacing: 0.4 }}>{badge.label}</Text>
        </View>
    );
}

/**
 * Written-out chips, for the model lists where you compare and choose.
 */
export function ModelBadges({ meta, kind }: { meta: OpperModelMeta | null | undefined; kind: OpperModelKind }) {
    const badges = useModelBadges(meta, kind);
    if (!badges.length) return null;
    return (
        <View className="flex flex-row flex-wrap" style={{ gap: 5, marginTop: 5 }}>
            {badges.map((badge) => badge.region
                ? <RegionChip key={badge.key} badge={badge} />
                : (
                    <View
                        key={badge.key}
                        className="flex flex-row items-center"
                        style={{ gap: 4, paddingLeft: 6, paddingRight: 8, paddingVertical: 3, borderRadius: 6, backgroundColor: `${badge.color}22` }}>
                        {badge.Icon && <badge.Icon size={12} color={badge.color} weight="bold" />}
                        <Text style={{ color: badge.color, fontSize: 11.5, fontWeight: '600' }}>{badge.label}</Text>
                    </View>
                ))}
        </View>
    );
}

/**
 * Icons only (region stays text), for one-line summaries of a model you already picked.
 */
export function ModelBadgeIcons({ meta, kind }: { meta: OpperModelMeta | null | undefined; kind: OpperModelKind }) {
    const badges = useModelBadges(meta, kind).filter((badge) => badge.key !== 'size');
    if (!badges.length) return null;
    return (
        <View className="flex flex-row items-center" style={{ gap: 6 }} accessibilityLabel={badges.map((b) => b.label).join(', ')}>
            {badges.map((badge) => badge.region
                ? <RegionChip key={badge.key} badge={badge} small />
                : badge.Icon && <badge.Icon key={badge.key} size={14} color={badge.color} weight="bold" />)}
        </View>
    );
}
