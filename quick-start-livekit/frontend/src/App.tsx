import { useState, useRef } from 'react';
import { Room } from 'livekit-client';
import { LiveKitRoom, RoomAudioRenderer } from '@livekit/components-react';
import { BrowserDirectConnection } from './browserDirect';
import { VideoConference } from './VideoConference';
import { LIVEKIT_SERVER_URL, BACKEND_URL, STREAM_API_URL } from './config';
import '@livekit/components-styles';

export default function App() {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');

  // Form fields
  const [avatarId, setAvatarId] = useState('');

  const [roomName, setRoomName] = useState('');
  const [token, setToken] = useState('');
  const roomRef = useRef<Room | null>(null);
  const browserDirectRef = useRef<BrowserDirectConnection | null>(null);

  const handleConnect = async () => {
    setIsConnecting(true);
    setError(null);

    try {
      // 1. Create room
      setStatus('Creating room...');
      const createRes = await fetch(`${BACKEND_URL}/api/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ avatar_id: avatarId, avatar_name: 'Avatar' }),
      });

      if (!createRes.ok) {
        const errorData = await createRes.json();
        throw new Error(errorData.error || 'Failed to create room');
      }

      const { job_id } = await createRes.json();

      // 2. Wait for room
      setStatus('Waiting for room...');
      let roomData;
      while (true) {
        const waitRes = await fetch(`${BACKEND_URL}/api/rooms/wait/${job_id}?timeout=5`);

        if (!waitRes.ok) {
          const errorData = await waitRes.json();
          throw new Error(errorData.error || 'Failed to wait for room');
        }

        const data = await waitRes.json();
        if (data.status === 'completed') {
          roomData = data.result;
          break;
        }
        if (data.status === 'failed') {
          throw new Error(data.error || 'Room creation failed');
        }
      }

      // 3. Get participant token
      setStatus('Getting token...');
      const tokenRes = await fetch(`${BACKEND_URL}/api/rooms/${roomData.room_name}/participants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_name: 'user1' }),
      });

      if (!tokenRes.ok) {
        const errorData = await tokenRes.json();
        throw new Error(errorData.error || 'Failed to get participant token');
      }

      const { token: participantToken } = await tokenRes.json();

      // 4. Connect to Livekit
      setStatus('Connecting to Livekit...');
      const room = new Room();
      await room.connect(LIVEKIT_SERVER_URL, participantToken);
      roomRef.current = room;

      // 5. Publish the user's microphone to Livekit.
      //
      // DigiSelf avatar uses the audio from Livekit to detect user speech and interrupt its own playback.
      // Without publishing the mic to Livekit, the avatar will keep speaking even when the user starts talking.
      // Publish the mic track here so interruption works end-to-end.
      await room.localParticipant.setMicrophoneEnabled(true);

      // 6. Start BrowserDirect
      setStatus('Starting...');
      const conn = new BrowserDirectConnection({
        roomName: roomData.room_name,
        streamApiToken: roomData.token,
        streamApiUrl: STREAM_API_URL,
        backendUrl: BACKEND_URL,
        onStatusChange: setStatus,
        onError: setError,
      });
      await conn.connect();
      browserDirectRef.current = conn;

      setRoomName(roomData.room_name);
      setToken(participantToken);
      setIsConnected(true);
      setStatus('Connected!');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed');
    } finally {
      setIsConnecting(false);
    }
  };

  const handleDisconnect = () => {
    browserDirectRef.current?.close();
    roomRef.current?.disconnect();
    setIsConnected(false);
    setStatus('');
    setError(null);
  };

  if (isConnected) {
    return (
      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '10px', background: '#333', color: '#fff', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div>Room: {roomName}</div>
            <div>Status: {status}</div>
          </div>
          <button
            onClick={handleDisconnect}
            style={{ padding: '8px 16px', cursor: 'pointer' }}
          >
            Disconnect
          </button>
        </div>
        <LiveKitRoom
          token={token}
          serverUrl={LIVEKIT_SERVER_URL}
          connect={true}
          style={{ flex: 1 }}
        >
          <VideoConference excludeSelf={true} />
          <RoomAudioRenderer />
        </LiveKitRoom>
      </div>
    );
  }

  return (
    <div style={{ padding: '40px', maxWidth: '400px', margin: '0 auto', fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ marginBottom: '24px' }}>Quick Start</h1>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div>
          <label style={{ display: 'block', marginBottom: '4px', fontSize: '14px', fontWeight: '500' }}>
            Avatar ID *
          </label>
          <input
            type="text"
            placeholder="Avatar ID"
            value={avatarId}
            onChange={(e) => setAvatarId(e.target.value)}
            style={{ width: '100%', padding: '8px', fontSize: '14px', border: '1px solid #ccc', borderRadius: '4px' }}
          />
        </div>

        <button
          onClick={handleConnect}
          disabled={isConnecting || !avatarId}
          style={{
            marginTop: '8px',
            padding: '12px',
            fontSize: '16px',
            fontWeight: '500',
            backgroundColor: isConnecting || !avatarId ? '#ccc' : '#007bff',
            color: '#fff',
            border: 'none',
            borderRadius: '4px',
            cursor: isConnecting || !avatarId ? 'not-allowed' : 'pointer',
          }}
        >
          {isConnecting ? status : 'Start Session'}
        </button>

        {error && (
          <div style={{ marginTop: '8px', padding: '8px', backgroundColor: '#ffe7e7', color: '#d00', borderRadius: '4px', fontSize: '14px' }}>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
