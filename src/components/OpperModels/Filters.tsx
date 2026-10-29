import React from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { ArrowLeft, ShieldCheck, SlidersHorizontal } from 'phosphor-react-native';
import { useTranslation } from 'react-i18next';
import ToggleSwitch from '@/components/ToggleSwitch';
import {
    activeFilterCount, EMPTY_FILTERS, PRICE_STEPS,
    type OpperCapabilityFilter, type OpperModelFilters, type OpperModelKind,
} from '@/utils/opper';

const ACCENT = '#7cd4fd';
const ON_ACCENT = '#062433';
const FIELD = '#27282A';

function Pill({ label, on, onPress, outline }: { label: string; on?: boolean; onPress: () => void; outline?: React.ReactNode }) {
    return (
        <TouchableOpacity
            onPress={onPress}
            accessibilityState={{ selected: !!on }}
            className="flex flex-row items-center"
            style={{
                gap: 5,
                paddingHorizontal: 11,
                paddingVertical: 6,
                borderRadius: 99,
                backgroundColor: on ? ACCENT : outline ? 'transparent' : FIELD,
                borderWidth: outline ? 1 : 0,
                borderColor: '#9F9FA0',
            }}>
            {outline}
            <Text style={{ color: on ? ON_ACCENT : '#FFF', fontSize: 12.5, fontWeight: on ? '600' : '400' }}>{label}</Text>
        </TouchableOpacity>
    );
}

/** The quick filters per list - the few things people pick on most */
const QUICK: Record<OpperModelKind, Array<'eu' | 'noLogging' | OpperCapabilityFilter | 'fast' | 'best'>> = {
    chat: ['eu', 'noLogging', 'vision', 'reasoning'],
    image: ['edit', 'noLogging', 'fast', 'best'],
};

function toggleCapability(filters: OpperModelFilters, capability: OpperCapabilityFilter): OpperModelFilters {
    const has = filters.capabilities.includes(capability);
    return { ...filters, capabilities: has ? filters.capabilities.filter((c) => c !== capability) : [...filters.capabilities, capability] };
}

function capabilityLabel(t: (key: string) => string, capability: OpperCapabilityFilter) {
    return {
        edit: t('opper_models.badges.edit'),
        vision: t('opper_models.badges.vision'),
        pdf: t('opper_models.badges.pdf'),
        reasoning: t('opper_models.badges.reasoning'),
        structured: t('opper_models.filters.structured'),
    }[capability];
}

/**
 * Row above the list: a "Filters" button (with the count of active filters) and a few one-tap
 * filters. Everything else lives in the filter panel.
 */
export function QuickFilters({ kind, filters, onChange, onOpenPanel }: {
    kind: OpperModelKind;
    filters: OpperModelFilters;
    onChange: (next: OpperModelFilters) => void;
    onOpenPanel: () => void;
}) {
    const { t } = useTranslation();
    const count = activeFilterCount(filters);
    return (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 6, paddingHorizontal: 20 }} style={{ flexGrow: 0 }}>
            <Pill
                label={count ? t('opper_models.filters.button_count', { count }) : t('opper_models.filters.button')}
                onPress={onOpenPanel}
                outline={<SlidersHorizontal size={14} color="#FFF" />}
            />
            {QUICK[kind].map((item) => {
                if (item === 'eu') {
                    const on = filters.regions.length === 1 && filters.regions[0] === 'EU';
                    return <Pill key={item} label="EU" on={on} onPress={() => onChange({ ...filters, regions: on ? [] : ['EU'] })} />;
                }
                if (item === 'noLogging') return <Pill key={item} label={t('opper_models.badges.no_logging')} on={filters.noLogging} onPress={() => onChange({ ...filters, noLogging: !filters.noLogging })} />;
                if (item === 'fast') return <Pill key={item} label={t('opper_models.badges.fast')} on={filters.fast} onPress={() => onChange({ ...filters, fast: !filters.fast })} />;
                if (item === 'best') return <Pill key={item} label={t('opper_models.badges.best')} on={filters.best} onPress={() => onChange({ ...filters, best: !filters.best })} />;
                return <Pill key={item} label={capabilityLabel(t, item)} on={filters.capabilities.includes(item)} onPress={() => onChange(toggleCapability(filters, item))} />;
            })}
        </ScrollView>
    );
}

/** Green line shown when no listed model trains on your data, so there is nothing to filter */
export function NoTrainingNote() {
    const { t } = useTranslation();
    return (
        <View className="flex flex-row items-center px-5" style={{ gap: 6 }}>
            <ShieldCheck size={14} color="#86efac" weight="bold" />
            <Text style={{ color: '#86efac', fontSize: 12 }}>{t('opper_models.no_training')}</Text>
        </View>
    );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <View style={{ gap: 10 }}>
            <Text style={{ color: '#9F9FA0', fontSize: 11, fontWeight: '700', letterSpacing: 1.1 }}>{title.toUpperCase()}</Text>
            {children}
        </View>
    );
}

