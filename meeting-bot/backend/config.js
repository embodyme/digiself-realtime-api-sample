/**
 * Configuration module for the meeting bot backend server.
 * Contains environment variables, constants, and global state management.
 */

import { config } from 'dotenv';

// Load environment variables from .env file
config();

/* ---------- API URL Constants ---------- */

/** Base URL for the Stream API WebSocket connection */
export const streamApiUrlBase = 'wss://stream-api.digiself.tech';

/** Base URL for the Digiself API */
export const digiselfApiBaseUrl = 'https://app.digiself.tech';

/* ---------- Environment Variables ---------- */

/** WebSocket URL for avatar output connections */
export const outputWsUrl = process.env.OUTPUT_WEBSOCKET_URL;

/** OpenAI API key for Realtime API */
export const openaiApiKey = process.env.OPENAI_API_KEY;

/** Digiself API key for authentication */
export const digiselfApiKey = process.env.DIGISELF_API_KEY;

/** URL for audio file in file mode */
export const audioUrl = process.env.AUDIO_FILE_URL;

/** Authorization token for audio file access */
export const audioAuthToken = process.env.AUDIO_AUTH_TOKEN;

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
 * Map storing bot connection data.
 * Key: botId, Value: BotData object
 * @type {Map<string, object>}
 */
export const botConnections = new Map();

/**
 * Map storing voice IDs per bot.
 * Key: botId, Value: voice_id string
 * @type {Map<string, string>}
 */
export const botVoiceIds = new Map();

/**
 * Map storing mode configuration per bot.
 * Key: botId, Value: mode ('text' | 'audio' | 'file')
 * @type {Map<string, string>}
 */
export const botModes = new Map();

/* ---------- Startup Validation ---------- */

// Validate required environment variables
if (!outputWsUrl) {
  console.error('OUTPUT_WEBSOCKET_URL is required');
  process.exit(1);
}

if ((currentMode === 'text' || currentMode === 'audio') && !openaiApiKey) {
  console.error('OPENAI_API_KEY is required for text and audio modes');
  process.exit(1);
}
