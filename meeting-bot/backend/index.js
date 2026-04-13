/**
 * Main entry point for the meeting bot backend server.
 * Combines REST API endpoints and WebSocket handling on a single port.
 * Handles meeting bot audio input and forwards to OpenAI Realtime API.
 */

import WebSocket, { WebSocketServer } from 'ws';
import { URL } from 'url';
import http from 'http';

import {
  outputWsUrl,
  digiselfApiKey,
  digiselfApiBaseUrl,
  currentMode,
  setCurrentMode,
  botConnections,
  botVoiceIds,
  botModes
} from './config.js';

import {
  getBotMode,
  createStreamAPIConnection,
  createRealtimeConnection,
  sendTextMetadata,
  sendAudioMetadata,
  sendAudioUrl,
  cleanupBotConnection,
  switchBotMode
} from './clients.js';

import { upsampleAudio16to24 } from './audioProcessing.js';

/* ---------- HTTP Helper Functions ---------- */

/**
 * Parses JSON request body from incoming HTTP request.
 *
 * @param {http.IncomingMessage} req - The HTTP request object
 * @returns {Promise<object>} Parsed JSON body or empty object
 */
function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Sends a JSON response with CORS headers.
 *
 * @param {http.ServerResponse} res - The HTTP response object
 * @param {number} statusCode - HTTP status code
 * @param {object} data - Data to send as JSON
 */
