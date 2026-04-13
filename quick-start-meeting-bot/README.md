# Quick Start

A minimal implementation that receives audio from a meeting bot, processes it through OpenAI Realtime API, and streams text responses to the Digiself Stream API.

## Prerequisites

- Node.js 18+
- OpenAI API key with Realtime API access
- Digiself API key
- [ngrok](https://ngrok.com/) account and CLI

## ngrok Setup

This application requires ngrok to expose your local backend server to the internet. The meeting bot needs to connect to your backend via WebSocket.

1. Create an ngrok account at https://ngrok.com/

2. Install ngrok CLI and authenticate:

   ```bash
   ngrok config add-authtoken YOUR_AUTH_TOKEN
   ```

3. Start ngrok to expose port 4000:

   ```bash
   ngrok http 4000
   ```

4. Copy the forwarding URL (e.g., `https://xxxx-xx-xx-xx-xx.ngrok-free.app`)

   Note: Use `wss://xxxx-xx-xx-xx-xx.ngrok-free.app/ws` when configuring the bot output URL.

## Installation

```bash
npm install ws dotenv @openai/agents
```

## Configuration

Create a `.env` file:

```
OUTPUT_WEBSOCKET_URL=wss://xxxx-xx-xx-xx-xx.ngrok-free.app/ws
OPENAI_API_KEY=sk-xxx
DIGISELF_API_KEY=xxx
```

Note: Replace `xxxx-xx-xx-xx-xx.ngrok-free.app` with your actual ngrok domain.

## Usage

1. Start ngrok:

   ```bash
   ngrok http 4000
   ```

2. Start the server:

   ```bash
   node index.mjs
   ```

3. Start a Google Meet meeting and copy the meeting URL.

4. Create a bot by calling the Digiself API (async with long polling):

   Step 1: Create the bot (returns immediately with job_id):

   ```bash
   curl -X POST "https://api.digiself.tech/api/bots" \
     -H "x-api-key: YOUR_DIGISELF_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{
       "meeting_url": "https://meet.google.com/xxx-xxxx-xxx",
       "output_url": "wss://xxxx-xx-xx-xx-xx.ngrok-free.app/ws",
       "avatar_id": "YOUR_AVATAR_ID"
     }'
   ```

   This will return a response like:
   ```json
   {
     "job_id": "uuid-v4-string"
   }
   ```

   Step 2: Wait for the bot to be ready (long polling with 120s timeout):

   ```bash
   curl -X GET "https://api.digiself.tech/api/bots/wait/{job_id}?timeout=120" \
     -H "x-api-key: YOUR_DIGISELF_API_KEY"
   ```

   Replace `{job_id}` with the job_id from Step 1. This will wait up to 120 seconds for the bot to be created and return the bot details when ready.

   Parameters:
   - `meeting_url`: Your Google Meet URL
   - `output_url`: Your ngrok WebSocket URL (use `wss://` protocol with `/ws` path)
   - `avatar_id`: Avatar ID from the Digiself dashboard

## How It Works

1. The meeting bot connects to `ws://localhost:4000/ws` (via ngrok) and sends audio data
2. Audio is upsampled from 16kHz to 24kHz and forwarded to OpenAI Realtime API
3. OpenAI generates text responses
4. Text chunks are streamed to Digiself Stream API for avatar speech synthesis
