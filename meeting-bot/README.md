# Digiself Realtime API Sample - Meeting Bot Integration

A sample application demonstrating real-time avatar interaction in Google Meet using a meeting bot and the Digiself Realtime API.

## Overview

This application consists of two components:

- **Frontend**: A React application that provides a web interface to control the meeting bot
- **Backend**: A Node.js server that bridges meeting bot audio streams to AI services (OpenAI Realtime API) and the Digiself streaming API

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

3. Start ngrok to expose port 4000:

   ```bash
   ngrok http 4000
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

4. Open your browser and navigate to `http://localhost:5174`

## Usage

1. Start a new meeting in Google Meet

2. Access the application URL above, enter the meeting URL in the "Meeting URL" field, and click the "Start" button

3. After a short while, a dialog will appear in Google Meet - click "Approve" to allow the avatar to join the meeting

## Stream Modes

The application supports three streaming modes:

| Mode | Description | API Used |
|------|-------------|----------|
| **Text** | Transcribes speech and generates text responses with TTS | OpenAI Realtime API |
| **Audio** | Direct audio-to-audio conversation | OpenAI Realtime API |
| **File** | Plays pre-recorded audio from a URL | Static file |

## License

MIT