function ToggleRow({ label, hint, on, onToggle }: { label: string; hint?: string; on: boolean; onToggle: () => void }) {
    return (
        <TouchableOpacity onPress={onToggle} activeOpacity={0.7} className="flex flex-row items-center justify-between" style={{ gap: 12 }}>
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <Text className="text-white" style={{ fontSize: 14 }}>{label}</Text>
                {!!hint && <Text style={{ color: '#9F9FA0', fontSize: 11.5, lineHeight: 15 }}>{hint}</Text>}
            </View>
            <ToggleSwitch isOn={on} onToggle={onToggle} activeBgColor={ACCENT} />
        </TouchableOpacity>
    );
}

/**
 * Every filter, grouped: privacy, what the model can do, speed and quality, price. Shown in place
 * of the list inside the sheet; changes apply right away and the button shows how many match.
 */
export function FilterPanel({ kind, filters, onChange, matchCount, onDone }: {
    kind: OpperModelKind;
    filters: OpperModelFilters;
    onChange: (next: OpperModelFilters) => void;
    matchCount: number;
    onDone: () => void;
}) {
    const { t } = useTranslation();
    const regions = ['EU', 'US', 'GLOBAL'];
    const capabilities: OpperCapabilityFilter[] = kind === 'image' ? ['edit'] : ['vision', 'pdf', 'reasoning', 'structured'];
    const toggleRegion = (region: string) => onChange({
        ...filters,
        regions: filters.regions.includes(region) ? filters.regions.filter((r) => r !== region) : [...filters.regions, region],
    });
    const priceUnit = kind === 'image' ? t('opper_models.filters.per_image') : t('opper_models.filters.per_million');

    return (
        <View className="flex-1 w-full" style={{ gap: 12 }}>
            <View className="flex flex-row items-center px-5" style={{ gap: 12 }}>
                <TouchableOpacity onPress={onDone} hitSlop={10} accessibilityLabel={t('common.back')}>
                    <ArrowLeft size={22} color="white" weight="bold" />
                </TouchableOpacity>
                <Text className="text-white text-lg font-semibold flex-1">{t('opper_models.filters.title')}</Text>
                {activeFilterCount(filters) > 0 && (
                    <TouchableOpacity onPress={() => onChange(EMPTY_FILTERS)} hitSlop={8}>
                        <Text style={{ color: ACCENT, fontSize: 13 }}>{t('opper_models.filters.clear')}</Text>
                    </TouchableOpacity>
                )}
            </View>
            <BottomSheetScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 120, gap: 22 }}>
                <Section title={t('opper_models.filters.privacy')}>
                    <View className="flex flex-row flex-wrap" style={{ gap: 6 }}>
                        {regions.map((region) => (
                            <Pill key={region} label={region === 'GLOBAL' ? 'Global' : region} on={filters.regions.includes(region)} onPress={() => toggleRegion(region)} />
                        ))}
                    </View>
                    <ToggleRow label={t('opper_models.badges.no_logging')} hint={t('opper_models.filters.no_logging_hint')} on={filters.noLogging} onToggle={() => onChange({ ...filters, noLogging: !filters.noLogging })} />
                    <ToggleRow label={t('opper_models.filters.zdr')} hint={t('opper_models.filters.zdr_hint')} on={filters.zdr} onToggle={() => onChange({ ...filters, zdr: !filters.zdr })} />
                    <ToggleRow label={t('opper_models.filters.dpa')} hint={t('opper_models.filters.dpa_hint')} on={filters.dpa} onToggle={() => onChange({ ...filters, dpa: !filters.dpa })} />
                </Section>
                <Section title={t('opper_models.filters.can')}>
                    <View className="flex flex-row flex-wrap" style={{ gap: 6 }}>
                        {capabilities.map((capability) => (
                            <Pill key={capability} label={capabilityLabel(t, capability)} on={filters.capabilities.includes(capability)} onPress={() => onChange(toggleCapability(filters, capability))} />
                        ))}
                    </View>
                </Section>
                <Section title={t('opper_models.filters.speed_quality')}>
                    <View className="flex flex-row flex-wrap" style={{ gap: 6 }}>
                        <Pill label={t('opper_models.badges.fast')} on={filters.fast} onPress={() => onChange({ ...filters, fast: !filters.fast })} />
                        <Pill label={t('opper_models.filters.best_quality')} on={filters.best} onPress={() => onChange({ ...filters, best: !filters.best })} />
                    </View>
                </Section>
                <Section title={t('opper_models.filters.max_price', { unit: priceUnit })}>
                    <View className="flex flex-row flex-wrap" style={{ gap: 6 }}>
                        <Pill label={t('opper_models.filters.any_price')} on={filters.maxPrice === null} onPress={() => onChange({ ...filters, maxPrice: null })} />
                        {PRICE_STEPS[kind].map((step) => (
                            <Pill key={step} label={`≤ $${step}`} on={filters.maxPrice === step} onPress={() => onChange({ ...filters, maxPrice: step })} />
                        ))}
                    </View>
                </Section>
                <TouchableOpacity onPress={onDone} style={{ backgroundColor: '#FFF', borderRadius: 8, paddingVertical: 12 }} className="items-center">
                    <Text style={{ color: '#000', fontSize: 14, fontWeight: '600' }}>{t('opper_models.filters.show_count', { count: matchCount })}</Text>
                </TouchableOpacity>
            </BottomSheetScrollView>
        </View>
    );
}
