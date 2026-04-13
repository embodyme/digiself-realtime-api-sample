import WebSocket, { WebSocketServer } from 'ws';
import { config } from 'dotenv';
import { RealtimeAgent, RealtimeSession } from '@openai/agents/realtime';
import { URL } from 'url';

config();

const streamApiUrlBase = 'wss://stream-api.digiself.tech';
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
let streamWs = null;
let textMetadataSent = false;
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

/* ---------- OpenAI Realtime Agent ---------- */
async function createRealtimeConnection() {
  const agent = new RealtimeAgent({
    apiKey: openaiApiKey,
    name: 'assistant',
    instructions: `You are a helpful AI assistant. Keep your responses concise and natural. You are having a real-time conversation with the user.`,
  });

  session = new RealtimeSession(agent, {
    model: 'gpt-realtime',
    transport: 'websocket',
    config: {
      audio: {
        input: { format: { type: 'audio/pcm', rate: 24000 } },
        output: { format: { type: 'audio/pcm', rate: 24000 } },
      },
      turn_detection: {
        type: 'server_vad',
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 500
      }
    },
  });

  await session.connect({ apiKey: openaiApiKey });
  setupRealtimeEventHandlers();
  console.log(`[OpenAI Realtime] Connection established`);
}

/* ---------- Realtime Event Handlers ---------- */
function setupRealtimeEventHandlers() {
  session.transport.on('*', (event) => {
    switch (event.type) {
      case 'response.output_audio_transcript.delta': {
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

      case 'response.output_audio.done':
        console.log(`[OpenAI] Turn completed`);
        currentRequestId = null;
        break;
    }
  });

  session.on('error', (error) => {
    console.error(`[OpenAI Realtime] Error:`, error);
  });
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
    try { session.close(); } catch (e) { console.error(`[Cleanup] Error closing session:`, e); }
    session = null;
  }

  if (streamWs) {
    streamWs.removeAllListeners();
    if (streamWs.readyState === WebSocket.OPEN) streamWs.close();
    streamWs = null;
  }

  botId = null;
  textMetadataSent = false;
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
        if (message.event === 'audio_mixed_raw.data' && session) {
          const audioData = Buffer.from(message.data.data.buffer, 'base64');
          const upsampled = upsampleAudio16to24(audioData);
          const arrayBuffer = new ArrayBuffer(upsampled.length);
          new Uint8Array(arrayBuffer).set(upsampled);
          session.sendAudio(arrayBuffer);
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
