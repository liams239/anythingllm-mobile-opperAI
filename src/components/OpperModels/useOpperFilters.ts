import { useCallback, useEffect, useState } from 'react';
import uiStore from '@/store/UIStore';
import { EMPTY_FILTERS, normalizeFilters, type OpperModelFilters, type OpperModelKind } from '@/utils/opper';

/**
 * Filters of one Opper model list, kept on the phone (`opper_model_filters`, one set per kind) so
 * eg "EU + no logging" stays the default view until cleared.
 */
export default function useOpperFilters(kind: OpperModelKind) {
    const [filters, setFilters] = useState<OpperModelFilters>(EMPTY_FILTERS);

    useEffect(() => {
        let cancelled = false;
        uiStore.getFromStorage('opper_model_filters', {})
            .then((stored: any) => { if (!cancelled) setFilters(normalizeFilters(stored?.[kind])); })
            .catch(() => null);
        return () => { cancelled = true; };
    }, [kind]);

    const update = useCallback((next: OpperModelFilters) => {
        setFilters(next);
        uiStore.getFromStorage('opper_model_filters', {})
            .then((stored: any) => uiStore.setToStorage('opper_model_filters', { ...(stored ?? {}), [kind]: next }))
            .catch((e: unknown) => console.log('[OpperModels] could not save filters', e));
    }, [kind]);

    return [filters, update] as const;
}
