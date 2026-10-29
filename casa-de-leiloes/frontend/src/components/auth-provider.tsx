'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch, ApiError, getToken, setToken, TOKEN_KEY } from '@/lib/api';
import { getSocket, resetSocketAuth } from '@/lib/socket';
import { formatBRL } from '@/lib/format';
import type { AuthResponse, MeResponse, OutbidEvent, Role, UserView, WalletView, WonEvent } from '@/lib/types';
import { useToast } from './toast';

interface AuthContextValue {
  user: UserView | null;
  wallet: WalletView | null;
  /** true até sabermos se há sessão (evita piscar "Entrar"). */
  loading: boolean;
  login: (email: string, password: string, role: Role) => Promise<UserView>;
  /** Troca o perfil ativo (conta com os dois perfis) sem novo login. */
  switchRole: (role: Role) => Promise<UserView>;
  register: (input: { name: string; email: string; password: string; role: Role }) => Promise<UserView>;
  logout: () => void;
  setWallet: (w: WalletView) => void;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth fora do AuthProvider');
  return ctx;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserView | null>(null);
  const [wallet, setWallet] = useState<WalletView | null>(null);
  const [loading, setLoading] = useState(true);
  const { push } = useToast();
  // Sobe a cada login/troca de perfil/logout: respostas de /me pedidas antes são descartadas
  // (senão um refresh atrasado devolveria o perfil antigo por cima do novo).
  const session = useRef(0);

  const refresh = useCallback(async () => {
    const id = session.current;
    if (!getToken()) {
      setUser(null);
      setWallet(null);
      setLoading(false);
      return;
    }
    try {
      const me = await apiFetch<MeResponse>('/api/auth/me');
      if (id !== session.current) return;
      setUser(me.user);
      setWallet(me.wallet);
    } catch (e) {
      // Token inválido/expirado: limpa. Erro de rede: mantém o token para tentar depois.
      if (id === session.current && e instanceof ApiError && e.status === 401) {
        setToken(null);
        setUser(null);
        setWallet(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Eventos privados do usuário
  useEffect(() => {
    if (!user) return;
    const s = getSocket();
    const onWallet = (w: WalletView) => setWallet(w);
    const onOutbid = (e: OutbidEvent) =>
      push({
        tone: 'danger',
        title: `Você foi superado em ${e.title}`,
        message: `Novo lance: ${formatBRL(e.newPriceCents)}. O seu era ${formatBRL(e.yourAmountCents)}, e o valor voltou para o seu saldo disponível.`,
        href: `/lotes/${e.lotId}`,
        hrefLabel: 'Voltar à sala',
        durationMs: 9000,
      });
    const onWon = (e: WonEvent) =>
      push({
        tone: 'success',
        title: `Você arrematou ${e.title}`,
        message: `Valor final: ${formatBRL(e.amountCents)}.`,
        href: `/comprovante/${e.receiptCode}`,
        hrefLabel: 'Ver comprovante',
        durationMs: 12000,
      });
    s.on('user:wallet', onWallet);
    s.on('user:outbid', onOutbid);
    s.on('user:won', onWon);
    // Ao reconectar, a carteira pode ter mudado
    const onConnect = () => void refresh();
    s.io.on('reconnect', onConnect);
    return () => {
      s.off('user:wallet', onWallet);
      s.off('user:outbid', onOutbid);
      s.off('user:won', onWon);
      s.io.off('reconnect', onConnect);
    };
  }, [user, push, refresh]);

  const afterAuth = useCallback(
    async (res: AuthResponse) => {
      const id = ++session.current;
      setToken(res.accessToken);
      setUser(res.user);
      setWallet(null); // nunca mostrar a carteira de outra conta enquanto a nova não chega
      resetSocketAuth();
      try {
        const me = await apiFetch<MeResponse>('/api/auth/me');
        if (id === session.current) setWallet(me.wallet);
      } catch {
        /* carteira chega depois */
      }
      return res.user;
    },
    [],
  );

  const login = useCallback(
    async (email: string, password: string, role: Role) =>
      afterAuth(await apiFetch<AuthResponse>('/api/auth/login', { method: 'POST', body: { email, password, role }, auth: false })),
    [afterAuth],
  );

  const switchRole = useCallback(
    async (role: Role) => afterAuth(await apiFetch<AuthResponse>('/api/auth/switch-role', { method: 'POST', body: { role } })),
    [afterAuth],
  );

  const register = useCallback(
    async (input: { name: string; email: string; password: string; role: Role }) =>
      afterAuth(await apiFetch<AuthResponse>('/api/auth/register', { method: 'POST', body: input, auth: false })),
    [afterAuth],
  );

  const logout = useCallback(() => {
    session.current++;
    setToken(null);
    setUser(null);
    setWallet(null);
    resetSocketAuth();
  }, []);

  // Outra aba entrou, saiu ou trocou de perfil (o token fica no localStorage, comum a todas):
  // esta aba acompanha, senão mostraria o perfil antigo com um token que já é outro.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== TOKEN_KEY && e.key !== null) return;
      session.current++;
      resetSocketAuth();
      void refresh();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [refresh]);

  const value = useMemo(
    () => ({ user, wallet, loading, login, switchRole, register, logout, setWallet, refresh }),
    [user, wallet, loading, login, switchRole, register, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
