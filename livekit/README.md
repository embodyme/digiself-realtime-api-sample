# Digiself Realtime API Sample - LiveKit Integration

A sample application demonstrating real-time avatar interaction using LiveKit and the Digiself Realtime API.

## Overview

This application consists of two components:

- **Frontend**: A React application that provides a web interface for video conferencing with LiveKit
- **Backend**: A Node.js server that bridges LiveKit audio streams to AI services (OpenAI Realtime API) and the Digiself streaming API

## Prerequisites

- Docker
- [ngrok](https://ngrok.com/) account and CLI
- OpenAI API Key (for text and audio modes)
- Digiself API Key

## ngrok Setup

This application requires ngrok to expose your local backend server to the internet. The Digiself streaming API needs to connect to your backend via WebSocket.

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

3. Start the application:

   ```bash
   docker-compose up
   ```

4. Open your browser and navigate to `http://localhost:5173`


## Stream Modes

The application supports three streaming modes:

| Mode | Description | API Used |
|------|-------------|----------|
| **Text** | Transcribes speech and generates text responses with TTS | OpenAI Realtime API |
| **Audio** | Direct audio-to-audio conversation | OpenAI Realtime API |
| **File** | Plays pre-recorded audio from a URL | Static file |

## License

MIT
