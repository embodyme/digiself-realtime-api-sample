import http from 'http';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '.env') });

const PORT = process.env.PORT || 3000;
const openaiApiKey = process.env.OPENAI_API_KEY;
const digiselfApiKey = process.env.DIGISELF_API_KEY;
const digiselfApiBaseUrl = process.env.DIGISELF_API_BASE_URL;

console.log('[Server] Starting...');

// Helper function to parse request body
async function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Helper function to send JSON response
function sendJsonResponse(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  console.log(`[${req.method}] ${req.url}`);

  // POST /api/openai/session - Create OpenAI ephemeral token
  if (req.url === '/api/openai/session' && req.method === 'POST') {
    if (!openaiApiKey) {
      sendJsonResponse(res, 500, { error: 'OPENAI_API_KEY is not configured' });
      return;
    }

    try {
      const openaiResponse = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openaiApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          session: {
            type: 'realtime',
            model: 'gpt-realtime',
            instructions: 'Your are helpful assistant.',
          },
        }),
      });

      if (!openaiResponse.ok) {
        const errorText = await openaiResponse.text();
        console.error(`[OpenAI Session] Failed: ${openaiResponse.status} ${errorText}`);
        sendJsonResponse(res, openaiResponse.status, { error: 'Failed to create OpenAI session', details: errorText });
        return;
      }

      const sessionData = await openaiResponse.json();
      console.log('[OpenAI Session] Ephemeral token created successfully');
      sendJsonResponse(res, 200, sessionData);
    } catch (error) {
      console.error('[OpenAI Session] Error:', error.message);
      sendJsonResponse(res, 500, { error: 'Internal server error', details: error.message });
    }
    return;
  }

  // POST /api/rooms - Create a new room
  if (req.url === '/api/rooms' && req.method === 'POST') {
    try {
      const body = await parseRequestBody(req);
      const { avatar_id, avatar_name, interrupt_speech } = body;

      if (!digiselfApiBaseUrl) {
        sendJsonResponse(res, 500, { error: 'DIGISELF_API_BASE_URL is not configured' });
        return;
      }

      console.log(`[Room API] Creating room via ${digiselfApiBaseUrl}/api/rooms`);

      // Create room (returns 202 + job_id)
      // Note: For browserDirect, we don't send output_url
      const createResponse = await fetch(`${digiselfApiBaseUrl}/api/rooms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': digiselfApiKey || '',
        },
        body: JSON.stringify({
          avatar_id,
          avatar_name,
          interrupt_speech,
        }),
      });

      const responseText = await createResponse.text();
      console.log(`[Room API] Response status: ${createResponse.status}, body: ${responseText.substring(0, 200)}`);

      if (!createResponse.ok) {
        sendJsonResponse(res, createResponse.status, { error: `Failed to create room: ${responseText}` });
        return;
      }

      // Parse JSON
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

  // GET /api/rooms/wait/:jobId - Wait for room creation
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
      console.log(`[Room API] Room wait result (job: ${jobId}):`, roomResult.status);

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
          user_name,
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

  // 404 for all other routes
  sendJsonResponse(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`[Server] Running on http://localhost:${PORT}`);
});
