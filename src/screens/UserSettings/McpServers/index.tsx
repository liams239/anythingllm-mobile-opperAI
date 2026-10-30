import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, ArrowsClockwise, CaretRight, Plugs, Plus, ShieldCheck, Trash, Warning } from 'phosphor-react-native';
import { useTranslation } from 'react-i18next';
import SafeView from '@/components/SafeView';
import ToggleSwitch from '@/components/ToggleSwitch';
import useHighjackBackButtonPress from '@/hooks/useHighjackBackButtonPress';
import { showToast } from '@/utils/Notification';
import { McpAuthRequiredError } from '@/utils/mcp/client';
import { McpOAuthError } from '@/utils/mcp/oauth';
import { needsApproval } from '@/utils/mcp/tools';
import {
  addServer, isSignedIn, listServers, refreshTools, removeServer, signInToServer, signOut, updateServer,
  type McpAuthKind, type McpServer,
} from '@/utils/mcp/servers';
import { IWorkspacePageKey } from '../index';

const COLORS = {
  page: '#0E0F0F',
  card: '#1B1B1E',
  field: '#27282A',
  line: '#2A2A2E',
  muted: '#9F9FA0',
  accent: '#7cd4fd',
  ok: '#86efac',
  warn: '#fcd34d',
  danger: '#F87171',
} as const;

const INPUT_STYLE = { backgroundColor: COLORS.card, color: '#FFF', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15 } as const;

type View_ = { name: 'list' } | { name: 'add' } | { name: 'server'; id: string };

/**
 * Settings > MCP servers: connect remote MCP servers (eg: Homey at https://mcp.athom.com) so their
 * tools can be used in any chat. OAuth servers sign in through the browser; others take an API key.
 */
export default function McpServers({ goToPage }: { goToPage: (page: IWorkspacePageKey) => void }) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [view, setView] = useState<View_>({ name: 'list' });
  const [servers, setServers] = useState<McpServer[] | null>(null);

  const reload = useCallback(async () => setServers(await listServers()), []);
  useEffect(() => { reload(); }, [reload]);

  const goBack = () => {
    if (view.name !== 'list') setView({ name: 'list' });
    else goToPage('main');
    return true;
  };
  useHighjackBackButtonPress(goBack);

  const title = view.name === 'add'
    ? t('mcp.add_title')
    : view.name === 'server' ? servers?.find((s) => s.id === view.id)?.name ?? '' : t('mcp.page_title');

  return (
    <SafeView scrollable={false} safeAreaClassNames="pt-[21px]" containerClassNames="flex flex-col flex-1" safeAreaStyle={{ backgroundColor: COLORS.page }}>
      <View style={{ paddingTop: insets.top, paddingBottom: 20 }} className="w-full flex flex-row items-center justify-center relative">
        <TouchableOpacity onPress={goBack} className="absolute left-0 flex flex-row items-center gap-2" accessibilityLabel={t('common.back')}>
          <ArrowLeft size={24} color="#FFF" weight="bold" />
        </TouchableOpacity>
        <Text className="text-white text-lg font-medium" numberOfLines={1} style={{ maxWidth: '75%' }}>{title}</Text>
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: insets.bottom + 24, gap: 16 }}>
        {view.name === 'list' && <ServerList servers={servers} onOpen={(id) => setView({ name: 'server', id })} onAdd={() => setView({ name: 'add' })} />}
        {view.name === 'add' && (
          <AddServer onAdded={async (id) => { await reload(); setView({ name: 'server', id }); }} />
        )}
        {view.name === 'server' && servers && (
          <ServerDetail
            server={servers.find((s) => s.id === view.id)}
            onChanged={reload}
            onRemoved={async () => { await reload(); setView({ name: 'list' }); }}
          />
        )}
      </ScrollView>
    </SafeView>
  );
}

