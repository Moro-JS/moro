// Unit tests - Server-Sent Events formatting. A value an application passes
// to sendEvent()/sendComment() must reach the client as part of that one
// event: `id` and `event` are single-line fields, multi-line `data` is sent
// as one `data:` line per line, and nothing in a value can start a new field
// or a new event.
//
// The middleware itself only gives the response its helpers: a stream opens
// when the handler asks for one, never because of what the request's Accept
// header says.
import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { EventEmitter } from 'node:events';
import {
  SSECore,
  createSSEMiddleware,
  sse,
  formatSSEEvent,
  formatSSEComment,
  formatSSERetry,
} from '../../../src/core/middleware/built-in/sse/index.js';

interface ReceivedEvent {
  type: string;
  data: string;
  id?: string;
}

/** What an EventSource client dispatches for a stream, per the HTML spec. */
function receive(stream: string): ReceivedEvent[] {
  const events: ReceivedEvent[] = [];
  let type = '';
  let data: string[] = [];
  let id: string | undefined;

  for (const line of stream.split(/\r\n|\r|\n/)) {
    if (line === '') {
      if (data.length > 0) {
        events.push({ type: type || 'message', data: data.join('\n'), ...(id ? { id } : {}) });
      }
      type = '';
      data = [];
      continue;
    }
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') type = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id') id = value;
  }
  return events;
}

describe('SSE formatting', () => {
  it('writes single-line values exactly as given', () => {
    expect(formatSSEEvent('hello')).toBe('data: hello\n\n');
    expect(formatSSEEvent('hello', 'greeting')).toBe('event: greeting\ndata: hello\n\n');
    expect(formatSSEEvent('hello', 'greeting', '42')).toBe(
      'id: 42\nevent: greeting\ndata: hello\n\n'
    );
    expect(formatSSEEvent({ a: 1, text: 'line1\nline2' })).toBe(
      'data: {"a":1,"text":"line1\\nline2"}\n\n'
    );
    expect(formatSSEEvent('')).toBe('data: \n\n');
    expect(formatSSEComment('heartbeat')).toBe(': heartbeat\n\n');
    expect(formatSSERetry(3000)).toBe('retry: 3000\n\n');
  });

  it('sends multi-line data as one data line per line, received as the same text', () => {
    expect(formatSSEEvent('first\nsecond\nthird')).toBe(
      'data: first\ndata: second\ndata: third\n\n'
    );

    for (const text of ['a\nb', 'a\r\nb', 'a\rb', 'a\n\nb', 'trailing\n', '\nleading']) {
      const received = receive(formatSSEEvent(text, 'note', '7'));
      expect(received).toEqual([{ type: 'note', data: text.replace(/\r\n|\r/g, '\n'), id: '7' }]);
    }
  });

  it('keeps a value that looks like stream syntax inside the event it was sent in', () => {
    const text = 'hello\n\nevent: admin\ndata: {"grant":true}\n\nid: 999';
    const received = receive(
      formatSSEEvent(text, 'chat', '1') + formatSSEEvent('next', 'chat', '2')
    );

    expect(received).toEqual([
      { type: 'chat', data: text, id: '1' },
      { type: 'chat', data: 'next', id: '2' },
    ]);
  });

  it('removes line breaks from id and event', () => {
    const out = formatSSEEvent('payload', 'chat\nevent: admin', '1\r\ndata: forged\n\n');

    expect(out).toBe('id: 1data: forged\nevent: chatevent: admin\ndata: payload\n\n');
    expect(receive(out)).toEqual([
      { type: 'chatevent: admin', data: 'payload', id: '1data: forged' },
    ]);
  });

  it('keeps a multi-line comment a comment', () => {
    const out = formatSSEComment('note\ndata: forged\n\nevent: admin');

    expect(out).toBe(': note\n: data: forged\n: \n: event: admin\n\n');
    expect(receive(out)).toEqual([]);
  });

  it('applies to events sent through a connection', () => {
    const written: string[] = [];
    const res: any = { write: (chunk: string) => written.push(chunk), end() {} };
    const connection = new SSECore().createConnection(res);

    connection.sendEvent('one\ntwo', 'update\n', 'a\nb');
    connection.sendComment('x\ny');
    connection.close();

    expect(written).toEqual(['id: ab\nevent: update\ndata: one\ndata: two\n\n', ': x\n: y\n\n']);
  });
});

