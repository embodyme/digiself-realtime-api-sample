# Quick Start - LiveKit Avatar Demo

A minimal implementation with LiveKit, OpenAI Realtime API, and Digiself Stream API.

## Prerequisites

- Node.js 20.x or later
- npm or yarn
- OpenAI API Key
- Digiself API Key
- LiveKit server URL (provided by Digiself)

## Setup

### 1. Install Dependencies

**Backend:**
```bash
cd backend
npm install
```

**Frontend:**
```bash
cd frontend
npm install
```

### 2. Configure Environment Variables

**Backend** - Create `backend/.env`:
```bash
OPENAI_API_KEY=your-openai-api-key
DIGISELF_API_KEY=your-digiself-api-key
DIGISELF_API_BASE_URL=https://realtime-api.digiself.tech
```

**Frontend** - Create `frontend/.env`:
```bash
VITE_LIVEKIT_SERVER_URL=wss://digiself-production-uit7o53m.livekit.cloud
VITE_BACKEND_URL=http://localhost:3000
VITE_STREAM_API_URL=wss://stream-api.digiself.tech
```

> **Note**: You can use the `.env.example` files as templates.

## Running the Application

### Start Backend Server

```bash
cd backend
npm start
```

The backend will start on `http://localhost:3000`.

### Start Frontend Development Server

In a separate terminal:

```bash
cd frontend
npm run dev
```

The frontend will start on `http://localhost:5173`.

## Usage

1. Open your browser to `http://localhost:5173`
2. Enter your **Avatar ID** in the form
3. Click **Start Session**
4. Grant microphone permission when prompted
5. Wait for the connection to complete
6. Speak into your microphone to interact with the avatar
7. Click **Disconnect** to end the session

## License

This is a sample/demo application. Please refer to the main project license.
