/**
 * Size-bounded body readers for responses from other services and external APIs.
 * Aborting the signal given to `fetch` also aborts these reads.
 */
export class ResponseTooLargeError extends Error {
  readonly code = 'response_too_large';

  constructor(readonly maxBytes: number) {
    super(`response body exceeds ${maxBytes} bytes`);
    this.name = 'ResponseTooLargeError';
  }
}

export class InvalidJsonResponseError extends Error {
  readonly code = 'invalid_json_response';

  constructor(options?: ErrorOptions) {
    super('response body is not valid UTF-8 JSON', options);
    this.name = 'InvalidJsonResponseError';
  }
}

/** Reads the body as UTF-8 (invalid sequences become U+FFFD); a missing body reads as ''. */
export async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const bytes = await readBoundedBytes(response, maxBytes);
  return new TextDecoder().decode(bytes);
}

/** Parses the body as JSON; invalid UTF-8, an empty body or bad JSON throw InvalidJsonResponseError. */
export async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const bytes = await readBoundedBytes(response, maxBytes);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    throw new InvalidJsonResponseError({ cause: error });
  }
}

async function readBoundedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('maxBytes must be a non-negative integer');
  if (declaredLength(response) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ResponseTooLargeError(maxBytes);
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);
  return readChunks(reader, maxBytes);
}

async function readChunks(reader: ReadableStreamDefaultReader<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, length);
      length += value.byteLength;
      if (length > maxBytes) throw new ResponseTooLargeError(maxBytes);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** A malformed Content-Length is ignored; the running byte count still applies. */
function declaredLength(response: Response): number {
  const header = response.headers.get('content-length');
  if (header === null || !/^\d+$/.test(header.trim())) return 0;
  return Number(header);
}
