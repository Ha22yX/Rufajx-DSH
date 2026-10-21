// Legacy build entry: media decoding is now provided by the offline direct player.
// Kept as a compatibility alias; no FFmpeg download, conversion or media cache.
export { prepareMediaPlayerRuntime as prepareMediaCodecRuntime } from './media-player-runtime.mjs';
