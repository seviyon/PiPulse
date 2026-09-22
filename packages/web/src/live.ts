import type { LiveMessage } from './types.js';

export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting';

export interface LiveOptions {
  url: string;
  onMessage(message: LiveMessage): void;
  /** `retryInMs` is set while reconnecting: how long until the next attempt. */
  onStatus(status: ConnectionStatus, retryInMs?: number): void;
  /** Injectable for tests; defaults to the browser's WebSocket. */
  WebSocketImpl?: typeof WebSocket;
}

export const FIRST_RETRY_MS = 1000;
export const MAX_RETRY_MS = 30_000;

/**
 * Keeps a WebSocket to /api/live open, reconnecting with a doubling delay
 * (1 s, 2 s, 4 s … capped at 30 s) that resets once a connection succeeds.
 * Returns a function that closes it for good.
 */
export function connectLive(options: LiveOptions): () => void {
  const Impl = options.WebSocketImpl ?? WebSocket;
  let retryMs = FIRST_RETRY_MS;
  let socket: WebSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const open = () => {
    options.onStatus('connecting');
    socket = new Impl(options.url);
    socket.onopen = () => {
      retryMs = FIRST_RETRY_MS;
      options.onStatus('live');
    };
    socket.onmessage = (event: MessageEvent<string>) => {
      let message: LiveMessage;
      try {
        message = JSON.parse(event.data) as LiveMessage;
      } catch {
        return;
      }
      options.onMessage(message);
    };
    socket.onclose = () => {
      if (stopped) return;
      options.onStatus('reconnecting', retryMs);
      timer = setTimeout(open, retryMs);
      retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
    };
  };

  open();

  return () => {
    stopped = true;
    clearTimeout(timer);
    socket?.close();
  };
}
