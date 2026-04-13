/**
 * Main entry point for the hybrid HTTP/WebSocket server.
 * Combines REST API endpoints and WebSocket handling on a single port.
 */

import WebSocket, { WebSocketServer } from 'ws';
import { URL } from 'url';
import fs from 'fs';
import path from 'path';
import http from 'http';

import {
  outputWsUrl,
  digiselfApiKey,
  digiselfApiBaseUrl,
  currentMode,
  setCurrentMode,
  clientConnections,
  roomVoiceIds,
  roomModes
} from './config.js';

import {
  clientKey,
  getRoomMode,
  createStreamAPIConnection,
  createRealtimeConnection,
  sendTextMetadata,
  sendAudioMetadata,
  sendAudioUrl,
  cleanupClientConnection,
  switchClientMode
} from './clients.js';

import { downsampleAudio48to24 } from './audioProcessing.js';

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
 * Starts the hybrid HTTP/WebSocket server.
 * Handles:
 * - Admin API endpoints (status, mode management)
 * - Room management API (create room, add participant, set voice)
 * - Audio file serving
 * - WebSocket connections for real-time audio streaming
 *
 * @returns {http.Server} The HTTP server instance
 */
function startHybridServer() {
  const httpPort = 3000;

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
        const clients = [];
        for (const [key, data] of clientConnections) {
          clients.push({
            roomName: data.roomName,
            participantId: data.participantId,
            mode: data.mode,
            hasOpenAISession: !!data.session,
            streamWsConnected: data.streamWs?.readyState === WebSocket.OPEN
          });
        }

        sendJsonResponse(res, 200, {
          globalMode: currentMode,
          activeConnections: clientConnections.size,
          clients
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

      // POST /api/admin/rooms/:roomName/mode - Change specific room mode
      const roomModeMatch = req.url.match(/^\/api\/admin\/rooms\/([^\/]+)\/mode$/);
      if (roomModeMatch && req.method === 'POST') {
        const roomName = decodeURIComponent(roomModeMatch[1]);

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

          // Store mode in roomModes Map
          roomModes.set(roomName, mode);
          console.log(`[Admin API] Mode "${mode}" stored for room "${roomName}"`);

          // If client is already connected, switch mode dynamically
          const key = clientKey(roomName, null);
          const clientData = clientConnections.get(key);

          if (clientData) {
            const success = await switchClientMode(key, mode);
            if (success) {
              console.log(`[Admin API] Room "${roomName}" mode switched to ${mode}`);
            } else {
              console.warn(`[Admin API] Failed to switch active connection to ${mode}, but mode is stored for next connection`);
            }
          }

          sendJsonResponse(res, 200, {
            success: true,
            message: clientData
              ? `Room "${roomName}" mode set to ${mode} (active connection updated)`
              : `Room "${roomName}" mode set to ${mode} (will apply on next connection)`,
            roomName,
            mode
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

    /* ---------- Room Management API (Proxy to Digiself API) ---------- */

    // POST /api/rooms - Create a new room (returns job_id immediately)
    if (req.url === '/api/rooms' && req.method === 'POST') {
      try {
        const body = await parseRequestBody(req);
        const { output_url, avatar_id, avatar_name, interrupt_speech } = body;

        if (!digiselfApiBaseUrl) {
          sendJsonResponse(res, 500, { error: 'DIGISELF_API_BASE_URL is not configured' });
          return;
        }

        console.log(`[Room API] Creating room via ${digiselfApiBaseUrl}/api/rooms`);

        // Create room (returns 202 + job_id)
        const createResponse = await fetch(`${digiselfApiBaseUrl}/api/rooms`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': digiselfApiKey || '',
          },
          body: JSON.stringify({
            output_url,
            avatar_id,
            avatar_name,
            interrupt_speech
          }),
        });

        const responseText = await createResponse.text();
        console.log(`[Room API] Response status: ${createResponse.status}, body: ${responseText.substring(0, 200)}`);

        if (!createResponse.ok) {
          sendJsonResponse(res, createResponse.status, { error: `Failed to create room: ${responseText}` });
          return;
        }

        // Parse JSON after confirming it's not an error
        let jobData;
        try {
          jobData = JSON.parse(responseText);
        } catch (parseError) {
          console.error('[Room API] Failed to parse response as JSON:', responseText.substring(0, 500));
          sendJsonResponse(res, 500, { error: `Invalid JSON response from API: ${responseText.substring(0, 200)}` });
          return;
        }

        console.log(`[Room API] Room creation job started: ${jobData.job_id}`);

        // Return job_id immediately
        sendJsonResponse(res, 202, jobData);
      } catch (error) {
        console.error('[Room API] Error creating room:', error);
        sendJsonResponse(res, 500, { error: error.message });
      }
      return;
    }

    // GET /api/rooms/wait/:jobId - Wait for room creation with progress
    const roomWaitMatch = req.url.match(/^\/api\/rooms\/wait\/([^\/\?]+)(\?.*)?$/);
    if (roomWaitMatch && req.method === 'GET') {
      const jobId = decodeURIComponent(roomWaitMatch[1]);
      const urlParams = new URLSearchParams(roomWaitMatch[2] || '');
      const timeout = urlParams.get('timeout') || '5';

      try {
        const waitResponse = await fetch(
          `${digiselfApiBaseUrl}/api/rooms/wait/${jobId}?timeout=${timeout}`,
          {
            method: 'GET',
            headers: {
              'x-api-key': digiselfApiKey || '',
            },
          }
        );

        if (!waitResponse.ok) {
          const errorText = await waitResponse.text();
          sendJsonResponse(res, waitResponse.status, { error: `Failed to wait for room: ${errorText}` });
          return;
        }

        const roomResult = await waitResponse.json();
        console.log(`[Room API] Room wait result (job: ${jobId}):`, roomResult);

        // Return result with progress info
        sendJsonResponse(res, 200, roomResult);
      } catch (error) {
        console.error('[Room API] Error waiting for room:', error);
        sendJsonResponse(res, 500, { error: error.message });
      }
      return;
    }

    // POST /api/rooms/:roomName/participants - Add participant and get token
    const participantMatch = req.url.match(/^\/api\/rooms\/([^\/]+)\/participants$/);
    if (participantMatch && req.method === 'POST') {
      const roomName = decodeURIComponent(participantMatch[1]);

      try {
        const body = await parseRequestBody(req);
        const { user_name } = body;

        if (!digiselfApiBaseUrl) {
          sendJsonResponse(res, 500, { error: 'DIGISELF_API_BASE_URL is not configured' });
          return;
        }

        const response = await fetch(`${digiselfApiBaseUrl}/api/rooms/${encodeURIComponent(roomName)}/participants`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': digiselfApiKey || '',
          },
          body: JSON.stringify({
            room_name: roomName,
            user_name
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          sendJsonResponse(res, response.status, { error: `Failed to add participant: ${errorText}` });
          return;
        }

        const tokenData = await response.json();
        console.log(`[Participant API] Token generated for ${user_name} in room ${roomName}`);
        sendJsonResponse(res, 200, tokenData);
      } catch (error) {
        console.error('[Participant API] Error adding participant:', error);
        sendJsonResponse(res, 500, { error: error.message });
      }
      return;
    }

    // POST /api/rooms/:roomName/voice - Set voice_id for room
    const voiceMatch = req.url.match(/^\/api\/rooms\/([^\/]+)\/voice$/);
    if (voiceMatch && req.method === 'POST') {
      const roomName = decodeURIComponent(voiceMatch[1]);

      try {
        const body = await parseRequestBody(req);
        const { voice_id } = body;

        // Store voice_id for the room (can be empty string)
        roomVoiceIds.set(roomName, voice_id || '');
        console.log(`[Voice API] Voice ID set for room "${roomName}": "${voice_id || '(empty)'}"`);

        sendJsonResponse(res, 200, {
          success: true,
          message: `Voice ID set for room "${roomName}"`,
          roomName,
          voice_id: voice_id || ''
        });
      } catch (error) {
        sendJsonResponse(res, 400, { error: error.message });
      }
      return;
    }

    /* ---------- Audio File Serving ---------- */
    if (req.method === 'GET') {
      const fileName = path.basename(req.url);
      const fileExt = path.extname(fileName).toLowerCase();

      // Skip if no valid filename
      if (!fileName || fileName === '/' || fileName === '.' || req.url === '/') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }

      // Allowed audio file extensions for security
      const allowedExtensions = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'];

      // Validate file extension
      if (!allowedExtensions.includes(fileExt)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Invalid file type',
          message: `File extension '${fileExt}' is not allowed. Allowed types: ${allowedExtensions.join(', ')}`,
          allowed_extensions: allowedExtensions
        }));
        console.log(`[HTTP] 400 - Invalid file type: ${fileName} (extension: ${fileExt})`);
        return;
      }

      const filePath = path.join(process.cwd(), fileName);

      // Check if file exists
      if (!fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'File not found',
          message: `The requested file '${fileName}' does not exist`,
          path: fileName
        }));
        console.log(`[HTTP] 404 - File not found: ${fileName}`);
        return;
      }

      const stats = fs.statSync(filePath);

      // Validate file is not empty
      if (stats.size === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Invalid file',
          message: `The file '${fileName}' is empty or corrupted`,
          size: 0
        }));
        console.log(`[HTTP] 400 - Empty file: ${fileName}`);
        return;
      }

      // Content-Type mapping for audio files
      const contentTypes = {
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.ogg': 'audio/ogg',
        '.m4a': 'audio/mp4',
        '.aac': 'audio/aac',
        '.flac': 'audio/flac'
      };

      res.setHeader('Content-Type', contentTypes[fileExt] || 'application/octet-stream');
      res.setHeader('Content-Length', stats.size);
      res.setHeader('Accept-Ranges', 'bytes');
      res.writeHead(200);

      // Stream file to response
      const stream = fs.createReadStream(filePath);
      stream.pipe(res);

      console.log(`[HTTP] 200 - Served ${fileName} (${stats.size} bytes) to ${req.connection.remoteAddress}`);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  });

  /* ---------- WebSocket Server Setup ---------- */

  if (!outputWsUrl) {
    console.error('OUTPUT_WEBSOCKET_URL is not defined');
    process.exit(1);
  }

  const { pathname } = new URL(outputWsUrl);
  const wss = new WebSocketServer({
    server: server,
    path: pathname
  });

  // WebSocket connection handler
  wss.on('connection', (ws) => {
    console.log('WebSocket client connected');
    let participantId = null;
    let roomName = null;

    ws.on('message', async (message) => {
      const jsonString = message.toString('utf-8');
      const payload = JSON.parse(jsonString);

      participantId = payload.participant_id || participantId;
      roomName = payload.room_name || roomName;

      if (payload && roomName) {
        const key = clientKey(roomName, participantId);

        // Initialize new client connection
        if (!clientConnections.has(key)) {
          const clientData = {
            session: null,
            agent: null,
            roomName,
            participantId,
            streamWs: null,
            currentOpenAIRequestId: null,
            audioRequestProcessed: false,
            textMetadataSent: false,
            audioMetadataSent: false,
            mode: getRoomMode(roomName)
          };
          clientConnections.set(key, clientData);

          try {
            // Brief delay to allow mode configuration via HTTP request
            console.log(`[WebSocket] Waiting for mode configuration for ${key}...`);
            await new Promise(resolve => setTimeout(resolve, 300));

            const updatedClientData = clientConnections.get(key);
            if (!updatedClientData) {
              console.error(`[WebSocket] Client data disappeared during initialization for ${key}`);
              return;
            }

            const roomMode = updatedClientData.mode;
            console.log(`[WebSocket] Initializing ${key} with mode: ${roomMode}`);

            // Create OpenAI session for text and audio modes
            if (roomMode === 'text' || roomMode === 'audio') {
              await createRealtimeConnection(participantId, roomName);
            }

            await createStreamAPIConnection(roomName, participantId);

            // Send appropriate metadata based on mode
            if (roomMode === 'text') {
              const roomVoiceId = roomVoiceIds.has(roomName) ? roomVoiceIds.get(roomName) : '';
              await sendTextMetadata(key, roomVoiceId);
            } else if (roomMode === 'audio') {
              await sendAudioMetadata(key);
            } else if (roomMode === 'file') {
              sendAudioUrl(key);
            }

            console.log(`Output connection established for participant: ${participantId} (mode: ${roomMode})`);
          } catch (error) {
            console.error(`Error initializing connection for ${participantId}:`, error);
          }
        }

        const clientData = clientConnections.get(key);
        if (!clientData) {
          console.log('[WebSocket] No clientData found for key:', key);
          console.log('[WebSocket] Available keys:', Array.from(clientConnections.keys()));
          return;
        }

        // Handle audio messages from agent
        if (payload.type === 'mixed' || payload.type === 'individual') {
          const audioChunk = Buffer.from(payload.data, 'base64');

          // Forward audio to OpenAI for text and audio modes
          if ((clientData.mode === 'text' || clientData.mode === 'audio') && clientData.session) {
            try {
              // Downsample from 48kHz to 24kHz for OpenAI
              const downsampledAudio = downsampleAudio48to24(audioChunk);

              const arrayBuffer = new ArrayBuffer(downsampledAudio.length);
              const uint8Array = new Uint8Array(arrayBuffer);
              uint8Array.set(downsampledAudio);

              clientData.session.sendAudio(arrayBuffer);
            } catch (error) {
              console.error(`[OpenAI] ❌ Error sending audio to OpenAI:`, error);
            }
          }
          // File mode: no audio processing needed
        }
      }
    });

    ws.on('close', () => {
      console.log(`WebSocket client disconnected: ${participantId}`);
      if (participantId && roomName) {
        const key = clientKey(roomName, participantId);
        cleanupClientConnection(key);
      }
    });

    ws.on('error', (error) => {
      console.error(`WebSocket error for ${participantId}:`, error);
      if (participantId && roomName) {
        const key = clientKey(roomName, participantId);
        cleanupClientConnection(key);
      }
    });
  });

  // Start the server
  server.listen(httpPort, () => {
    console.log(`\n🚀 Hybrid HTTP/WebSocket server listening on port ${httpPort}`);
    console.log(`   - HTTP endpoints: http://localhost:${httpPort}`);
    console.log(`   - WebSocket path: ws://localhost:${httpPort}${pathname}`);
    console.log(`   - Audio file available at: http://localhost:${httpPort}/testcase_1.wav`);
    console.log('\n=== API Endpoints ===');
    console.log(`GET  http://localhost:${httpPort}/api/admin/status`);
    console.log(`POST http://localhost:${httpPort}/api/admin/mode`);
    console.log(`POST http://localhost:${httpPort}/api/admin/rooms/:roomName/mode`);
    console.log(`POST http://localhost:${httpPort}/api/rooms/:roomName/voice`);
    console.log('===========================\n');
  });

  return server;
}

/* ---------- Boot ---------- */
(async () => {
  console.log('Starting hybrid HTTP/WebSocket server...');
  startHybridServer();
  console.log('Server started successfully.');
})();