function ServerList({ servers, onOpen, onAdd }: { servers: McpServer[] | null; onOpen: (id: string) => void; onAdd: () => void }) {
  const { t } = useTranslation();
  if (!servers) return <ActivityIndicator color="#FFF" style={{ paddingTop: 24 }} />;
  return (
    <View style={{ gap: 16 }}>
      <Text style={{ color: COLORS.muted }} className="text-sm">{t('mcp.description')}</Text>
      {servers.length > 0 && (
        <View style={{ backgroundColor: COLORS.card, borderRadius: 8 }}>
          {servers.map((server, index) => {
            const toolCount = (server.tools ?? []).filter((tool) => !server.disabledTools?.includes(tool.name)).length;
            const status = server.lastError === 'auth'
              ? { text: t('mcp.status_sign_in'), color: COLORS.warn }
              : server.lastError
                ? { text: t('mcp.status_error'), color: COLORS.danger }
                : !server.enabled
                  ? { text: t('mcp.status_off'), color: COLORS.muted }
                  : { text: t('mcp.status_tools', { count: toolCount }), color: toolCount ? COLORS.ok : COLORS.muted };
            return (
              <TouchableOpacity
                key={server.id}
                onPress={() => onOpen(server.id)}
                style={{ padding: 14, gap: 12, borderTopWidth: index ? 1 : 0, borderTopColor: COLORS.line }}
                className="flex flex-row items-center">
                <Plugs size={20} color="#FFF" />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text className="text-white text-base" numberOfLines={1}>{server.name}</Text>
                  <Text style={{ color: COLORS.muted, fontSize: 12 }} numberOfLines={1}>{server.url}</Text>
                </View>
                <Text style={{ color: status.color, fontSize: 12.5 }}>{status.text}</Text>
                <CaretRight size={16} color={COLORS.muted} />
              </TouchableOpacity>
            );
          })}
        </View>
      )}
      <TouchableOpacity onPress={onAdd} style={{ backgroundColor: '#FFF', borderRadius: 8, paddingVertical: 12, gap: 8 }} className="flex flex-row items-center justify-center">
        <Plus size={18} color="#000" weight="bold" />
        <Text style={{ color: '#000' }} className="text-base font-medium">{t('mcp.add_button')}</Text>
      </TouchableOpacity>
      <Text style={{ color: COLORS.muted }} className="text-xs">{t('mcp.remote_only')}</Text>
    </View>
  );
}

function Label({ children }: { children: string }) {
  return <Text style={{ color: COLORS.muted }} className="text-sm uppercase">{children}</Text>;
}

