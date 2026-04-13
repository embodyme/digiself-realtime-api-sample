/**
 * Bot connection management module for meeting bot backend.
 * Handles Stream API connections, OpenAI Realtime sessions,
 * metadata transmission, and bot lifecycle management.
 */

import WebSocket from 'ws';
import { RealtimeAgent, RealtimeSession } from '@openai/agents/realtime';
import {
  streamApiUrlBase,
  openaiApiKey,
  digiselfApiKey,
  audioUrl,
  audioAuthToken,
  currentMode,
  botConnections,
  botVoiceIds,
  botModes
} from './config.js';

/* ---------- Helper Functions ---------- */

/**
 * Gets the mode for a specific bot, falling back to global mode.
 *
 * @param {string} botId - The bot ID to get mode for
 * @returns {string} The mode ('text', 'audio', or 'file')
 */
export function getBotMode(botId) {
  return botModes.get(botId) || currentMode;
}

/* ---------- Stream API WebSocket Connection ---------- */

/**
 * Creates a WebSocket connection to the Stream API for a bot.
 * Implements exponential backoff for reconnection attempts (max 30 seconds).
 *
 * @param {string} botId - The bot ID for the connection
 * @returns {Promise<WebSocket>} Resolves with the connected WebSocket
 */
export function createStreamAPIConnection(botId) {
  return new Promise((resolve, reject) => {
    if (!streamApiUrlBase) {
      reject(new Error('streamApiUrlBase is not defined'));
      return;
    }

    const urlWithParams = `${streamApiUrlBase}/api/bots/${encodeURIComponent(botId)}/speak`;
    const headers = {};
    if (digiselfApiKey) {
      headers['x-api-key'] = digiselfApiKey;
    }

    const outputWs = new WebSocket(urlWithParams, { headers });
    let reconnectAttempts = 0;
    let reconnectTimer;
    let pingTimer;

    /**
     * Attempts to reconnect with exponential backoff.
     */
    function attemptReconnect() {
      const retryDelay = Math.min(1000 * 2 ** reconnectAttempts, 30_000);
      console.warn(`[output:${botId}] closed  reconnecting in ${retryDelay} ms (attempt #${reconnectAttempts + 1})`);

      clearInterval(pingTimer);
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        reconnectAttempts++;
        const reconnectHeaders = {};
        if (digiselfApiKey) {
          reconnectHeaders['x-api-key'] = digiselfApiKey;
        }
        const newStreamWs = new WebSocket(urlWithParams, { headers: reconnectHeaders });
        setupStreamAPIConnection(newStreamWs, botId, attemptReconnect);
      }, retryDelay);
    }

    /**
     * Sets up event handlers for the Stream API WebSocket.
     *
     * @param {WebSocket} ws - The WebSocket instance
     * @param {string} botId - The bot ID
     * @param {Function} reconnectFn - Function to call for reconnection
     */
    function setupStreamAPIConnection(ws, botId, reconnectFn) {
      ws.on('open', () => {
        clearTimeout(reconnectTimer);
        reconnectAttempts = 0;
        console.log(`[output:${botId}] connected`);

        const botData = botConnections.get(botId);
        if (botData) {
          // Close existing connection if any
          if (botData.streamWs && botData.streamWs !== ws) {
            botData.streamWs.removeAllListeners();
            if (botData.streamWs.readyState === WebSocket.OPEN) {
              botData.streamWs.close();
            }
          }
          botData.streamWs = ws;
        }

        // Start ping interval to keep connection alive
        clearInterval(pingTimer);
        pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            console.log(`[output:${botId}] ping`);
            ws.ping();
          }
        }, 3_000);

        resolve(ws);
      });

      // Handle unexpected HTTP responses (authentication errors, etc.)
      ws.on('unexpected-response', (request, response) => {
        console.log(`[output:${botId}] HTTP ${response.statusCode} ${response.statusMessage}`);

        let body = '';
        response.on('data', (chunk) => {
          body += chunk.toString();
        });
        response.on('end', () => {
          console.log(`[output:${botId}] Response: ${body}`);
        });

        if (response.statusCode === 401) {
          console.log(`[output:${botId}] Authentication failed`);
        }

        if (response.statusCode === 404) {
          console.log(`[output:${botId}] Bot not found (404)`);
        }
      });

      ws.on('error', (e) => {
        console.log(`[output:${botId}] WebSocket error: ${e.message}`);
      });

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          console.log(`[output:${botId}] received message:`, message);

          // Handle ack response for metadata confirmation
          if (message.type === 'ack') {
            const botData = botConnections.get(botId);
            if (botData && message.payload) {
              if (message.payload.config_type === 'text_stream') {
                botData.textMetadataSent = true;
                console.log(`[output:${botId}] text metadata ack received`);
              } else if (message.payload.config_type === 'audio_stream') {
                botData.audioMetadataSent = true;
                console.log(`[output:${botId}] audio metadata ack received`);
              }
            }
          }
        } catch (error) {
          console.log(`[output:${botId}] received raw message:`, data.toString());
          console.error(`[output:${botId}] failed to parse message as JSON:`, error);
        }
      });

      ws.on('close', () => {
        if (botConnections.has(botId)) {
          reconnectFn();
        }
      });
    }

    setupStreamAPIConnection(outputWs, botId, attemptReconnect);
  });
}

