# Digiself Realtime API Sample - LiveKit Integration

A sample application demonstrating real-time avatar interaction using LiveKit and the Digiself Realtime API.

## Overview

This application consists of two components:

- **Frontend**: A React application that provides a web interface for video conferencing with LiveKit
- **Backend**: A Node.js server that issues tokens and, when Browser Direct is off, bridges LiveKit audio streams to AI services (OpenAI Realtime API, gpt-realtime-2.1) and the Digiself streaming API

## Connection Modes

The **Browser Direct** toggle on the start screen selects how audio and text flow. It is off by default.

| Mode | Flow | ngrok |
|------|------|-------|
| **Browser Direct** | The browser sends the microphone to OpenAI over WebRTC and forwards OpenAI's output to the Digiself Stream API with the room's temporary token. The microphone is also published to LiveKit so that, with Interrupt Speech on, the avatar stops speaking when you talk. The backend only issues the OpenAI ephemeral token and the LiveKit participant token. | Not needed |
| **Server** (default, Browser Direct off) | The Digiself LiveKit agent sends the room audio to the backend (`OUTPUT_WEBSOCKET_URL`). The backend talks to OpenAI and forwards its output to the Digiself Stream API. | Required |

The **Interrupt Speech** toggle, also off by default, makes the avatar stop speaking when you start talking (`interrupt_speech` in room creation).

## Prerequisites

- Docker
- [ngrok](https://ngrok.com/) account and CLI (not needed if you only use Browser Direct)
- OpenAI API Key with access to gpt-realtime-2.1 (for text and audio modes)
- Digiself API Key

## ngrok Setup

With Browser Direct off, the application requires ngrok to expose your local backend server to the internet. The Digiself LiveKit agent needs to connect to your backend via WebSocket. Skip this section if you only use Browser Direct.

1. Create an ngrok account at https://ngrok.com/

2. Install ngrok CLI and authenticate:

   ```bash
   ngrok config add-authtoken YOUR_AUTH_TOKEN
   ```

3. Start ngrok to expose port 3000:

   ```bash
   ngrok http 3000
   ```

4. Copy the forwarding URL (e.g., `https://xxxx-xx-xx-xx-xx.ngrok-free.app`) and use it for `OUTPUT_WEBSOCKET_URL`:

   ```
   OUTPUT_WEBSOCKET_URL=wss://xxxx-xx-xx-xx-xx.ngrok-free.app
   ```

   Note: Replace `https://` with `wss://` for WebSocket connections.

## Quick Start with Docker

1. Copy the environment file and configure it:

   ```bash
   cp .env.example .env
   ```

2. Edit `.env` with your credentials:

   ```
   OUTPUT_WEBSOCKET_URL=wss://your-ngrok-domain
   OPENAI_API_KEY=your-openai-api-key
   DIGISELF_API_KEY=your-digiself-api-key
   ```

   `OUTPUT_WEBSOCKET_URL` can be left empty if you only use Browser Direct.

3. Start the application:

   ```bash
   docker-compose up
   ```

4. Open your browser and navigate to `http://localhost:5173`


## Stream Modes

The application supports three streaming modes:

| Mode | Description | API Used |
|------|-------------|----------|
| **Text** | Generates text-only responses (`output_modalities: ['text']`) that DigiSelf speaks with its TTS | OpenAI Realtime API (gpt-realtime-2.1) |
| **Audio** | Direct audio-to-audio conversation; the generated audio is streamed to DigiSelf | OpenAI Realtime API (gpt-realtime-2.1) |
| **File** | Plays pre-recorded audio from a URL | Static file |

## License

MIT