function AddServer({ onAdded }: { onAdded: (id: string) => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [auth, setAuth] = useState<McpAuthKind>('oauth');
  const [headerName, setHeaderName] = useState('Authorization');
  const [headerValue, setHeaderValue] = useState('');
  const [busy, setBusy] = useState(false);

  let validUrl = false;
  try { validUrl = /^https?:$/.test(new URL(url.trim()).protocol); } catch { validUrl = false; }

  async function save() {
    if (!validUrl || busy) return;
    setBusy(true);
    try {
      const server = await addServer({ name, url, auth, headerName, headerValue });
      onAdded(server.id);
    } catch (e: any) {
      showToast(e?.message || t('settings.update_failed'));
    } finally {
      setBusy(false);
    }
  }

  const authOptions: Array<{ key: McpAuthKind; label: string }> = [
    { key: 'oauth', label: t('mcp.auth_oauth') },
    { key: 'header', label: t('mcp.auth_header') },
    { key: 'none', label: t('mcp.auth_none') },
  ];

  return (
    <View style={{ gap: 18 }}>
      <View style={{ gap: 8 }}>
        <Label>{t('mcp.url')}</Label>
        <TextInput value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} keyboardType="url" placeholder="https://mcp.athom.com" placeholderTextColor="#6B6B6E" style={INPUT_STYLE} />
      </View>
      <View style={{ gap: 8 }}>
        <Label>{t('mcp.name')}</Label>
        <TextInput value={name} onChangeText={setName} placeholder="Homey" placeholderTextColor="#6B6B6E" style={INPUT_STYLE} />
      </View>
      <View style={{ gap: 8 }}>
        <Label>{t('mcp.auth')}</Label>
        <View className="flex flex-row flex-wrap" style={{ gap: 6 }}>
          {authOptions.map((option) => (
            <TouchableOpacity
              key={option.key}
              onPress={() => setAuth(option.key)}
              accessibilityState={{ selected: auth === option.key }}
              style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 99, backgroundColor: auth === option.key ? COLORS.accent : COLORS.field }}>
              <Text style={{ color: auth === option.key ? '#062433' : '#FFF', fontSize: 13, fontWeight: auth === option.key ? '600' : '400' }}>{option.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <Text style={{ color: COLORS.muted }} className="text-xs">
          {auth === 'oauth' ? t('mcp.auth_oauth_hint') : auth === 'header' ? t('mcp.auth_header_hint') : t('mcp.auth_none_hint')}
        </Text>
      </View>
      {auth === 'header' && (
        <View style={{ gap: 8 }}>
          <Label>{t('mcp.header_name')}</Label>
          <TextInput value={headerName} onChangeText={setHeaderName} autoCapitalize="none" autoCorrect={false} style={INPUT_STYLE} />
          <Label>{t('mcp.header_value')}</Label>
          <TextInput value={headerValue} onChangeText={setHeaderValue} autoCapitalize="none" autoCorrect={false} secureTextEntry placeholder="Bearer ..." placeholderTextColor="#6B6B6E" style={INPUT_STYLE} />
        </View>
      )}
      <TouchableOpacity onPress={save} disabled={!validUrl || busy} style={{ backgroundColor: '#FFF', borderRadius: 8, paddingVertical: 12, opacity: !validUrl || busy ? 0.5 : 1 }} className="items-center">
        {busy ? <ActivityIndicator color="#000" /> : <Text style={{ color: '#000' }} className="text-base font-medium">{t('mcp.add_save')}</Text>}
      </TouchableOpacity>
    </View>
  );
}

function errorText(t: (key: string, options?: any) => string, error: any): string {
  if (error instanceof McpOAuthError) {
    if (error.code === 'cancelled') return t('mcp.error_cancelled');
    if (error.code === 'denied') return t('mcp.error_denied');
    return t('mcp.error_sign_in', { message: error.message });
  }
  if (error instanceof McpAuthRequiredError) return t('mcp.status_sign_in');
  return t('mcp.error_connect', { message: error?.message || '' });
}

function ServerDetail({ server, onChanged, onRemoved }: { server?: McpServer; onChanged: () => Promise<void>; onRemoved: () => void }) {
  const { t } = useTranslation();
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<'connect' | 'sign_in' | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    if (server) isSignedIn(server).then(setSignedIn);
  }, [server?.id, server?.lastError]);

  const connect = useCallback(async () => {
    if (!server) return;
    setBusy('connect');
    try {
      await refreshTools(server.id);
    } catch (e) {
      if (!(e instanceof McpAuthRequiredError)) showToast(errorText(t, e), 'long');
    } finally {
      await onChanged();
      setBusy(null);
    }
  }, [server?.id]);

  // First visit after adding: fetch the tools straight away (or find out a sign-in is needed)
  useEffect(() => {
    if (server && !server.toolsFetchedAt && !server.lastError && server.auth !== 'oauth') connect();
  }, [server?.id]);

  if (!server) return null;

  async function doSignIn() {
    if (!server) return;
    setBusy('sign_in');
    try {
      await signInToServer(server.id);
      setSignedIn(true);
      await refreshTools(server.id).catch((e) => showToast(errorText(t, e), 'long'));
      showToast(t('mcp.signed_in', { name: server.name }));
    } catch (e) {
      showToast(errorText(t, e), 'long');
    } finally {
      await onChanged();
      setBusy(null);
    }
  }

  const needsSignIn = server.auth === 'oauth' && (!signedIn || server.lastError === 'auth');
  const toggleTool = async (toolName: string) => {
    const disabled = server.disabledTools ?? [];
    await updateServer(server.id, { disabledTools: disabled.includes(toolName) ? disabled.filter((n) => n !== toolName) : [...disabled, toolName] });
    await onChanged();
  };

  return (
    <View style={{ gap: 16 }}>
      <View style={{ backgroundColor: COLORS.card, borderRadius: 8, padding: 14, gap: 12 }}>
        <Text style={{ color: COLORS.muted, fontSize: 12 }} selectable>{server.url}</Text>
        <View className="flex flex-row items-center justify-between">
          <Text className="text-white text-base">{t('mcp.use_in_chats')}</Text>
          <ToggleSwitch isOn={server.enabled} onToggle={async () => { await updateServer(server.id, { enabled: !server.enabled }); await onChanged(); }} />
        </View>
        <View className="flex flex-row items-center justify-between" style={{ gap: 12 }}>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Text className="text-white text-base">{t('mcp.always_load')}</Text>
            <Text style={{ color: COLORS.muted, fontSize: 12 }}>{server.alwaysLoad ? t('mcp.always_load_on_hint') : t('mcp.always_load_off_hint')}</Text>
          </View>
          <ToggleSwitch isOn={!!server.alwaysLoad} onToggle={async () => { await updateServer(server.id, { alwaysLoad: !server.alwaysLoad }); await onChanged(); }} />
        </View>
        {server.lastError && server.lastError !== 'auth' && (
          <View className="flex flex-row" style={{ gap: 8 }}>
            <Warning size={16} color={COLORS.danger} />
            <Text style={{ color: COLORS.danger, fontSize: 12.5, flex: 1 }}>{server.lastError}</Text>
          </View>
        )}
      </View>

      {needsSignIn ? (
        <TouchableOpacity onPress={doSignIn} disabled={!!busy} style={{ backgroundColor: '#FFF', borderRadius: 8, paddingVertical: 12, gap: 8, opacity: busy ? 0.6 : 1 }} className="flex flex-row items-center justify-center">
          {busy === 'sign_in' ? <ActivityIndicator color="#000" /> : <ShieldCheck size={18} color="#000" />}
          <Text style={{ color: '#000' }} className="text-base font-medium">{t('mcp.sign_in', { name: server.name })}</Text>
        </TouchableOpacity>
      ) : (
        <TouchableOpacity onPress={connect} disabled={!!busy} style={{ backgroundColor: COLORS.field, borderRadius: 8, paddingVertical: 12, gap: 8 }} className="flex flex-row items-center justify-center">
          {busy === 'connect' ? <ActivityIndicator color="#FFF" /> : <ArrowsClockwise size={18} color="#FFF" />}
          <Text className="text-white text-base">{t('mcp.refresh_tools')}</Text>
        </TouchableOpacity>
      )}
      {needsSignIn && <Text style={{ color: COLORS.muted }} className="text-xs">{t('mcp.sign_in_hint')}</Text>}

      {(server.tools ?? []).length > 0 && (
        <View style={{ gap: 8 }}>
          <Label>{t('mcp.tools_title', { count: server.tools.length })}</Label>
          <View style={{ backgroundColor: COLORS.card, borderRadius: 8 }}>
            {server.tools.map((tool, index) => (
              <View key={tool.name} style={{ padding: 12, gap: 10, borderTopWidth: index ? 1 : 0, borderTopColor: COLORS.line }} className="flex flex-row items-center">
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <Text className="text-white" style={{ fontSize: 14 }} numberOfLines={1}>{tool.title || tool.annotations?.title || tool.name}</Text>
                  {!!tool.description && <Text style={{ color: COLORS.muted, fontSize: 12 }} numberOfLines={2}>{tool.description}</Text>}
                  <Text style={{ color: needsApproval(tool) ? COLORS.warn : COLORS.ok, fontSize: 11 }}>
                    {needsApproval(tool) ? t('mcp.asks_first') : t('mcp.read_only')}
                  </Text>
                </View>
                <ToggleSwitch isOn={!server.disabledTools?.includes(tool.name)} onToggle={() => toggleTool(tool.name)} />
              </View>
            ))}
          </View>
        </View>
      )}

      {server.auth === 'oauth' && signedIn && (
        <TouchableOpacity onPress={async () => { await signOut(server.id); setSignedIn(false); await onChanged(); }} className="items-center" style={{ paddingVertical: 6 }}>
          <Text style={{ color: COLORS.muted }} className="text-sm">{t('mcp.sign_out')}</Text>
        </TouchableOpacity>
      )}
      {confirmRemove ? (
        <View className="flex flex-row justify-center" style={{ gap: 12 }}>
          <TouchableOpacity onPress={async () => { await removeServer(server.id); onRemoved(); }} style={{ backgroundColor: COLORS.danger, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 16 }}>
            <Text style={{ color: '#000', fontWeight: '600' }}>{t('mcp.remove_confirm')}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setConfirmRemove(false)} style={{ paddingVertical: 10, paddingHorizontal: 16 }}>
            <Text className="text-white">{t('mcp.cancel')}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <TouchableOpacity onPress={() => setConfirmRemove(true)} className="flex flex-row items-center justify-center" style={{ gap: 6, paddingVertical: 6 }}>
          <Trash size={16} color={COLORS.danger} />
          <Text style={{ color: COLORS.danger }} className="text-sm">{t('mcp.remove')}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}