/* ---------- OpenAI Realtime Connection ---------- */

/**
 * Creates an OpenAI Realtime API connection for a bot.
 * Configures audio format (PCM16, 24kHz) and server-side VAD.
 *
 * @param {string} botId - The bot ID
 * @returns {Promise<object>} The bot data with session and agent
 */
export async function createRealtimeConnection(botId) {
  const botData = botConnections.get(botId);

  // Skip for file mode (no AI session needed)
  if (botData && botData.mode === 'file') return;

  console.log(`[OpenAI Realtime] Creating new connection for bot: ${botId}`);

  const agent = new RealtimeAgent({
    apiKey: openaiApiKey,
    name: 'assistant',
    instructions: `You are a helpful AI assistant.
    Keep your responses concise and natural. You are having a real-time conversation with the user.`,
  });

  const session = new RealtimeSession(agent, {
    model: 'gpt-realtime',
    transport: 'websocket',
    config: {
      audio: {
        input: {
          format: {
            type: 'audio/pcm',
            rate: 24000
          }
        },
        output: {
          format: {
            type: 'audio/pcm',
            rate: 24000
          }
        },
      },
      turn_detection: {
        type: 'server_vad',
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 500
      }
    },
  });

  try {
    await session.connect({
      apiKey: openaiApiKey,
    });
    const updatedBotData = botConnections.get(botId);
    updatedBotData.session = session;
    updatedBotData.agent = agent;

    setupRealtimeEventHandlers(session, botId);

    console.log(`[OpenAI Realtime] Connection established for bot: ${botId}`);
    return updatedBotData;
  } catch (error) {
    console.error(`[OpenAI Realtime] Failed to create connection for bot ${botId}:`, error);
    throw error;
  }
}

/* ---------- Realtime Event Handlers ---------- */

/**
 * Sets up event handlers for OpenAI Realtime session transport events.
 * Routes text and audio responses to the Stream API based on bot mode.
 *
 * @param {RealtimeSession} session - The OpenAI Realtime session
 * @param {string} botId - The bot ID
 */
