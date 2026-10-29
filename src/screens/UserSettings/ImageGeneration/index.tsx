import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Linking, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Check } from 'phosphor-react-native';
import { useTranslation } from 'react-i18next';
import SafeView from '@/components/SafeView';
import useHighjackBackButtonPress from '@/hooks/useHighjackBackButtonPress';
import { showToast } from '@/utils/Notification';
import { clearOpperSettings, formatOpperPrice, getOpperSettings, listOpperImageModels, OPPER_MODEL_PLACEHOLDER, saveOpperSettings, type OpperImageModel } from '@/utils/opper';
import uiStore from '@/store/UIStore';
import ToolsManager from '@/utils/ToolsManager';
import { ModelBadges } from '@/components/OpperModels/Badges';
import { IWorkspacePageKey } from '../index';

interface ImageGenerationProps {
  goToPage: (page: IWorkspacePageKey) => void;
}

const INPUT_STYLE = {
  backgroundColor: '#1B1B1E',
  color: '#FFF',
  borderRadius: 8,
  paddingHorizontal: 14,
  paddingVertical: 12,
  fontSize: 15,
} as const;

const OPPER_KEYS_URL = 'https://platform.opper.ai';

/**
 * Settings > Image generation: the Opper API key (and optional model) the generate-image tool
 * uses. The image models Opper offers are fetched and listed to pick from; typing a model id
 * by hand still works when the list cannot be loaded. Saving a key also switches the tool on, so the user can ask for images right away in
 * any chat, next to their normal LLM.
 */
