/**
 * Client connection management module.
 * Handles Stream API connections, OpenAI Realtime sessions,
 * metadata transmission, and client lifecycle management.
 */

import WebSocket from 'ws';
import { RealtimeAgent, RealtimeSession } from '@openai/agents/realtime';
import {
  streamApiUrlBase,
  openaiApiKey,
  digiselfApiKey,
  audioUrl,
  currentMode,
  clientConnections,
  roomVoiceIds,
  roomModes
} from './config.js';

/* ---------- Helper Functions ---------- */

/**
 * Generates a unique key for client identification.
 * Currently uses only roomName (participantId is ignored).
 *
 * @param {string} roomName - The room name
 * @param {string} participantId - The participant ID (currently unused)
 * @returns {string} The client key
 */
export const clientKey = (roomName, participantId) => `${roomName}`;

/**
 * Gets the mode for a specific room, falling back to global mode.
 *
 * @param {string} roomName - The room name to get mode for
 * @returns {string} The mode ('text', 'audio', or 'file')
 */
export function getRoomMode(roomName) {
  return roomModes.get(roomName) || currentMode;
}

/* ---------- Stream API WebSocket Connection ---------- */

/**
 * Creates a WebSocket connection to the Stream API with automatic reconnection.
 * Implements exponential backoff for reconnection attempts (max 30 seconds).
 *
 * @param {string} roomName - The room name for the connection
 * @param {string} participantId - The participant ID
 * @returns {Promise<WebSocket>} Resolves with the connected WebSocket
 */
export function createStreamAPIConnection(roomName, participantId) {
  return new Promise((resolve, reject) => {
    if (!streamApiUrlBase) {
      reject(new Error('streamApiUrlBase is not defined'));
      return;
    }

    const urlWithParams = `${streamApiUrlBase}/api/rooms/${encodeURIComponent(roomName)}/speak`;
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
      console.warn(`[output:${participantId}] closed – reconnecting in ${retryDelay} ms (attempt #${reconnectAttempts + 1})`);

      clearInterval(pingTimer);
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        reconnectAttempts++;
        const reconnectHeaders = {};
        if (digiselfApiKey) {
          reconnectHeaders['x-api-key'] = digiselfApiKey;
        }
        const newStreamWs = new WebSocket(urlWithParams, { headers: reconnectHeaders });
        setupStreamAPIConnection(newStreamWs, roomName, participantId, attemptReconnect);
      }, retryDelay);
    }

    /**
     * Sets up event handlers for the Stream API WebSocket.
     *
     * @param {WebSocket} ws - The WebSocket instance
     * @param {string} roomName - The room name
     * @param {string} participantId - The participant ID
     * @param {Function} reconnectFn - Function to call for reconnection
     */
    function setupStreamAPIConnection(ws, roomName, participantId, reconnectFn) {
      const key = clientKey(roomName, participantId);

      ws.on('open', () => {
        clearTimeout(reconnectTimer);
        reconnectAttempts = 0;
        console.log(`[output:${participantId}] connected`);

        const clientData = clientConnections.get(key);
        if (clientData) {
          // Close existing connection if any
          if (clientData.streamWs && clientData.streamWs !== ws) {
            clientData.streamWs.removeAllListeners();
            if (clientData.streamWs.readyState === WebSocket.OPEN) {
              clientData.streamWs.close();
            }
          }
          clientData.streamWs = ws;
        }

        // Start ping interval to keep connection alive
        clearInterval(pingTimer);
        pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            console.log(`[output:${participantId}] ping`);
            ws.ping();
          }
        }, 3_000);

        resolve(ws);
      });

      ws.on('error', (e) => {
        console.log(`[output:${participantId}] WebSocket error: ${e.message}`);
      });

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          console.log(`[output:${participantId}] received message:`, message);

          // Handle ack response for metadata confirmation
          if (message.type === 'ack') {
            const clientData = clientConnections.get(key);
            if (clientData && message.payload) {
              if (message.payload.config_type === 'text_stream') {
                clientData.textMetadataSent = true;
                console.log(`[output:${participantId}] text metadata ack received`);
              } else if (message.payload.config_type === 'audio_stream') {
                clientData.audioMetadataSent = true;
                console.log(`[output:${participantId}] audio metadata ack received`);
              }
            }
          }
        } catch (error) {
          console.log(`[output:${participantId}] received raw message:`, data.toString());
          console.error(`[output:${participantId}] failed to parse message as JSON:`, error);
        }
      });

      ws.on('close', () => {
        if (clientConnections.has(key)) {
          reconnectFn();
        }
      });
    }

    setupStreamAPIConnection(outputWs, roomName, participantId, attemptReconnect);
  });
}