/** A response double that records what was written, and when the head went out */
function makeExchange(accept = 'text/event-stream') {
  const req: any = new EventEmitter();
  req.headers = { accept };
  req.method = 'GET';
  const res: any = new EventEmitter();
  res.headersSent = false;
  res.writableEnded = false;
  res.head = undefined as undefined | { status: number; headers: Record<string, string> };
  res.written = [] as string[];
  res.writeHead = (status: number, headers: Record<string, string>) => {
    res.head = { status, headers };
    res.headersSent = true;
  };
  res.write = (chunk: string) => {
    res.written.push(chunk);
    return true;
  };
  res.end = () => {
    res.writableEnded = true;
  };
  return { req, res };
}

describe('SSE middleware', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  /** Both registration forms, driven the way the framework drives them */
  const forms: Array<[string, (options: any, req: any, res: any) => Promise<boolean>]> = [
    [
      'createSSEMiddleware()',
      async (options, req, res) => {
        let reached = false;
        await createSSEMiddleware(options)(req, res, async () => {
          reached = true;
        });
        return reached;
      },
    ],
    [
      'middleware.sse()',
      async (options, req, res) => {
        const before: Array<(context: any) => Promise<void>> = [];
        await sse(options).install?.(
          { before: (_event: string, fn: any) => before.push(fn) } as any,
          {}
        );
        const context: any = { request: req, response: res };
        for (const hook of before) await hook(context);
        // the request goes on to its route unless a hook answered it
        return !res.headersSent && context.handled !== true;
      },
    ],
  ];

  describe.each(forms)('%s', (_name, install) => {
    it('sends nothing and starts no timer for a request that asks for an event stream', async () => {
      jest.useFakeTimers();
      const { req, res } = makeExchange('text/event-stream');

      const reachedRoute = await install({ heartbeat: 1000, retry: 3000, cors: true }, req, res);

      expect(reachedRoute).toBe(true);
      expect(res.head).toBeUndefined();
      expect(res.headersSent).toBe(false);
      jest.advanceTimersByTime(10_000);
      expect(res.written).toEqual([]);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('opens the stream when the handler calls res.sse()', async () => {
      jest.useFakeTimers();
      const { req, res } = makeExchange();
      await install({ heartbeat: 1000, retry: 3000 }, req, res);

      const stream = res.sse();
      expect(res.head).toEqual({
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
      stream.sendEvent({ n: 1 }, 'tick', '7');
      jest.advanceTimersByTime(1000);
      expect(res.written).toEqual([
        'retry: 3000\n\n',
        'id: 7\nevent: tick\ndata: {"n":1}\n\n',
        ': heartbeat\n\n',
      ]);

      // the same connection, however often it is asked for
      expect(res.sse()).toBe(stream);

      // the heartbeat stops with the connection
      req.emit('close');
      jest.advanceTimersByTime(5000);
      expect(res.written).toHaveLength(3);
      expect(res.writableEnded).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('opens it on the first res.sendEvent(), whatever the Accept header', async () => {
      const { req, res } = makeExchange('application/json');
      await install({}, req, res);

      res.sendEvent('hello');
      res.sendComment('note');
      res.sendRetry(500);

      expect(res.head?.status).toBe(200);
      expect(res.head?.headers['Content-Type']).toBe('text/event-stream');
      expect(res.written).toEqual(['data: hello\n\n', ': note\n\n', 'retry: 500\n\n']);
    });

    it('adds the CORS headers to the stream only, and only with cors: true', async () => {
      const open = makeExchange();
      await install({ cors: true }, open.req, open.res);
      open.res.sse();
      expect(open.res.head?.headers['Access-Control-Allow-Origin']).toBe('*');

      const plain = makeExchange();
      await install({}, plain.req, plain.res);
      plain.res.sse();
      expect(plain.res.head?.headers['Access-Control-Allow-Origin']).toBeUndefined();
    });

    it('leaves a head the handler wrote itself alone', async () => {
      const { req, res } = makeExchange();
      await install({ retry: 100 }, req, res);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Own': '1' });

      res.sse().sendEvent('x');

      expect(res.head?.headers['X-Own']).toBe('1');
      expect(res.written).toEqual(['retry: 100\n\n', 'data: x\n\n']);
    });
  });
});
