export interface WeixinAccount { token: string; botId: string; userId: string; baseUrl: string }
export interface DotProfile { id: string; name: string; roomId: string; accountId: string; userId: string; url: string }
export interface LocalFile { path: string; name: string; mime: string }
export interface DotAttachment { id: string; name: string; mime: string; url?: string }
export interface DotMessage { id: string; text: string; createdAt: string; complete: boolean; attachments: DotAttachment[] }
export interface WeixinItem {
  type?: number;
  text_item?: { text?: string };
  image_item?: { media?: CdnMedia; aeskey?: string; mid_size?: number };
  file_item?: { media?: CdnMedia; file_name?: string; len?: string };
  voice_item?: { media?: CdnMedia; text?: string; sample_rate?: number; encode_type?: number };
  ref_msg?: { title?: string; svr_id?: string; message_item?: WeixinItem };
}
export interface CdnMedia { encrypt_query_param?: string; aes_key?: string; full_url?: string; encrypt_type?: number }
export interface WeixinMessage {
  message_id?: string; from_user_id?: string; to_user_id?: string;
  message_type?: number; message_state?: number; create_time_ms?: number;
  item_list?: WeixinItem[]; context_token?: string;
}
export interface InboundJob { id: string; message: WeixinMessage; phase: 'pending' | 'sending' | 'done'; composing?: boolean; lastError?: string; requestId?: string; text?: string; dotMessageId?: string; beforeCursor?: string; prepared?: { text: string; files: LocalFile[] } }
export interface OutboundJob { id: string; message: DotMessage; part: number; phase: 'pending' | 'sending' | 'done'; media?: Record<number, { file: LocalFile; item?: WeixinItem }> }
export interface BridgeState {
  version: 1; weixin?: WeixinAccount; dot?: DotProfile;
  weixinCursor: string; weixinPrimed?: boolean; dotCursor?: string; dotPending?: string[]; contextToken?: string;
  inbound: InboundJob[]; outbound: OutboundJob[]; enabled: boolean;
  savedConnections?: Record<string, ConnectionProgress & { dot?: DotProfile }>;
}
export type ConnectionProgress = Pick<BridgeState, 'weixinCursor' | 'weixinPrimed' | 'dotCursor' | 'dotPending' | 'contextToken' | 'inbound' | 'outbound'>;
export type ConnectionStatus = 'idle' | 'waiting' | 'ready' | 'error';
export interface AppStatus {
  weixin: ConnectionStatus; dot: ConnectionStatus; running: boolean;
  weixinDetail: string; dotDetail: string; detail: string;
  dotName?: string; qr?: string; verifyRequired?: boolean;
  version: string; updatedAt?: string; updateUrl?: string;
  needsReview?: boolean;
  finishLogin?: boolean;
  problem?: string;
  extension?: boolean;
}
