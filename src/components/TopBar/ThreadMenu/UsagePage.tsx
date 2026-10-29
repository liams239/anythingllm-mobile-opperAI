import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SheetHeader, MUTED_TEXT, ROW_ICON_BACKGROUND } from '@/components/SheetMenu';
import WorkspaceChat, { type WorkspaceChatType } from '@/database/models/WorkspaceChat';
import { type WorkspaceThreadType } from '@/database/models/WorkspaceThread';
import { getOpperSettings, listOpperChatModels, listOpperImageModels, type OpperModel } from '@/utils/opper';
import { formatTokens, formatUsd, startOfMonth, summarizeUsage, type UsagePrices, type UsageSummary } from '@/utils/usage';

const ACCENT = '#7cd4fd';

/**
 * Prices for the usage totals, looked up in Opper's listings (cached). Only fetched when something
 * in the chats came through Opper; without network the totals still show tokens and billed images.
 */
async function loadPrices(chats: WorkspaceChatType[]): Promise<UsagePrices> {
    const usesOpperChat = chats.some((chat) => chat.response?.usage?.opper);
    const hasImages = chats.some((chat) => chat.response?.actions?.some((action) => action.type === 'generated_image'));
    const [chatModels, imageModels] = await Promise.all([
        usesOpperChat ? listOpperChatModels().catch(() => null) : Promise.resolve(null),
        hasImages
            ? getOpperSettings().then((settings) => listOpperImageModels(settings?.apiKey)).catch(() => null)
            : Promise.resolve(null),
    ]);
    const images = new Map<string, OpperModel>((imageModels ?? []).map((model) => [model.id, model]));
    return {
        chat: (model) => chatModels?.get(model)?.price,
        image: (model) => images.get(model)?.price,
    };
}

function Block({ title, summary }: { title: string; summary: UsageSummary }) {
    const { t } = useTranslation();
    const total = summary.chatCost + summary.imageCost;
    const hasCost = total > 0;
    const nothing = !summary.replies && !summary.images;
    return (
        <View style={{ backgroundColor: ROW_ICON_BACKGROUND, borderRadius: 12, padding: 14, gap: 10 }}>
            <View className="flex flex-row items-baseline justify-between" style={{ gap: 12 }}>
                <Text style={{ color: MUTED_TEXT, fontSize: 12, fontWeight: '700', letterSpacing: 1 }}>{title.toUpperCase()}</Text>
                {hasCost && <Text style={{ color: ACCENT, fontSize: 20, fontWeight: '700', fontVariant: ['tabular-nums'] }}>≈ {formatUsd(total)}</Text>}
            </View>
            {nothing && <Text style={{ color: MUTED_TEXT, fontSize: 13 }}>{t('top_bar.thread_menu.usage.nothing_yet')}</Text>}
            {summary.replies > 0 && (
                <View style={{ gap: 2 }}>
                    <View className="flex flex-row justify-between" style={{ gap: 12 }}>
                        <Text className="text-white" style={{ fontSize: 14 }}>{t('top_bar.thread_menu.usage.replies', { count: summary.replies })}</Text>
                        {summary.chatCost > 0 && <Text className="text-white" style={{ fontSize: 14, fontVariant: ['tabular-nums'] }}>≈ {formatUsd(summary.chatCost)}</Text>}
                    </View>
                    <Text style={{ color: MUTED_TEXT, fontSize: 12.5, fontVariant: ['tabular-nums'] }}>
                        {t('top_bar.thread_menu.usage.tokens', { input: formatTokens(summary.promptTokens), output: formatTokens(summary.completionTokens) })}
                        {summary.cachedPromptTokens > 0 ? ` · ${t('top_bar.thread_menu.usage.cached', { cached: formatTokens(summary.cachedPromptTokens) })}` : ''}
                    </Text>
                </View>
            )}
            {summary.images > 0 && (
                <View className="flex flex-row justify-between" style={{ gap: 12 }}>
                    <Text className="text-white" style={{ fontSize: 14 }}>{t('top_bar.thread_menu.usage.images', { count: summary.images })}</Text>
                    {summary.imageCost > 0 && (
                        <Text className="text-white" style={{ fontSize: 14, fontVariant: ['tabular-nums'] }}>
                            {summary.imagesEstimated || summary.imagesUnpriced ? '≈ ' : ''}{formatUsd(summary.imageCost)}
                        </Text>
                    )}
                </View>
            )}
            {summary.models.length > 1 && (
                <View style={{ gap: 4, paddingTop: 4, borderTopWidth: 1, borderTopColor: '#4a4a4e' }}>
                    {summary.models.map((model) => (
                        <View key={model.model} className="flex flex-row justify-between" style={{ gap: 12 }}>
                            <Text numberOfLines={1} ellipsizeMode="middle" style={{ color: MUTED_TEXT, fontSize: 12.5, flex: 1 }}>{model.model}</Text>
                            <Text style={{ color: MUTED_TEXT, fontSize: 12.5, fontVariant: ['tabular-nums'] }}>
                                {model.cost !== null ? `≈ ${formatUsd(model.cost)}` : t('top_bar.thread_menu.usage.replies', { count: model.replies })}
                            </Text>
                        </View>
                    ))}
                </View>
            )}
        </View>
    );
}

/**
 * Thread menu > Usage: tokens and estimated cost of this chat and of all chats this month, plus
 * generated images with what Opper billed. Kept out of the chat itself on purpose.
 */
export default function UsagePage({ thread, onBack }: { thread: WorkspaceThreadType; onBack: () => void }) {
    const { t } = useTranslation();
    const [state, setState] = useState<{ thread: UsageSummary; month: UsageSummary; notes: string[] } | null>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const [threadChats, monthChats] = await Promise.all([
                WorkspaceChat.find([{ field: 'workspace_thread_slug', value: thread.slug }]),
                WorkspaceChat.createdSince(startOfMonth()),
            ]);
            const prices = await loadPrices([...threadChats, ...monthChats]);
            const threadSummary = summarizeUsage(threadChats, prices);
            const monthSummary = summarizeUsage(monthChats, prices);
            const notes: string[] = [];
            if (monthSummary.unpricedReplies) notes.push(t('top_bar.thread_menu.usage.note_unpriced'));
            if (threadSummary.untracked || monthSummary.untracked) notes.push(t('top_bar.thread_menu.usage.note_untracked'));
            if (!cancelled) setState({ thread: threadSummary, month: monthSummary, notes });
        })().catch((e) => {
            console.error('[UsagePage] could not load usage', e);
            if (!cancelled) setState({ thread: summarizeUsage([], { chat: () => null, image: () => null }), month: summarizeUsage([], { chat: () => null, image: () => null }), notes: [] });
        });
        return () => { cancelled = true; };
    }, [thread.slug, t]);

    return (
        <View>
            <SheetHeader title={t('top_bar.thread_menu.usage.title')} onBack={onBack} />
            {!state ? (
                <View style={{ paddingVertical: 32 }} className="items-center"><ActivityIndicator color="#FFF" /></View>
            ) : (
                <View style={{ gap: 12 }}>
                    <Block title={t('top_bar.thread_menu.usage.this_chat')} summary={state.thread} />
                    <Block title={t('top_bar.thread_menu.usage.this_month')} summary={state.month} />
                    <Text style={{ color: MUTED_TEXT, fontSize: 12, lineHeight: 17 }}>
                        {[t('top_bar.thread_menu.usage.note_estimate'), ...state.notes].join(' ')}
                    </Text>
                </View>
            )}
        </View>
    );
}
