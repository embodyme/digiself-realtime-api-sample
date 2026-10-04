import WebSocket, { WebSocketServer } from 'ws';
import { config } from 'dotenv';
import { URL } from 'url';
import { randomUUID } from 'crypto';

config();

const streamApiUrlBase = 'wss://stream-api.digiself.tech';
const openaiRealtimeUrlBase = 'wss://api.openai.com/v1/realtime';
const openaiRealtimeModel = 'gpt-realtime-2.1';
const digiselfApiKey = process.env.DIGISELF_API_KEY;
const openaiApiKey = process.env.OPENAI_API_KEY;
const outputWsUrl = process.env.OUTPUT_WEBSOCKET_URL;

if (!outputWsUrl) {
  console.error('OUTPUT_WEBSOCKET_URL is required');
  process.exit(1);
}

if (!openaiApiKey) {
  console.error('OPENAI_API_KEY is required');
  process.exit(1);
}

// Single bot connection state
let botId = null;
let session = null;
let sessionReady = false;
let streamWs = null;
let textMetadataSent = false;
let currentResponseId = null;
let currentRequestId = null;

/* ---------- Stream API WebSocket Connection ---------- */
function createStreamAPIConnection(botId) {
  return new Promise((resolve, reject) => {
    const urlWithParams = `${streamApiUrlBase}/api/bots/${encodeURIComponent(botId)}/speak`;
    const headers = {};
    if (digiselfApiKey) headers['x-api-key'] = digiselfApiKey;

    streamWs = new WebSocket(urlWithParams, { headers });
    streamWs.on('open', () => { resolve(streamWs); });
    streamWs.on('error', (e) => { console.log(`[output] WebSocket error: ${e.message}`); });
    streamWs.on('close', () => { console.log(`[output] Stream API disconnected`); });
    streamWs.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        console.log(`[output] received message:`, message);

        if (message.type === 'ack' && message.payload?.config_type === 'text_stream') {
          textMetadataSent = true;
          console.log(`[output] text metadata ack received`);
        }
      } catch (error) {
        console.log(`[output] received raw message:`, data.toString());
      }
    });
  });
}

/* ---------- OpenAI Realtime Connection ---------- */
function createRealtimeConnection() {
  return new Promise((resolve, reject) => {
    session = new WebSocket(`${openaiRealtimeUrlBase}?model=${openaiRealtimeModel}`, {
      headers: { Authorization: `Bearer ${openaiApiKey}` }
    });

    session.on('open', () => {
      // Request text output only: DigiSelf speaks the text with its own TTS
      session.send(JSON.stringify({
        type: 'session.update',
        session: {
          type: 'realtime',
          model: openaiRealtimeModel,
          instructions: 'You are a helpful AI assistant. Keep your responses concise and natural. You are having a real-time conversation with the user.',
          output_modalities: ['text'],
          // Minimal reasoning keeps the first reply fast. max_output_tokens includes reasoning tokens.
          reasoning: { effort: 'minimal' },
          max_output_tokens: 1024,
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 24000 },
              turn_detection: {
                type: 'server_vad',
                threshold: 0.5,
                prefix_padding_ms: 150,
                silence_duration_ms: 100,
                create_response: true,
                interrupt_response: true
              }
            }
          }
        }
      }));
    });

    session.on('message', (data) => {
      const event = JSON.parse(data.toString());

      if (!sessionReady) {
        if (event.type === 'session.updated') {
          sessionReady = true;
          console.log(`[OpenAI Realtime] Connection established (${openaiRealtimeModel})`);
          resolve();
        } else if (event.type === 'error') {
          reject(new Error(event.error?.message || 'OpenAI session error'));
        }
        return;
      }

      handleRealtimeEvent(event);
    });

    session.on('error', (e) => {
      console.error(`[OpenAI Realtime] WebSocket error: ${e.message}`);
      reject(e);
    });
    session.on('close', () => { console.log(`[OpenAI Realtime] Disconnected`); });
  });
}

/* ---------- Realtime Event Handlers ---------- */
function handleRealtimeEvent(event) {
  // Ignore the rest of responses that already finished or were interrupted
  const responseId = event.response_id || event.response?.id;
  if (event.type.startsWith('response.') && event.type !== 'response.created' && responseId !== currentResponseId) {
    return;
  }

  switch (event.type) {
    case 'input_audio_buffer.speech_started':
      // Server VAD cancels the current response when someone starts speaking,
      // so stop forwarding what is left of it.
      currentResponseId = null;
      currentRequestId = null;
      break;

    case 'response.created':
      currentResponseId = event.response.id;
      // The Stream API rejects text_stream messages without a request_id,
      // so give each response its own id.
      currentRequestId = randomUUID();
      break;

    case 'response.output_text.delta': {
      const chunkText = event.delta;
      if (chunkText && streamWs?.readyState === WebSocket.OPEN && textMetadataSent) {
        console.log(`[OpenAI] Text chunk:`, chunkText);
        streamWs.send(JSON.stringify({
          type: 'text_stream',
          payload: {
            text: chunkText,
            request_id: currentRequestId
          }
        }));
      }
      break;
    }

    case 'response.done':
      console.log(`[OpenAI] Turn completed`);
      currentResponseId = null;
      currentRequestId = null;
      break;

    case 'error':
      // Server VAD requests a response whenever someone stops speaking. While an answer
      // is still being generated, OpenAI rejects that request and keeps the answer.
      if (event.error?.code !== 'conversation_already_has_active_response') {
        console.error(`[OpenAI Realtime] Error:`, event.error);
      }
      break;
  }
}