export default function ImageGeneration({ goToPage }: ImageGenerationProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [hasSaved, setHasSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [models, setModels] = useState<OpperImageModel[]>([]);
  const [modelsStatus, setModelsStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const goBack = () => {
    goToPage('main');
    return true;
  };
  useHighjackBackButtonPress(goBack);

  useEffect(() => {
    getOpperSettings().then((settings) => {
      if (!settings) return;
      setApiKey(settings.apiKey);
      setModel(settings.model);
      setHasSaved(true);
    });
  }, []);

  async function loadModels(key?: string) {
    setModelsStatus('loading');
    try {
      setModels(await listOpperImageModels(key));
      setModelsStatus('ready');
    } catch (e) {
      console.error('[ImageGeneration] could not load image models', e);
      setModelsStatus('error');
    }
  }

  useEffect(() => {
    getOpperSettings().then((settings) => loadModels(settings?.apiKey)).catch(() => loadModels());
  }, []);

  // Narrow the list while typing, but show everything once the field holds a picked model
  const visibleModels = useMemo(() => {
    const query = model.trim().toLowerCase();
    if (!query || models.some((m) => m.id.toLowerCase() === query)) return models;
    return models.filter((m) => m.id.toLowerCase().includes(query) || m.name.toLowerCase().includes(query));
  }, [models, model]);

  async function setToolEnabled(enabled: boolean) {
    const tools: Record<string, boolean> = await uiStore.getFromStorage('tools', {});
    await uiStore.setToStorage('tools', { ...tools, generateImage: enabled });
    ToolsManager.resetTools();
  }

  async function save() {
    if (saving || !apiKey.trim()) return;
    setSaving(true);
    try {
      await saveOpperSettings({ apiKey, model });
      await setToolEnabled(true);
      setHasSaved(true);
      showToast(t('settings.image_generation.saved'));
    } catch (e) {
      console.error('[ImageGeneration] could not save settings', e);
      showToast(t('settings.update_failed'));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    await clearOpperSettings();
    await setToolEnabled(false);
    setApiKey('');
    setModel('');
    setHasSaved(false);
    showToast(t('settings.image_generation.removed'));
  }

  return (
    <SafeView
      scrollable={false}
      safeAreaClassNames="pt-[21px]"
      containerClassNames="flex flex-col flex-1"
      safeAreaStyle={{ backgroundColor: '#0E0F0F' }}>
      {/* Header */}
      <View
        style={{ paddingTop: insets.top, paddingBottom: 20 }}
        className="w-full flex flex-row items-center justify-center relative">
        <TouchableOpacity onPress={goBack} className="absolute left-0 flex flex-row items-center gap-2">
          <ArrowLeft size={24} color="#FFF" weight="bold" />
        </TouchableOpacity>
        <Text className="text-white text-lg font-medium">{t('settings.image_generation.page_title')}</Text>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: insets.bottom + 20, gap: 20 }}>
        <Text style={{ color: '#9F9FA0' }} className="text-sm">{t('settings.image_generation.description')}</Text>

        <View style={{ gap: 8 }}>
          <Text style={{ color: '#9F9FA0' }} className="text-sm uppercase">{t('settings.image_generation.api_key')}</Text>
          <TextInput
            value={apiKey}
            onChangeText={setApiKey}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            placeholder={t('settings.provider_options.api_key_placeholder')}
            placeholderTextColor="#6B6B6E"
            style={INPUT_STYLE}
          />
          <TouchableOpacity onPress={() => Linking.openURL(OPPER_KEYS_URL)}>
            <Text style={{ color: '#7CC4FF' }} className="text-sm">{t('settings.image_generation.get_key')}</Text>
          </TouchableOpacity>
        </View>

        <View style={{ gap: 8 }}>
          <Text style={{ color: '#9F9FA0' }} className="text-sm uppercase">{t('settings.image_generation.model')}</Text>
          <TextInput
            value={model}
            onChangeText={setModel}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={OPPER_MODEL_PLACEHOLDER}
            placeholderTextColor="#6B6B6E"
            style={INPUT_STYLE}
          />
          <Text style={{ color: '#9F9FA0' }} className="text-sm">{t('settings.image_generation.model_hint')}</Text>
          <ModelList
            models={visibleModels}
            status={modelsStatus}
            selected={model.trim()}
            onSelect={setModel}
            onRetry={() => loadModels(apiKey)}
          />
        </View>

        <TouchableOpacity
          onPress={save}
          disabled={saving || !apiKey.trim()}
          style={{ backgroundColor: '#FFF', borderRadius: 8, paddingVertical: 12, opacity: saving || !apiKey.trim() ? 0.5 : 1 }}
          className="flex items-center">
          <Text style={{ color: '#000' }} className="text-base font-medium">{t('settings.image_generation.save')}</Text>
        </TouchableOpacity>
        {hasSaved && (
          <TouchableOpacity onPress={remove} className="flex items-center">
            <Text style={{ color: '#F87171' }} className="text-base">{t('settings.image_generation.remove')}</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </SafeView>
  );
}

function ModelList({ models, status, selected, onSelect, onRetry }: {
  models: OpperImageModel[];
  status: 'loading' | 'ready' | 'error';
  selected: string;
  onSelect: (id: string) => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  if (status === 'loading') {
    return (
      <View className="flex flex-row items-center" style={{ gap: 8, paddingVertical: 6 }}>
        <ActivityIndicator size="small" color="#9F9FA0" />
        <Text style={{ color: '#9F9FA0' }} className="text-sm">{t('settings.image_generation.models_loading')}</Text>
      </View>
    );
  }
  if (status === 'error') {
    return (
      <TouchableOpacity onPress={onRetry} style={{ paddingVertical: 6 }}>
        <Text style={{ color: '#F87171' }} className="text-sm">{t('settings.image_generation.models_error')}</Text>
      </TouchableOpacity>
    );
  }

  const rows = [{ id: '', name: t('settings.image_generation.default_model'), provider: 'opper' }, ...models];
  return (
    <View style={{ backgroundColor: '#1B1B1E', borderRadius: 8, maxHeight: 420, overflow: 'hidden' }}>
      <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled">
        {rows.map((m, index) => {
          const isSelected = m.id === selected;
          return (
            <TouchableOpacity
              key={m.id || 'default'}
              onPress={() => onSelect(m.id)}
              accessibilityState={{ selected: isSelected }}
              style={{ paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: index === 0 ? 0 : 1, borderTopColor: '#2A2A2E', gap: 10 }}
              className="flex flex-row items-center">
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text numberOfLines={1} className="text-white text-base">{m.name}</Text>
                {!!m.id && m.name !== m.id && <Text numberOfLines={1} style={{ color: '#9F9FA0' }} className="text-xs">{m.id}</Text>}
                {!!formatOpperPrice(m.price) && <Text numberOfLines={1} style={{ color: '#7CC4FF' }} className="text-xs">{formatOpperPrice(m.price)}</Text>}
                <ModelBadges meta={(m as OpperImageModel).meta} kind="image" />
              </View>
              {isSelected && <Check size={16} color="#FFF" weight="bold" />}
            </TouchableOpacity>
          );
        })}
        {models.length === 0 && (
          <Text style={{ color: '#9F9FA0', paddingHorizontal: 14, paddingVertical: 10 }} className="text-sm">{t('settings.image_generation.models_none')}</Text>
        )}
      </ScrollView>
    </View>
  );
}
