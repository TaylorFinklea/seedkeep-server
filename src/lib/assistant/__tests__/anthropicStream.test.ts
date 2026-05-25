import { describe, it, expect } from 'vitest';
import { parseSSE, type AnthropicEvent } from '../anthropicStream';

// Build a ReadableStream<Uint8Array> from an array of string chunks so we
// can test the SSE parser's behavior across chunk boundaries.
function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(enc.encode(chunks[i++]));
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<AnthropicEvent[]> {
  const out: AnthropicEvent[] = [];
  for await (const ev of parseSSE(stream)) out.push(ev);
  return out;
}

describe('parseSSE', () => {
  it('parses a single complete event', async () => {
    const sse = 'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","model":"opus"}}\n\n';
    const events = await collect(streamFromChunks([sse]));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('message_start');
  });

  it('parses multiple events in one buffer', async () => {
    const sse =
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","model":"opus"}}\n\n' +
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    const events = await collect(streamFromChunks([sse]));
    expect(events.map((e) => e.type)).toEqual([
      'message_start', 'content_block_start', 'content_block_delta', 'message_stop',
    ]);
  });

  it('handles an event split across two chunks (buffer boundary)', async () => {
    const event = 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello world"}}\n\n';
    // Split mid-event at byte 30
    const chunks = [event.slice(0, 30), event.slice(30)];
    const events = await collect(streamFromChunks(chunks));
    expect(events).toHaveLength(1);
    if (events[0].type !== 'content_block_delta') throw new Error('wrong type');
    if (events[0].delta.type !== 'text_delta') throw new Error('wrong delta type');
    expect(events[0].delta.text).toBe('Hello world');
  });

  it('handles an event boundary split between two chunks', async () => {
    const sse =
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","model":"opus"}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    // Split right at the \n\n boundary
    const idx = sse.indexOf('\n\n') + 1; // include the first \n in chunk 1
    const events = await collect(streamFromChunks([sse.slice(0, idx), sse.slice(idx)]));
    expect(events.map((e) => e.type)).toEqual(['message_start', 'message_stop']);
  });

  it('ignores comment lines (heartbeats)', async () => {
    const sse =
      ': this is a heartbeat\n\n' +
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","model":"opus"}}\n\n';
    const events = await collect(streamFromChunks([sse]));
    expect(events.map((e) => e.type)).toEqual(['message_start']);
  });

  it('parses a tool_use start event with input_json_delta deltas', async () => {
    const sse =
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tc1","name":"list_seeds","input":{}}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"state\\":"}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"active\\"}"}}\n\n' +
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n';
    const events = await collect(streamFromChunks([sse]));
    expect(events.map((e) => e.type)).toEqual([
      'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop',
    ]);
  });

  it('skips malformed JSON without crashing', async () => {
    const sse =
      'event: bad\ndata: this is not json\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    const events = await collect(streamFromChunks([sse]));
    expect(events.map((e) => e.type)).toEqual(['message_stop']);
  });

  it('emits an error event from the stream', async () => {
    const sse = 'event: error\ndata: {"type":"error","error":{"type":"overloaded","message":"too busy"}}\n\n';
    const events = await collect(streamFromChunks([sse]));
    expect(events).toHaveLength(1);
    if (events[0].type !== 'error') throw new Error('expected error event');
    expect(events[0].error.type).toBe('overloaded');
  });

  it('flushes a final event with no trailing \\n\\n', async () => {
    const sse = 'event: message_stop\ndata: {"type":"message_stop"}';
    const events = await collect(streamFromChunks([sse]));
    expect(events.map((e) => e.type)).toEqual(['message_stop']);
  });
});
