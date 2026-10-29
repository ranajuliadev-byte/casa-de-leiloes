import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { userFromToken } from '../common/auth/auth.guards';
import { corsOrigins } from '../common/cors';
import { LotPhase } from '../common/lot-phase';

/**
 * ===== Contrato de eventos em tempo real (Socket.IO, path padrão /socket.io) =====
 *
 * Conexão: io(API_URL, { auth: { token } })  — token é opcional (visitante anônimo).
 * Usuário autenticado entra automaticamente na sala privada `user:<id>`.
 *
 * Cliente → servidor
 *   'lot:join'      { lotId }   entra na sala do lote
 *   'lot:leave'     { lotId }
 *   'showcase:join' {}          recebe atualizações resumidas para a vitrine
 *
 * Servidor → cliente
 *   'lot:state'     LotLiveState   (sala lot:<id> e showcase) — após lance, prorrogação, cancelamento, liquidação
 *   'lot:bid'       PublicBid      (sala lot:<id>)            — novo lance aceito
 *   'user:wallet'   WalletView     (sala user:<id>)           — saldo mudou
 *   'user:outbid'   OutbidEvent    (sala user:<id>)           — você foi superado
 *   'user:won'      WonEvent       (sala user:<id>)           — você arrematou
 */

export interface LotLiveState {
  lotId: string;
  phase: LotPhase;
  currentPriceCents: number | null;
  bidCount: number;
  leaderAlias: string | null;
  minNextBidCents: number;
  startsAt: string;
  endsAt: string;
  extended: boolean; // endsAt > originalEndsAt
  settled: boolean;
  winnerAlias: string | null;
  finalPriceCents: number | null;
  serverTime: string;
}

export interface PublicBid {
  id: string;
  lotId: string;
  sequence: number;
  amountCents: number;
  bidderAlias: string;
  createdAt: string;
  hash: string;
}

export interface WalletView {
  balanceCents: number;
  committedCents: number;
  availableCents: number;
}

export interface OutbidEvent {
  lotId: string;
  title: string;
  newPriceCents: number;
  yourAmountCents: number;
}

export interface WonEvent {
  lotId: string;
  title: string;
  amountCents: number;
  receiptCode: string;
}

@WebSocketGateway({
  cors: { origin: corsOrigins(), credentials: true },
})
export class RealtimeGateway implements OnGatewayConnection {
  private readonly logger = new Logger('Realtime');
  @WebSocketServer() server: Server;

  constructor(private readonly jwt: JwtService) {}

  handleConnection(client: Socket) {
    const token = (client.handshake.auth as any)?.token ?? null;
    const user = userFromToken(this.jwt, token);
    if (user) {
      client.data.user = user;
      client.join(`user:${user.id}`);
    }
  }

  @SubscribeMessage('lot:join')
  joinLot(@ConnectedSocket() client: Socket, @MessageBody() body: { lotId: string }) {
    if (body?.lotId) client.join(`lot:${body.lotId}`);
    return { ok: true };
  }

  @SubscribeMessage('lot:leave')
  leaveLot(@ConnectedSocket() client: Socket, @MessageBody() body: { lotId: string }) {
    if (body?.lotId) client.leave(`lot:${body.lotId}`);
    return { ok: true };
  }

  @SubscribeMessage('showcase:join')
  joinShowcase(@ConnectedSocket() client: Socket) {
    client.join('showcase');
    return { ok: true };
  }
}

/** Fachada usada pelos serviços de domínio para publicar eventos. */
@Injectable()
export class RealtimeService {
  constructor(private readonly gateway: RealtimeGateway) {}

  private get io(): Server | undefined {
    return this.gateway.server;
  }

  lotState(state: LotLiveState) {
    this.io?.to(`lot:${state.lotId}`).to('showcase').emit('lot:state', state);
  }

  lotBid(bid: PublicBid) {
    this.io?.to(`lot:${bid.lotId}`).emit('lot:bid', bid);
  }

  wallet(userId: string, wallet: WalletView) {
    this.io?.to(`user:${userId}`).emit('user:wallet', wallet);
  }

  outbid(userId: string, ev: OutbidEvent) {
    this.io?.to(`user:${userId}`).emit('user:outbid', ev);
  }

  won(userId: string, ev: WonEvent) {
    this.io?.to(`user:${userId}`).emit('user:won', ev);
  }
}

@Global()
@Module({
  providers: [RealtimeGateway, RealtimeService],
  exports: [RealtimeService],
})
export class RealtimeModule {}
