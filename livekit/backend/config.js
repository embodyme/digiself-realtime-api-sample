/**
 * Configuration module for the hybrid HTTP/WebSocket server.
 * Contains environment variables, constants, and global state management.
 */

import { config } from 'dotenv';

// Load environment variables from .env file
config();

/* ---------- API URL Constants ---------- */

/** Base URL for the Stream API WebSocket connection */
export const streamApiUrlBase = 'wss://stream-api.digiself.tech';

/** Base URL for the Digiself API */
export const digiselfApiBaseUrl = 'https://realtime-api.digiself.tech';

/* ---------- Environment Variables ---------- */

/** WebSocket URL for output connections */
export const outputWsUrl = process.env.OUTPUT_WEBSOCKET_URL;

/** OpenAI API key for Realtime API */
export const openaiApiKey = process.env.OPENAI_API_KEY;

/** Digiself API key for authentication */
export const digiselfApiKey = process.env.DIGISELF_API_KEY;

/** URL for audio file in file mode */
export const audioUrl = process.env.AUDIO_FILE_URL;

/* ---------- OpenAI Realtime Settings ---------- */

/** OpenAI Realtime model */
export const openaiRealtimeModel = 'gpt-realtime-2.1';

/** Reasoning effort. Minimal keeps the first reply fast. */
export const openaiRealtimeReasoningEffort = 'minimal';

/**
 * Text mode output token limit per response, including reasoning tokens.
 * A limit of 128 cut detailed Japanese answers off mid-sentence.
 */
export const openaiRealtimeMaxOutputTokens = 1024;

/** Server VAD: speech probability threshold, audio kept before speech, and silence that ends a turn */
export const openaiRealtimeVadThreshold = 0.5;
export const openaiRealtimeVadPrefixPaddingMs = 150;
export const openaiRealtimeVadSilenceDurationMs = 100;

/** Speed of the generated speech in audio mode */
export const openaiRealtimeAudioSpeed = 1.15;

/** System instructions for the assistant */
export const openaiInstructions =
  'You are a helpful AI assistant. Keep your responses concise and natural. You are having a real-time conversation with the user.';

/**
 * Builds the OpenAI Realtime session configuration.
 * Text mode requests text output only, which DigiSelf speaks with its own TTS.
 * Audio mode requests audio output, which is streamed to DigiSelf as PCM.
 *
 * @param {'text' | 'audio'} mode - The stream mode
 * @returns {object} Session configuration for session.update
 */
export function realtimeSessionConfig(mode) {
  return {
    type: 'realtime',
    model: openaiRealtimeModel,
    instructions: openaiInstructions,
    output_modalities: [mode === 'audio' ? 'audio' : 'text'],
    reasoning: { effort: openaiRealtimeReasoningEffort },
    // Audio output also counts its audio tokens (about 30 per second of speech), so the text
    // mode limit would stop spoken answers after about 33 s. Audio mode keeps OpenAI's default.
    max_output_tokens: mode === 'audio' ? 'inf' : openaiRealtimeMaxOutputTokens,
    audio: {
      input: {
        format: { type: 'audio/pcm', rate: 24000 },
        turn_detection: {
          type: 'server_vad',
          threshold: openaiRealtimeVadThreshold,
          prefix_padding_ms: openaiRealtimeVadPrefixPaddingMs,
          silence_duration_ms: openaiRealtimeVadSilenceDurationMs,
          create_response: true,
          interrupt_response: true
        }
      },
      ...(mode === 'audio'
        ? { output: { format: { type: 'audio/pcm', rate: 24000 }, speed: openaiRealtimeAudioSpeed } }
        : {})
    }
  };
}

/**
 * Builds the session configuration for a Browser Direct ephemeral token.
 * WebRTC carries the audio itself, so the PCM formats used over WebSocket are left out.
 *
 * @param {'text' | 'audio'} mode - The stream mode
 * @returns {object} Session configuration for client secrets
 */
export function browserRealtimeSessionConfig(mode) {
  const session = realtimeSessionConfig(mode);
  delete session.audio.input.format;
  delete session.audio.output?.format;
  return session;
}

/* ---------- Global State ---------- */

/**
 * Current global mode for the server.
 * Can be 'text', 'audio', or 'file'.
 * @type {'text' | 'audio' | 'file'}
 */
export let currentMode = 'text';

/**
 * Sets the global mode.
 * @param {'text' | 'audio' | 'file'} mode - The new mode to set
 */
export function setCurrentMode(mode) {
  currentMode = mode;
}

/**
 * Map storing client connection data.
 * Key: clientKey (roomName), Value: ClientData object
 * @type {Map<string, object>}
 */
export const clientConnections = new Map();

/**
 * Map storing voice IDs per room.
 * Key: roomName, Value: voice_id string
 * @type {Map<string, string>}
 */
export const roomVoiceIds = new Map();

/**
 * Map storing mode configuration per room.
 * Key: roomName, Value: mode ('text' | 'audio' | 'file')
 * @type {Map<string, string>}
 */
export const roomModes = new Map();

/* ---------- Startup Validation ---------- */

// Validate required environment variables for text and audio modes
if ((currentMode === 'text' || currentMode === 'audio') && !openaiApiKey) {
  console.error("OPENAI_API_KEY is required for text and audio modes");
  process.exit(1);
}
