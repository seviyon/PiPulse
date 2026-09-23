import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectLive, type ConnectionStatus } from '../src/live.js';
import type { LiveMessage } from '../src/types.js';

/** Minimal stand-in for the browser WebSocket, driven by the test. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onclose: ((event?: { code: number }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.();
  }
  drop() {
    this.onclose?.();
  }
  receive(message: LiveMessage) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const latest = () => FakeSocket.instances.at(-1)!;

let statuses: [ConnectionStatus, number | undefined][];
let messages: LiveMessage[];

function connect() {
  return connectLive({
    url: 'ws://pi/api/live',
    onMessage: (message) => messages.push(message),
    onStatus: (status, retryInMs) => statuses.push([status, retryInMs]),
    WebSocketImpl: FakeSocket as unknown as typeof WebSocket
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  statuses = [];
  messages = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('connectLive', () => {
  it('reports connecting, then live once the socket opens, and passes messages through', () => {
    connect();
    expect(latest().url).toBe('ws://pi/api/live');
    latest().open();
    latest().receive({ type: 'sample', ts: 1, metric: 'cpu_load', value: 2 });

    expect(statuses).toEqual([
      ['connecting', undefined],
      ['live', undefined]
    ]);
    expect(messages).toEqual([{ type: 'sample', ts: 1, metric: 'cpu_load', value: 2 }]);
  });

  it('reconnects with a doubling delay capped at 30 s', () => {
    connect();
    const delays: number[] = [];
    for (let attempt = 0; attempt < 7; attempt++) {
      latest().drop();
      const delay = statuses.at(-1)![1]!;
      delays.push(delay);
      vi.advanceTimersByTime(delay);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(FakeSocket.instances).toHaveLength(8);
  });

  it('resets the delay after a successful reconnect', () => {
    connect();
    latest().drop();
    vi.advanceTimersByTime(1000);
    latest().drop();
    vi.advanceTimersByTime(2000);
    latest().open();
    latest().drop();

    expect(statuses.at(-1)).toEqual(['reconnecting', 1000]);
  });

  it('ignores a malformed message instead of breaking the feed', () => {
    connect();
    latest().open();
    latest().onmessage?.({ data: 'not json' });
    latest().receive({ type: 'sample', ts: 2, metric: 'm', value: 1 });

    expect(messages).toHaveLength(1);
  });

  it('stops for good when closed, without scheduling a reconnect', () => {
    const close = connect();
    latest().open();
    close();
    latest().drop();
    vi.advanceTimersByTime(60_000);

    expect(latest().closed).toBe(true);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('stops reconnecting after the server closes with 4401, and says so', () => {
    const onUnauthorized = vi.fn();
    const onStatus = vi.fn();
    connectLive({
      url: 'ws://io.lan/api/live',
      onMessage: () => {},
      onStatus,
      onUnauthorized,
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket
    });
    FakeSocket.instances.at(-1)!.onclose?.({ code: 4401 } as CloseEvent);
    expect(onUnauthorized).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });
});