/* ---------- OpenAI Realtime Connection ---------- */

/**
 * Creates an OpenAI Realtime API connection for a client.
 * Configures audio format (PCM16, 24kHz) and server-side VAD.
 *
 * @param {string} participantId - The participant ID
 * @param {string} roomName - The room name
 * @returns {Promise<object>} The client data with session and agent
 */
export async function createRealtimeConnection(participantId, roomName) {
  const key = clientKey(roomName, participantId);
  const clientData = clientConnections.get(key);

  // Skip for file mode (no AI session needed)
  if (clientData && clientData.mode === "file") return;

  console.log(`[OpenAI Realtime] Creating new connection for ${key}`);

  const agent = new RealtimeAgent({
    apiKey: openaiApiKey,
    name: "assistant",
    instructions: `You are a helpful AI assistant. Keep your responses concise and natural. You are having a real-time conversation with the user.`,
  });

  const session = new RealtimeSession(agent, {
    model: 'gpt-realtime',
    transport: "websocket",
    config: {
      audio: {
        input: {
          format: {
            type: "audio/pcm",
            rate: 24000
          }
        },
        output: {
          format: {
            type: "audio/pcm",
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
    const clientData = clientConnections.get(key);
    clientData.session = session;
    clientData.agent = agent;

    setupRealtimeEventHandlers(session, key);

    console.log(`[OpenAI Realtime] Connection established for ${key}`);
    return clientData;

  } catch (error) {
    console.error(`[OpenAI Realtime] Failed to create connection for ${key}:`, error);
    throw error;
  }
}

/* ---------- Realtime Event Handlers ---------- */

/**
 * Sets up event handlers for OpenAI Realtime session transport events.
 * Routes text and audio responses to the Stream API based on client mode.
 *
 * @param {RealtimeSession} session - The OpenAI Realtime session
 * @param {string} key - The client key
 */
function setupRealtimeEventHandlers(session, key) {
  const clientData = clientConnections.get(key);
  if (!clientData) return;

  session.transport.on('*', (event) => {
    switch (event.type) {
      case "input_audio_buffer.speech_started": {
        console.log("[OpenAI] ✅ Speech started detected");
        break;
      }

      case "input_audio_buffer.speech_stopped": {
        console.log("[OpenAI] ✅ Speech stopped, triggering response");
        break;
      }

      case "input_audio_buffer.committed": {
        console.log("[OpenAI] ✅ Audio buffer committed");
        break;
      }

      case "response.created": {
        // Generate a new request_id when a new response starts
        clientData.currentOpenAIRequestId = `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        console.log("[OpenAI] ✅ Response created, new request_id:", clientData.currentOpenAIRequestId);
        break;
      }

      case "response.output_audio_transcript.delta": {
        // Send text chunks immediately as they arrive (streaming)
        const chunkText = event.delta;
        if (chunkText) {
          console.log(`[OpenAI Realtime] Text chunk for ${key}:`, chunkText);
          // Send text chunks if client mode is 'text'
          if (clientData.mode === 'text' &&
              clientData.streamWs &&
              clientData.streamWs.readyState === WebSocket.OPEN &&
              clientData.textMetadataSent) {
            // Ensure we have a request_id
            if (!clientData.currentOpenAIRequestId) {
              clientData.currentOpenAIRequestId = `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
            }
            clientData.streamWs.send(JSON.stringify({
              type: 'text_stream',
              payload: {
                text: chunkText,
                request_id: clientData.currentOpenAIRequestId
              }
            }));
          }
        }
        break;
      }

      case "response.output_audio_transcript.done": {
        const text = event.transcript;
        console.log(`[OpenAI Realtime] Text response completed for ${key}:`, text);
        break;
      }

      case "response.output_audio.delta": {
        console.log("audio delta received", performance.now());
        const delta = event.delta;
        console.log(`[OpenAI] Delta type: ${typeof delta}, length: ${delta?.length}, preview: ${delta?.substring?.(0, 50)}`);

        // Only send audio data if client mode is 'audio'
        if (clientData.mode === 'audio' &&
            delta &&
            clientData.streamWs &&
            clientData.streamWs.readyState === WebSocket.OPEN &&
            clientData.audioMetadataSent) {
          // Ensure we have a request_id
          if (!clientData.currentOpenAIRequestId) {
            clientData.currentOpenAIRequestId = `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
          }

          const message = {
            type: 'audio_stream',
            payload: {
              audio_data: delta,
              request_id: clientData.currentOpenAIRequestId
            }
          };
          console.log(`[OpenAI] Sending message:`, JSON.stringify(message).substring(0, 200));
          clientData.streamWs.send(JSON.stringify(message));
        }
        break;
      }

      case "response.output_audio.done": {
        console.log(`[OpenAI] Turn completed, request_id: ${clientData.currentOpenAIRequestId}`);
        // Reset request_id when response is done
        clientData.currentOpenAIRequestId = null;
        break;
      }
    }
  });

  session.on("error", (error) => {
    console.error(`[OpenAI Realtime] Error for ${key}:`, error);
  });
}

/* ---------- Metadata Functions ---------- */

/**
 * Sends text stream configuration metadata to the Stream API.
 * Must be called before sending text chunks in text mode.
 *
 * @param {string} key - The client key
 * @param {string} voiceId - The voice ID for text-to-speech
 * @returns {Promise<void>}
 */
export function sendTextMetadata(key, voiceId) {
  return new Promise((resolve, reject) => {
    const clientData = clientConnections.get(key);
    if (!clientData) {
      reject(new Error('Client data not found'));
      return;
    }

    if (clientData.mode !== 'text') {
      resolve();
      return;
    }

    if (clientData.streamWs && clientData.streamWs.readyState === WebSocket.OPEN) {
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

        clientData.streamWs.send(JSON.stringify(metadataMessage), (error) => {
          if (error) {
            console.error(`[OpenAI:${clientData.participantId}] Error sending text metadata:`, error);
            reject(error);
          } else {
            console.log(`[OpenAI:${clientData.participantId}] Sent text metadata with voice_id: ${voiceId}`);
            resolve();
          }
        });
      } catch (error) {
        console.error(`[OpenAI:${clientData.participantId}] Error sending text metadata:`, error);
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
 * @param {string} key - The client key
 * @returns {Promise<void>}
 */
export function sendAudioMetadata(key) {
  return new Promise((resolve, reject) => {
    const clientData = clientConnections.get(key);
    if (!clientData) {
      reject(new Error('Client data not found'));
      return;
    }

    if (clientData.mode !== 'audio') {
      resolve();
      return;
    }

    if (clientData.streamWs && clientData.streamWs.readyState === WebSocket.OPEN) {
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

        clientData.streamWs.send(JSON.stringify(metadataMessage), (error) => {
          if (error) {
            console.error(`[OpenAI:${clientData.participantId}] Error sending audio metadata:`, error);
            reject(error);
          } else {
            console.log(`[OpenAI:${clientData.participantId}] Sent audio metadata`);
            resolve();
          }
        });
      } catch (error) {
        console.error(`[OpenAI:${clientData.participantId}] Error sending audio metadata:`, error);
        reject(error);
      }
    } else {
      reject(new Error('Output WebSocket not ready'));
    }
  });
}

/**
 * Sends audio file URL to the Stream API for file mode playback.
 *
 * @param {string} key - The client key
 */
export function sendAudioUrl(key) {
  const clientData = clientConnections.get(key);
  if (!clientData) {
    console.error(`[AudioURL] No client data found for ${key}`);
    return;
  }

  if (clientData.mode !== 'file') return;

  if (clientData.streamWs &&
      clientData.streamWs.readyState === WebSocket.OPEN &&
      !clientData.audioRequestProcessed) {
    clientData.audioRequestProcessed = true;
    try {
      const payload = {
        url: audioUrl,
      };

      // Note: audioAuthToken is not currently defined in environment
      // Add Authorization header support if needed in the future

      const message = {
        type: 'audio_file',
        payload: payload
      };

      clientData.streamWs.send(JSON.stringify(message));
      console.log(`[AudioURL:${clientData.participantId}] Sent audio URL: ${audioUrl}`);
    } catch (error) {
      console.error(`[AudioURL:${clientData.participantId}] Error sending audio URL:`, error);
    }
  } else {
    console.warn(`[AudioURL:${clientData.participantId}] Output WebSocket not ready`);
  }
}

/* ---------- Cleanup Functions ---------- */

/**
 * Cleans up client connection resources.
 * Closes OpenAI session and Stream API WebSocket, removes from connections map.
 *
 * @param {string} key - The client key to clean up
 */
export function cleanupClientConnection(key) {
  const clientData = clientConnections.get(key);
  if (clientData) {
    console.log(`[Cleanup] Cleaning up connection for ${key}`);

    if (clientData.session) {
      try {
        clientData.session.close();
      } catch (e) {
        console.error(`[Cleanup] Error closing OpenAI session for ${key}:`, e);
      }
    }

    if (clientData.streamWs) {
      clientData.streamWs.removeAllListeners();
      if (clientData.streamWs.readyState === WebSocket.OPEN) {
        clientData.streamWs.close();
      }
    }

    clientConnections.delete(key);
  }
}

/* ---------- Mode Switching ---------- */

/**
 * Dynamically switches a client's operational mode.
 * Handles cleanup of old resources and setup of new connections as needed.
 *
 * @param {string} key - The client key
 * @param {'text' | 'audio' | 'file'} newMode - The new mode to switch to
 * @returns {Promise<boolean>} True if switch was successful
 */
export async function switchClientMode(key, newMode) {
  const clientData = clientConnections.get(key);
  if (!clientData) {
    console.error(`[Mode Switch] No client data found for ${key}`);
    return false;
  }

  if (newMode !== 'audio' && newMode !== 'text' && newMode !== 'file') {
    console.error(`[Mode Switch] Invalid mode: ${newMode}`);
    return false;
  }

  const oldMode = clientData.mode;
  if (oldMode === newMode) {
    console.log(`[Mode Switch] ${key} is already in ${newMode} mode`);
    return true;
  }

  // If client is still initializing, just update the mode
  if (!clientData.session && !clientData.streamWs) {
    console.log(`[Mode Switch] ${key} is still initializing. Updating mode from ${oldMode} to ${newMode} (connections will be created by WebSocket handler)`);
    clientData.mode = newMode;
    return true;
  }

  console.log(`[Mode Switch] Switching ${key} from ${oldMode} to ${newMode}`);

  // Close OpenAI session when switching to file mode
  if ((oldMode === 'text' || oldMode === 'audio') && newMode === 'file' && clientData.session) {
    console.log(`[Mode Switch] Closing OpenAI session for ${key} (switching to file mode)`);
    try {
      clientData.session.close?.();
    } catch (e) {
      console.error(`[Mode Switch] Error closing OpenAI session:`, e);
    }
    clientData.session = null;
    clientData.agent = null;
  }

  clientData.mode = newMode;

  // Reset metadata flags for the new mode
  clientData.textMetadataSent = false;
  clientData.audioMetadataSent = false;
  clientData.audioRequestProcessed = false;

  try {
    if (newMode === 'text' || newMode === 'audio') {
      // Reuse existing OpenAI session when switching between text and audio modes
      if (!clientData.session) {
        await createRealtimeConnection(clientData.participantId, clientData.roomName);
      } else {
        console.log(`[Mode Switch] Reusing existing OpenAI session for ${key}`);
      }

      // Reuse existing streamWs or create new one if needed
      if (!clientData.streamWs || clientData.streamWs.readyState !== WebSocket.OPEN) {
        console.log(`[Mode Switch] Creating new Stream API WebSocket for ${key}`);
        await createStreamAPIConnection(clientData.roomName, clientData.participantId);
      } else {
        console.log(`[Mode Switch] Reusing existing Stream API WebSocket for ${key}`);
      }

      // Wait for streamWs to be ready (max 5 seconds)
      let waitCount = 0;
      while ((!clientData.streamWs || clientData.streamWs.readyState !== WebSocket.OPEN) && waitCount < 50) {
        await new Promise(resolve => setTimeout(resolve, 100));
        waitCount++;
      }

      if (!clientData.streamWs || clientData.streamWs.readyState !== WebSocket.OPEN) {
        throw new Error('Output WebSocket not ready after 5 seconds');
      }

      // Send appropriate metadata based on new mode
      if (newMode === 'text') {
        const roomVoiceId = roomVoiceIds.has(clientData.roomName) ? roomVoiceIds.get(clientData.roomName) : '';
        await sendTextMetadata(key, roomVoiceId);
      } else if (newMode === 'audio') {
        await sendAudioMetadata(key);
      }
    } else if (newMode === 'file') {
      sendAudioUrl(key);
    }

    console.log(`[Mode Switch] ✅ Successfully switched ${key} to ${newMode} mode`);
    return true;
  } catch (error) {
    console.error(`[Mode Switch] Error switching ${key} to ${newMode}:`, error.message);
    clientData.mode = oldMode;  // Rollback on failure
    console.log(`[Mode Switch] Rolled back to ${oldMode} mode`);
    return false;
  }
}
