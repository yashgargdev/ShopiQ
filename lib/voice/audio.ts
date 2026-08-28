/**
 * Audio validation.
 *
 * Uploaded audio is untrusted input that we are about to forward to a paid
 * third-party API. It is checked by MAGIC BYTES rather than by the declared
 * MIME type or the filename, for the same reason product image uploads are
 * (Phase 1 §37): a client can claim anything it likes about what it is sending.
 */

export const MAX_AUDIO_BYTES = 8 * 1024 * 1024; // 8 MB
export const MIN_AUDIO_BYTES = 512; // anything smaller is silence or a stub

/** The longest single utterance ShopiQ will accept. */
export const MAX_RECORDING_MS = 30_000;

export type AudioFormat = 'wav' | 'mp3' | 'ogg' | 'webm' | 'mp4' | 'flac';

const FORMAT_MIME: Record<AudioFormat, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  webm: 'audio/webm',
  mp4: 'audio/mp4',
  flac: 'audio/flac',
};

export class AudioValidationError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AudioValidationError';
    this.code = code;
  }
}

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0): boolean =>
  signature.every((byte, index) => bytes[offset + index] === byte);

const ascii = (bytes: Uint8Array, offset: number, length: number): string =>
  String.fromCharCode(...bytes.slice(offset, offset + length));

/**
 * Identify an audio container from its leading bytes. Returns null for
 * anything unrecognised — which is a rejection, not a guess.
 */
export function detectAudioFormat(bytes: Uint8Array): AudioFormat | null {
  if (bytes.length < 12) return null;

  // RIFF....WAVE
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') return 'wav';

  // "OggS"
  if (ascii(bytes, 0, 4) === 'OggS') return 'ogg';

  // EBML header — WebM / Matroska
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return 'webm';

  // "fLaC"
  if (ascii(bytes, 0, 4) === 'fLaC') return 'flac';

  // ISO base media: ....ftyp
  if (ascii(bytes, 4, 4) === 'ftyp') return 'mp4';

  // ID3 tag, or a raw MPEG frame sync (0xFF 0xEx/0xFx)
  if (ascii(bytes, 0, 3) === 'ID3') return 'mp3';
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'mp3';

  return null;
}

export interface ValidatedAudio {
  bytes: Buffer;
  format: AudioFormat;
  mimeType: string;
  byteLength: number;
}

/**
 * Validate an uploaded recording.
 *
 * Order matters: size is checked before format, so a 40 MB file is rejected
 * without inspecting it, and nothing oversized is ever held in memory longer
 * than it takes to say no.
 */
export function validateAudio(input: ArrayBuffer | Buffer | Uint8Array): ValidatedAudio {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input as ArrayBuffer);

  if (bytes.byteLength > MAX_AUDIO_BYTES) {
    throw new AudioValidationError(
      'AUDIO_TOO_LARGE',
      `That recording is too large. Keep it under ${Math.round(MAX_AUDIO_BYTES / 1024 / 1024)} MB.`,
    );
  }
  if (bytes.byteLength < MIN_AUDIO_BYTES) {
    throw new AudioValidationError('AUDIO_TOO_SHORT', "I didn't hear anything. Try again.");
  }

  const format = detectAudioFormat(bytes);
  if (!format) {
    throw new AudioValidationError(
      'AUDIO_UNSUPPORTED',
      "That audio format isn't supported. Try recording again.",
    );
  }

  return { bytes, format, mimeType: FORMAT_MIME[format], byteLength: bytes.byteLength };
}

/**
 * Duration of a PCM WAV, read from its header.
 *
 * Only meaningful for WAV — compressed containers need a decoder, and this is
 * a guard rail rather than a media library. Returns null when it cannot say.
 */
export function wavDurationMs(bytes: Buffer): number | null {
  if (bytes.length < 44) return null;
  // Buffer.toString takes (encoding, start, end) — passing a length as the
  // third argument silently yields an empty string rather than an error.
  if (bytes.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (bytes.toString('ascii', 8, 12) !== 'WAVE') return null;

  const byteRate = bytes.readUInt32LE(28);
  if (!byteRate) return null;

  // Walk the chunk list to find "data" rather than assuming it is at 36.
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === 'data') return Math.round((size / byteRate) * 1000);
    offset += 8 + size + (size % 2);
  }
  return null;
}
