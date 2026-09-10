export function isSuccessfulJson(text: string): boolean {
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const object = value as Record<string, unknown>;
    return !object.error && object.type !== 'error' && !['failed', 'incomplete', 'cancelled'].includes(String(object.status));
  } catch {
    return false;
  }
}

export class StreamCompletion {
  private buffer = '';
  private readonly decoder = new TextDecoder();
  private failed = false;
  private terminal = false;

  constructor(private readonly path: string) {}

  add(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    this.drain();
    if (this.buffer.length > 4 * 1024 * 1024) {
      this.failed = true;
      this.buffer = '';
    }
  }

  finish(): boolean {
    this.buffer += this.decoder.decode();
    this.drain();
    if (this.buffer.trim()) this.failed = true;
    return this.terminal && !this.failed;
  }

  private drain(): void {
    for (;;) {
      const boundary = /\r?\n\r?\n/.exec(this.buffer);
      if (!boundary) return;
      this.event(this.buffer.slice(0, boundary.index));
      this.buffer = this.buffer.slice(boundary.index + boundary[0].length);
    }
  }

  private event(text: string): void {
    const lines = text.split(/\r?\n/);
    const name = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
    if (name === 'error') this.failed = true;
    const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    if (data.trim() === '[DONE]') {
      if (this.path === '/chat/completions') this.terminal = true;
      return;
    }
    try {
      const value = JSON.parse(data) as Record<string, unknown>;
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        this.failed = true;
        return;
      }
      const type = value.type ?? name;
      if (value.error || ['error', 'response.failed', 'response.incomplete', 'response.cancelled'].includes(String(type))) this.failed = true;
      if (this.path === '/v1/messages' && type === 'message_stop') this.terminal = true;
      if (this.path === '/responses' && type === 'response.completed') {
        const response = value.response as Record<string, unknown> | undefined;
        if (response?.status && response.status !== 'completed' || response?.error) this.failed = true;
        else this.terminal = true;
      }
    } catch {
      this.failed = true;
    }
  }
}
