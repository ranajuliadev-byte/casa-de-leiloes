'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Carrega um recurso da API ao montar (e quando `fetcher` muda) e expõe `reload`.
 *
 * - `fetcher` deve ser estável (`useCallback`) e sem efeitos colaterais.
 * - `onLoaded` recebe só a resposta que vale: efeitos da carga (offset do relógio,
 *   testemunha, carteira global) ficam nele, nunca no `fetcher`.
 * - Resposta atrasada de uma carga anterior é descartada: só a mais recente vale.
 * - Em erro, o último dado carregado é mantido (a tela decide se mostra o erro).
 * - `loading`: há uma carga em andamento (inclusive "Tentar de novo").
 */
export function useApiResource<T>(fetcher: () => Promise<T>, onLoaded?: (data: T) => void) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const reqId = useRef(0);
  const onLoadedRef = useRef(onLoaded);
  useEffect(() => {
    onLoadedRef.current = onLoaded;
  });

  const reload = useCallback(async () => {
    const id = ++reqId.current;
    setLoading(true);
    try {
      const res = await fetcher();
      if (id !== reqId.current) return;
      onLoadedRef.current?.(res);
      setData(res);
      setError(null);
    } catch (e) {
      if (id === reqId.current) setError(e);
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [fetcher]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, error, loading, reload };
}
