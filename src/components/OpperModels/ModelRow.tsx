import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { Check, Info } from 'phosphor-react-native';
import { useTranslation } from 'react-i18next';
import { formatOpperPrice, type OpperModel, type OpperModelKind } from '@/utils/opper';
import { ModelBadges } from './Badges';

/**
 * One row in an Opper model list: name, maker and route, price, written-out badges, and an info
 * button for the full privacy details.
 */
export default function OpperModelRow({ id, name, model, kind, selected, disabled, onPress, onInfo }: {
    id: string;
    /** Falls back to the listing's name, then the id */
    name?: string;
    /** Listing entry - missing for ids Opper's listing does not know */
    model?: OpperModel | null;
    kind: OpperModelKind;
    selected: boolean;
    disabled?: boolean;
    onPress: () => void;
    onInfo?: () => void;
}) {
    const { t } = useTranslation();
    const title = name || model?.name || id;
    const meta = model?.meta;
    const by = meta?.maker && meta.host && meta.maker !== meta.host ? t('opper_models.maker_via_host', { maker: meta.maker, host: meta.host }) : meta?.maker || meta?.host;
    const subtitle = [by, id && id !== title ? id : null].filter(Boolean).join(' · ');
    const price = formatOpperPrice(model?.price);
    return (
        <TouchableOpacity
            disabled={disabled}
            onPress={onPress}
            accessibilityState={{ selected }}
            style={{
                backgroundColor: selected ? '#2e404b' : '#2A2A2E',
                borderWidth: selected ? 2 : 0,
                borderColor: selected ? '#7cd4fd' : 'transparent',
                gap: 12,
            }}
            className="w-full p-4 rounded-xl flex-row items-start">
            <View className="flex-1" style={{ gap: 2, minWidth: 0 }}>
                <Text className="text-white text-base font-medium" numberOfLines={1}>{title}</Text>
                {!!subtitle && <Text className="text-[#9F9FA0] text-xs" numberOfLines={1} ellipsizeMode="middle">{subtitle}</Text>}
                {!!price && <Text className="text-[#7cd4fd] text-xs" numberOfLines={1}>{price}</Text>}
                <ModelBadges meta={meta} kind={kind} />
            </View>
            <View className="items-center" style={{ gap: 10 }}>
                {selected && <Check size={20} color="#7cd4fd" weight="bold" />}
                {!!meta && onInfo && (
                    <TouchableOpacity onPress={onInfo} hitSlop={10} accessibilityLabel={t('opper_models.info.open', { name: title })}>
                        <Info size={20} color="#9F9FA0" />
                    </TouchableOpacity>
                )}
            </View>
        </TouchableOpacity>
    );
}