function setupRealtimeEventHandlers(session, botId) {
  const botData = botConnections.get(botId);
  if (!botData) return;

  session.transport.on('*', (event) => {
    switch (event.type) {
      case 'input_audio_buffer.speech_started': {
        console.log('[OpenAI] Speech started detected');
        break;
      }

      case 'input_audio_buffer.speech_stopped': {
        console.log('[OpenAI] Speech stopped, triggering response');
        break;
      }

      case 'input_audio_buffer.committed': {
        console.log('[OpenAI] Audio buffer committed');
        break;
      }

      case 'response.created': {
        // Generate a new request_id when a new response starts
        botData.currentRequestId = `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        console.log('[OpenAI] Response created, new request_id:', botData.currentRequestId);
        break;
      }

      case 'response.output_audio_transcript.delta': {
        // Send text chunks immediately as they arrive (streaming)
        const chunkText = event.delta;
        if (chunkText) {
          console.log(`[OpenAI Realtime] Text chunk for bot ${botId}:`, chunkText);
          // Send text chunks if bot mode is 'text'
          if (botData.mode === 'text' &&
              botData.streamWs &&
              botData.streamWs.readyState === WebSocket.OPEN &&
              botData.textMetadataSent) {
            // Ensure we have a request_id
            if (!botData.currentRequestId) {
              botData.currentRequestId = `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
            }
            botData.streamWs.send(JSON.stringify({
              type: 'text_stream',
              payload: {
                text: chunkText,
                request_id: botData.currentRequestId
              }
            }));
          }
        }
        break;
      }

      case 'response.output_audio_transcript.done': {
        const text = event.transcript;
        console.log(`[OpenAI Realtime] Text response completed for bot ${botId}:`, text);
        break;
      }

      case 'response.output_audio.delta': {
        console.log('audio delta received', performance.now());
        const delta = event.delta;
        console.log(`[OpenAI] Delta type: ${typeof delta}, length: ${delta?.length}, preview: ${delta?.substring?.(0, 50)}`);

        // Only send audio data if bot mode is 'audio'
        if (botData.mode === 'audio' &&
            delta &&
            botData.streamWs &&
            botData.streamWs.readyState === WebSocket.OPEN &&
            botData.audioMetadataSent) {
          // Ensure we have a request_id
          if (!botData.currentRequestId) {
            botData.currentRequestId = `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
          }

          const message = {
            type: 'audio_stream',
            payload: {
              audio_data: delta,
              request_id: botData.currentRequestId
            }
          };
          console.log(`[OpenAI] Sending message:`, JSON.stringify(message).substring(0, 200));
          botData.streamWs.send(JSON.stringify(message));
        }
        break;
      }

      case 'response.output_audio.done': {
        console.log(`[OpenAI] Turn completed, request_id: ${botData.currentRequestId}`);
        // Reset request_id when response is done
        botData.currentRequestId = null;
        break;
      }
    }
  });

  session.on('error', (error) => {
    console.error(`[OpenAI Realtime] Error for bot ${botId}:`, error);
  });
}

/* ---------- Metadata Functions ---------- */

/**
 * Sends text stream configuration metadata to the Stream API.
 * Must be called before sending text chunks in text mode.
 *
 * @param {string} botId - The bot ID
 * @param {string} voiceId - The voice ID for text-to-speech
 * @returns {Promise<void>}
 */
export function sendTextMetadata(botId, voiceId) {
  return new Promise((resolve, reject) => {
    const botData = botConnections.get(botId);
    if (!botData) {
      reject(new Error('Bot data not found'));
      return;
    }

    if (botData.mode !== 'text') {
      resolve();
      return;
    }

    if (botData.streamWs && botData.streamWs.readyState === WebSocket.OPEN) {
      try {
        const metadataMessage = {
          type: 'config',
          payload: {
            config_type: 'text_stream',
            config: {
              voice_id: voiceId
            }
          }
        };

        botData.streamWs.send(JSON.stringify(metadataMessage), (error) => {
          if (error) {
            console.error(`[OpenAI:${botId}] Error sending text metadata:`, error);
            reject(error);
          } else {
            console.log(`[OpenAI:${botId}] Sent text metadata with voice_id: ${voiceId}`);
            resolve();
          }
        });
      } catch (error) {
        console.error(`[OpenAI:${botId}] Error sending text metadata:`, error);
        reject(error);
      }
    } else {
      reject(new Error('Output WebSocket not ready'));
    }
  });
}

/**
 * Sends audio stream configuration metadata to the Stream API.
 * Must be called before sending audio chunks in audio mode.
 *
 * @param {string} botId - The bot ID
 * @returns {Promise<void>}
 */
export function sendAudioMetadata(botId) {
  return new Promise((resolve, reject) => {
    const botData = botConnections.get(botId);
    if (!botData) {
      reject(new Error('Bot data not found'));
      return;
    }

    if (botData.mode !== 'audio') {
      resolve();
      return;
    }

    if (botData.streamWs && botData.streamWs.readyState === WebSocket.OPEN) {
      try {
        const metadataMessage = {
          type: 'config',
          payload: {
            config_type: 'audio_stream',
            config: {
              format: 'audio/pcm',
              channels: 1,
              sample_rate: 24000,
              encoding: 'linear16'
            }
          }
        };

        botData.streamWs.send(JSON.stringify(metadataMessage), (error) => {
          if (error) {
            console.error(`[OpenAI:${botId}] Error sending audio metadata:`, error);
            reject(error);
          } else {
            console.log(`[OpenAI:${botId}] Sent audio metadata`);
            resolve();
          }
        });
      } catch (error) {
        console.error(`[OpenAI:${botId}] Error sending audio metadata:`, error);
        reject(error);
      }
    } else {
      reject(new Error('Output WebSocket not ready'));
    }
  });
}

/**
 * Sends audio file URL to the Stream API for file mode playback.
 * Includes optional Authorization header if audioAuthToken is configured.
 *
 * @param {string} botId - The bot ID
 */
export function sendAudioUrl(botId) {
  const botData = botConnections.get(botId);
  if (!botData) {
    console.error(`[AudioURL] No bot data found for ${botId}`);
    return;
  }

  if (botData.mode !== 'file') return;

  if (botData.streamWs &&
      botData.streamWs.readyState === WebSocket.OPEN &&
      !botData.audioRequestProcessed) {
    botData.audioRequestProcessed = true;
    try {
      const payload = {
        url: audioUrl,
      };

      // Add Authorization header if token is provided
      if (audioAuthToken) {
        payload.header = {
          Authorization: audioAuthToken
        };
        console.log(`[AudioURL:${botId}] Sending audio URL with Authorization header`);
      }

      const message = {
        type: 'audio_file',
        payload: payload
      };

      botData.streamWs.send(JSON.stringify(message));
      console.log(`[AudioURL:${botId}] Sent audio URL: ${audioUrl}`);
    } catch (error) {
      console.error(`[AudioURL:${botId}] Error sending audio URL:`, error);
    }
  } else {
    console.warn(`[AudioURL:${botId}] Output WebSocket not ready`);
  }
}

/* ---------- Cleanup Functions ---------- */

/**
 * Cleans up bot connection resources.
 * Closes OpenAI session and Stream API WebSocket, removes from connections map.
 *
 * @param {string} botId - The bot ID to clean up
 */
export function cleanupBotConnection(botId) {
  const botData = botConnections.get(botId);
  if (botData) {
    console.log(`[Cleanup] Cleaning up connection for bot: ${botId}`);

    if (botData.session) {
      try {
        botData.session.close();
      } catch (e) {
        console.error(`[Cleanup] Error closing OpenAI session for bot ${botId}:`, e);
      }
    }

    if (botData.streamWs) {
      botData.streamWs.removeAllListeners();
      if (botData.streamWs.readyState === WebSocket.OPEN) {
        botData.streamWs.close();
      }
    }

    botConnections.delete(botId);
  }
}

/* ---------- Mode Switching ---------- */

/**
 * Dynamically switches a bot's operational mode.
 * Handles cleanup of old resources and setup of new connections as needed.
 *
 * @param {string} botId - The bot ID
 * @param {'text' | 'audio' | 'file'} newMode - The new mode to switch to
 * @returns {Promise<boolean>} True if switch was successful
 */
export async function switchBotMode(botId, newMode) {
  const botData = botConnections.get(botId);
  if (!botData) {
    console.error(`[Mode Switch] No bot data found for ${botId}`);
    return false;
  }

  if (newMode !== 'audio' && newMode !== 'text' && newMode !== 'file') {
    console.error(`[Mode Switch] Invalid mode: ${newMode}`);
    return false;
  }

  const oldMode = botData.mode;
  if (oldMode === newMode) {
    console.log(`[Mode Switch] Bot ${botId} is already in ${newMode} mode`);
    return true;
  }

  // If bot is still initializing, just update the mode
  if (!botData.session && !botData.streamWs) {
    console.log(`[Mode Switch] Bot ${botId} is still initializing. Updating mode from ${oldMode} to ${newMode}`);
    botData.mode = newMode;
    return true;
  }

  console.log(`[Mode Switch] Switching bot ${botId} from ${oldMode} to ${newMode}`);

  // Close OpenAI session when switching to file mode
  if ((oldMode === 'text' || oldMode === 'audio') && newMode === 'file' && botData.session) {
    console.log(`[Mode Switch] Closing OpenAI session for bot ${botId} (switching to file mode)`);
    try {
      botData.session.close?.();
    } catch (e) {
      console.error(`[Mode Switch] Error closing OpenAI session:`, e);
    }
    botData.session = null;
    botData.agent = null;
  }

  botData.mode = newMode;

  // Reset metadata flags for the new mode
  botData.textMetadataSent = false;
  botData.audioMetadataSent = false;
  botData.audioRequestProcessed = false;

  try {
    if (newMode === 'text' || newMode === 'audio') {
      // Reuse existing OpenAI session when switching between text and audio modes
      if (!botData.session) {
        await createRealtimeConnection(botId);
      } else {
        console.log(`[Mode Switch] Reusing existing OpenAI session for bot ${botId}`);
      }

      // Reuse existing streamWs or create new one if needed
      if (!botData.streamWs || botData.streamWs.readyState !== WebSocket.OPEN) {
        console.log(`[Mode Switch] Creating new Stream API WebSocket for bot ${botId}`);
        await createStreamAPIConnection(botId);
      } else {
        console.log(`[Mode Switch] Reusing existing Stream API WebSocket for bot ${botId}`);
      }

      // Wait for streamWs to be ready (max 5 seconds)
      let waitCount = 0;
      while ((!botData.streamWs || botData.streamWs.readyState !== WebSocket.OPEN) && waitCount < 50) {
        await new Promise(resolve => setTimeout(resolve, 100));
        waitCount++;
      }

      if (!botData.streamWs || botData.streamWs.readyState !== WebSocket.OPEN) {
        throw new Error('Output WebSocket not ready after 5 seconds');
      }

      // Send appropriate metadata based on new mode
      if (newMode === 'text') {
        const voiceId = botVoiceIds.has(botId) ? botVoiceIds.get(botId) : '';
        await sendTextMetadata(botId, voiceId);
      } else if (newMode === 'audio') {
        await sendAudioMetadata(botId);
      }
    } else if (newMode === 'file') {
      sendAudioUrl(botId);
    }

    console.log(`[Mode Switch] Successfully switched bot ${botId} to ${newMode} mode`);
    return true;
  } catch (error) {
    console.error(`[Mode Switch] Error switching bot ${botId} to ${newMode}:`, error.message);
    botData.mode = oldMode;  // Rollback on failure
    console.log(`[Mode Switch] Rolled back to ${oldMode} mode`);
    return false;
  }
}