function sendJsonResponse(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

/* ---------- Hybrid HTTP/WebSocket Server ---------- */

/**
 * Starts the hybrid HTTP/WebSocket server for meeting bot.
 * Handles:
 * - Admin API endpoints (status, mode management)
 * - Bot management API (create bot, set mode, set voice)
 * - WebSocket connections for meeting bot audio streaming
 *
 * @returns {http.Server} The HTTP server instance
 */
function startHybridServer() {
  const httpPort = 4000;

  const server = http.createServer(async (req, res) => {
    // Enable CORS for all requests
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle CORS preflight requests
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    /* ---------- Admin API Endpoints ---------- */
    if (req.url.startsWith('/api/admin/')) {

      // GET /api/admin/status - Get server status and active connections
      if (req.url === '/api/admin/status' && req.method === 'GET') {
        const bots = [];
        for (const [botId, data] of botConnections) {
          bots.push({
            botId,
            mode: data.mode,
            hasOpenAISession: !!data.session,
            streamWsConnected: data.streamWs?.readyState === WebSocket.OPEN
          });
        }

        sendJsonResponse(res, 200, {
          globalMode: currentMode,
          activeConnections: botConnections.size,
          bots
        });
        return;
      }

      // POST /api/admin/mode - Change global mode
      if (req.url === '/api/admin/mode' && req.method === 'POST') {
        try {
          const body = await parseRequestBody(req);
          const { mode } = body;

          if (!mode) {
            sendJsonResponse(res, 400, { error: 'mode is required' });
            return;
          }

          if (mode !== 'audio' && mode !== 'text' && mode !== 'file') {
            sendJsonResponse(res, 400, { error: 'mode must be "audio", "text", or "file"' });
            return;
          }

          setCurrentMode(mode);
          console.log(`[Admin API] Global mode changed to ${mode}`);

          sendJsonResponse(res, 200, {
            success: true,
            message: `Global mode set to ${mode}`,
            note: 'This affects new connections only'
          });
        } catch (error) {
          sendJsonResponse(res, 400, { error: error.message });
        }
        return;
      }

      // Unknown admin endpoint
      sendJsonResponse(res, 404, { error: 'Not found' });
      return;
    }

    /* ---------- Bot API Endpoints ---------- */

    // POST /api/bots/:botId/mode - Set mode for specific bot
    const botModeMatch = req.url.match(/^\/api\/bots\/([^\/]+)\/mode$/);
    if (botModeMatch && req.method === 'POST') {
      const botId = decodeURIComponent(botModeMatch[1]);

      try {
        const body = await parseRequestBody(req);
        const { mode } = body;

        if (!mode) {
          sendJsonResponse(res, 400, { error: 'mode is required' });
          return;
        }

        if (mode !== 'audio' && mode !== 'text' && mode !== 'file') {
          sendJsonResponse(res, 400, { error: 'mode must be "audio", "text", or "file"' });
          return;
        }

        // Store mode in botModes Map
        botModes.set(botId, mode);
        console.log(`[API] Mode "${mode}" stored for bot "${botId}"`);

        // If bot is already connected, switch mode dynamically
        const botData = botConnections.get(botId);
        if (botData) {
          const success = await switchBotMode(botId, mode);
          if (success) {
            console.log(`[API] Bot "${botId}" mode switched to ${mode}`);
          }
        }

        sendJsonResponse(res, 200, {
          success: true,
          message: botData
            ? `Bot "${botId}" mode set to ${mode} (active connection updated)`
            : `Bot "${botId}" mode set to ${mode} (will apply on next connection)`,
          botId,
          mode
        });
      } catch (error) {
        sendJsonResponse(res, 400, { error: error.message });
      }
      return;
    }

    // POST /api/bots/:botId/voice - Set voice_id for bot
    const botVoiceMatch = req.url.match(/^\/api\/bots\/([^\/]+)\/voice$/);
    if (botVoiceMatch && req.method === 'POST') {
      const botId = decodeURIComponent(botVoiceMatch[1]);

      try {
        const body = await parseRequestBody(req);
        const { voice_id } = body;

        // Store voice_id for the bot (can be empty string)
        botVoiceIds.set(botId, voice_id || '');
        console.log(`[Voice API] Voice ID set for bot "${botId}": "${voice_id || '(empty)'}"`);

        sendJsonResponse(res, 200, {
          success: true,
          message: `Voice ID set for bot "${botId}"`,
          botId,
          voice_id: voice_id || ''
        });
      } catch (error) {
        sendJsonResponse(res, 400, { error: error.message });
      }
      return;
    }

    // POST /api/bots - Create a new bot (returns job_id immediately)
    if (req.url === '/api/bots' && req.method === 'POST') {
      try {
        const body = await parseRequestBody(req);
        const { bot_name, meeting_url, output_url, avatar_id } = body;

        if (!digiselfApiBaseUrl) {
          sendJsonResponse(res, 500, { error: 'DIGISELF_API_BASE_URL is not configured' });
          return;
        }

        // Create bot (returns 202 + job_id)
        const createResponse = await fetch(`${digiselfApiBaseUrl}/api/bots`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': digiselfApiKey || '',
          },
          body: JSON.stringify({
            bot_name,
            meeting_url,
            output_url,
            avatar_id,
          }),
        });

        if (!createResponse.ok) {
          const errorText = await createResponse.text();
          sendJsonResponse(res, createResponse.status, { error: `Failed to create bot: ${errorText}` });
          return;
        }

        const jobData = await createResponse.json();
        console.log(`[Bot API] Bot creation job started: ${jobData.job_id}`);

        // Return job_id immediately
        sendJsonResponse(res, 202, jobData);
      } catch (error) {
        console.error('[Bot API] Error creating bot:', error);
        sendJsonResponse(res, 500, { error: error.message });
      }
      return;
    }

    // GET /api/bots/wait/:jobId - Wait for bot creation with progress
    const botWaitMatch = req.url.match(/^\/api\/bots\/wait\/([^\/\?]+)(\?.*)?$/);
    if (botWaitMatch && req.method === 'GET') {
      const jobId = decodeURIComponent(botWaitMatch[1]);
      const urlParams = new URLSearchParams(botWaitMatch[2] || '');
      const timeout = urlParams.get('timeout') || '5';

      try {
        const waitResponse = await fetch(
          `${digiselfApiBaseUrl}/api/bots/wait/${jobId}?timeout=${timeout}`,
          {
            method: 'GET',
            headers: {
              'x-api-key': digiselfApiKey || '',
            },
          }
        );

        if (!waitResponse.ok) {
          const errorText = await waitResponse.text();
          sendJsonResponse(res, waitResponse.status, { error: `Failed to wait for bot: ${errorText}` });
          return;
        }

        const botResult = await waitResponse.json();
        console.log(`[Bot API] Bot wait result (job: ${jobId}):`, botResult);

        // Return result with progress info
        sendJsonResponse(res, 200, botResult);
      } catch (error) {
        console.error('[Bot API] Error waiting for bot:', error);
        sendJsonResponse(res, 500, { error: error.message });
      }
      return;
    }

    // Unknown endpoint
    sendJsonResponse(res, 404, { error: 'Not found' });
  });

  /* ---------- WebSocket Server Setup ---------- */

  const { pathname } = new URL(outputWsUrl);
  const wss = new WebSocketServer({
    server: server,
    path: pathname
  });

  // WebSocket connection handler for meeting bot input
  wss.on('connection', (ws) => {
    console.log('[input] Meeting bot client connected');
    let botId = null;

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString('utf-8'));

        // Extract bot_id from meeting bot message format
        if (message.data?.bot?.id) {
          botId = message.data.bot.id;

          // Initialize new bot connection
          if (!botConnections.has(botId)) {
            console.log(`[input] New bot connection: ${botId}`);

            const mode = getBotMode(botId);
            console.log(`[input] Initializing bot ${botId} with mode: ${mode}`);

            botConnections.set(botId, {
              session: null,
              agent: null,
              streamWs: null,
              currentRequestId: null,
              audioRequestProcessed: false,
              textMetadataSent: false,
              audioMetadataSent: false,
              mode: mode
            });

            try {
              // Create OpenAI session for text and audio modes
              if (mode === 'text' || mode === 'audio') {
                await createRealtimeConnection(botId);
              }

              await createStreamAPIConnection(botId);

              // Send appropriate metadata based on mode
              if (mode === 'text') {
                const voiceId = botVoiceIds.has(botId) ? botVoiceIds.get(botId) : '';
                await sendTextMetadata(botId, voiceId);
              } else if (mode === 'audio') {
                await sendAudioMetadata(botId);
              } else if (mode === 'file') {
                sendAudioUrl(botId);
              }

              console.log(`[input] Connection established for bot: ${botId} (mode: ${mode})`);
            } catch (error) {
              console.error(`[input] Error initializing connection for bot ${botId}:`, error);
            }
          }
        }

        // Forward audio to OpenAI (meeting bot sends audio_mixed_raw.data events)
        if (message.event === 'audio_mixed_raw.data' && botId) {
          const botData = botConnections.get(botId);
          if (botData?.session && (botData.mode === 'text' || botData.mode === 'audio')) {
            // Meeting bot sends 16kHz audio, upsample to 24kHz for OpenAI
            const audioData = Buffer.from(message.data.data.buffer, 'base64');
            const upsampled = upsampleAudio16to24(audioData);
            const arrayBuffer = new ArrayBuffer(upsampled.length);
            new Uint8Array(arrayBuffer).set(upsampled);
            botData.session.sendAudio(arrayBuffer);
          }
        }
      } catch (err) {
        console.error('[input] Error parsing message:', err);
      }
    });

    ws.on('close', () => {
      if (botId) {
        console.log(`[input] Bot disconnected: ${botId}`);
        cleanupBotConnection(botId);
      }
    });

    ws.on('error', (error) => {
      console.error(`[input] WebSocket error:`, error);
      if (botId) {
        cleanupBotConnection(botId);
      }
    });
  });

  // Start the server
  server.listen(httpPort, () => {
    console.log(`\n Meeting Bot Backend Server listening on port ${httpPort}`);
    console.log(`   - HTTP endpoints: http://localhost:${httpPort}`);
    console.log(`   - WebSocket path: ws://localhost:${httpPort}${pathname}`);
    console.log('\n=== API Endpoints ===');
    console.log(`GET  http://localhost:${httpPort}/api/admin/status`);
    console.log(`POST http://localhost:${httpPort}/api/admin/mode`);
    console.log(`POST http://localhost:${httpPort}/api/bots`);
    console.log(`POST http://localhost:${httpPort}/api/bots/:botId/mode`);
    console.log(`POST http://localhost:${httpPort}/api/bots/:botId/voice`);
    console.log('===========================\n');
  });

  return server;
}

/* ---------- Boot ---------- */
(async () => {
  console.log('Starting meeting bot backend server...');
  startHybridServer();
  console.log('Server started successfully.');
})();