/* ---------- Send Text Metadata ---------- */
function sendTextMetadata() {
  return new Promise((resolve, reject) => {
    if (streamWs?.readyState === WebSocket.OPEN) {
      const metadataMessage = {
        type: 'config',
        payload: {
          config_type: 'text_stream',
          config: { voice_id: '' }
        }
      };

      streamWs.send(JSON.stringify(metadataMessage), (error) => {
        if (error) {
          console.error(`[output] Error sending text metadata:`, error);
          reject(error);
        } else {
          console.log(`[output] Sent text metadata`);
          resolve();
        }
      });
    } else {
      reject(new Error('Output WebSocket not ready'));
    }
  });
}

/* ---------- Upsample 16kHz -> 24kHz ---------- */
function upsampleAudio16to24(audioBuffer) {
  const bytesPerSample = 2;
  const inputSampleRate = 16000;
  const outputSampleRate = 24000;
  const upsampleFactor = outputSampleRate / inputSampleRate;

  const inputSamples = audioBuffer.length / bytesPerSample;
  const outputSamples = Math.floor(inputSamples * upsampleFactor);
  const outputBuffer = Buffer.alloc(outputSamples * bytesPerSample);

  const inputInt16 = new Int16Array(audioBuffer.buffer, audioBuffer.byteOffset, inputSamples);
  const outputInt16 = new Int16Array(outputBuffer.buffer, outputBuffer.byteOffset, outputSamples);

  for (let i = 0; i < outputSamples; i++) {
    const inputIndex = i / upsampleFactor;
    const lowerIndex = Math.floor(inputIndex);
    const upperIndex = Math.min(lowerIndex + 1, inputSamples - 1);
    const fraction = inputIndex - lowerIndex;

    if (lowerIndex < inputSamples) {
      const lowerSample = inputInt16[lowerIndex];
      const upperSample = inputInt16[upperIndex];
      outputInt16[i] = Math.round(lowerSample + (upperSample - lowerSample) * fraction);
    }
  }

  return outputBuffer;
}

/* ---------- Cleanup ---------- */
function cleanup() {
  console.log(`[Cleanup] Cleaning up connection`);

  if (session) {
    session.removeAllListeners();
    // Closing a socket that is still connecting emits an error; keep a listener for it
    session.on('error', () => {});
    session.close();
    session = null;
  }
  sessionReady = false;

  if (streamWs) {
    streamWs.removeAllListeners();
    if (streamWs.readyState === WebSocket.OPEN) streamWs.close();
    streamWs = null;
  }

  botId = null;
  textMetadataSent = false;
  currentResponseId = null;
  currentRequestId = null;
}

/* ---------- WebSocket Server ---------- */
function startServer() {
  const { port, pathname } = new URL(outputWsUrl);
  const serverPort = port || 4000;

  const wss = new WebSocketServer({ port: serverPort, path: pathname });

  wss.on('connection', (ws) => {
    console.log('[input] Meeting bot client connected');

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString('utf-8'));

        // Extract bot_id from meeting bot message
        if (message.data?.bot?.id && !botId) {
          botId = message.data.bot.id;

          try {
            await createRealtimeConnection();
            await createStreamAPIConnection(botId);
            await sendTextMetadata();
            console.log(`[input] Connection established for bot: ${botId}`);
          } catch (error) {
            console.error(`[input] Error initializing connection:`, error);
          }
        }

        // Forward audio to OpenAI
        if (message.event === 'audio_mixed_raw.data' && sessionReady && session?.readyState === WebSocket.OPEN) {
          const audioData = Buffer.from(message.data.data.buffer, 'base64');
          const upsampled = upsampleAudio16to24(audioData);
          session.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: upsampled.toString('base64')
          }));
        }
      } catch (err) {
        console.error('[input] Error parsing message:', err);
      }
    });

    ws.on('close', () => {
      console.log(`[input] Bot disconnected: ${botId}`);
      cleanup();
    });

    ws.on('error', (error) => {
      console.error(`[input] WebSocket error:`, error);
      cleanup();
    });
  });

  console.log(`\nQuick Start Server listening on port ${serverPort}`);
  console.log(`WebSocket path: ws://localhost:${serverPort}${pathname}\n`);

  return wss;
}

/* ---------- Boot ---------- */
console.log('Starting Quick Start server...');
startServer();
console.log('Server started successfully.');
