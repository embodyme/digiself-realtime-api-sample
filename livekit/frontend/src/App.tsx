import {
  ControlBar,
  GridLayout,
  ParticipantTile,
  RoomAudioRenderer,
  useTracks,
  RoomContext,
} from '@livekit/components-react';
import { Room, Track } from 'livekit-client';
import '@livekit/components-styles';
import { useState, useRef } from 'react';

const LIVEKIT_SERVER_URL = 'wss://digiself-production-uit7o53m.livekit.cloud';
const OUTPUT_WEBSOCKET_URL = import.meta.env.VITE_OUTPUT_WEBSOCKET_URL;
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000';

if (!OUTPUT_WEBSOCKET_URL) {
  throw new Error("Environment variable VITE_OUTPUT_WEBSOCKET_URL must be set.");
}

export default function App() {
  const [room] = useState(() => new Room({
    adaptiveStream: true,
    dynacast: true,
  }));
  const [roomName, setRoomName] = useState('');
  const [userName, setUserName] = useState('');
  const [mode, setMode] = useState<'text' | 'audio' | 'file'>('text');
  const [avatarId, setAvatarId] = useState('');
  const [avatarName, setAvatarName] = useState('');
  const [outputUrl, setOutputUrl] = useState(OUTPUT_WEBSOCKET_URL);
  const [voiceId, setVoiceId] = useState('');
  const [interruptSpeech, setInterruptSpeech] = useState(true);
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [progress, setProgress] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const isConnectingRef = useRef(false);

  const getProgressLabel = (progress: string): string => {
    switch (progress) {
      case 'starting_server':
        return 'Starting server...';
      case 'starting_avatar':
        return 'Starting avatar...';
      case 'ready':
        return 'Ready';
      default:
        return progress || 'Processing...';
    }
  };

  const getParticipantToken = async (roomName: string): Promise<string> => {
    console.log(`Fetching token for room: ${roomName}`);
    const tokenResponse = await fetch(`${BACKEND_URL}/api/rooms/${encodeURIComponent(roomName)}/participants`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        user_name: userName.trim()
      }),
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.json().catch(() => ({}));
      throw new Error(errorData.error || `Failed to get token: ${tokenResponse.statusText}`);
    }
    const data = await tokenResponse.json();
    const token = data.token;
    console.log("Token received:", token);

    if (!token) {
      throw new Error("Token not found in API response.");
    }
    return token;
  };

  const sendVoiceIdToBackend = async (roomName: string, voiceId: string) => {
    try {
      const response = await fetch(`${BACKEND_URL}/api/rooms/${encodeURIComponent(roomName)}/voice`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          voice_id: voiceId.trim()
        }),
      });

      if (!response.ok) {
        console.warn(`Failed to send voice_id to backend: ${response.statusText}`);
      } else {
        console.log(`Voice ID sent to backend for room: ${roomName}`);
      }
    } catch (error) {
      console.error("Error sending voice_id to backend:", error);
    }
  };

  const setModeForRoom = async (roomName: string, mode: string) => {
    try {
      const response = await fetch(`${BACKEND_URL}/api/admin/rooms/${encodeURIComponent(roomName)}/mode`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          mode: mode
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to set mode: ${response.statusText}`);
      }
      console.log(`Mode set to "${mode}" for room: ${roomName}`);
    } catch (error) {
      console.error("Error setting mode for room:", error);
      throw error;
    }
  };

  const createAndJoinRoom = async () => {
    if (isConnectingRef.current || !userName.trim()) {
      return;
    }

    setIsConnecting(true);
    setProgress('');
    setError(null);
    isConnectingRef.current = true;

    try {
      // Step 1: Create room (returns job_id immediately)
      const roomCreationResponse = await fetch(`${BACKEND_URL}/api/rooms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          output_url: outputUrl.trim(),
          avatar_id: avatarId.trim(),
          avatar_name: avatarName.trim(),
          interrupt_speech: interruptSpeech
        }),
      });

      if (!roomCreationResponse.ok) {
        const errorData = await roomCreationResponse.json().catch(() => ({}));
        throw new Error(errorData.error || `Failed to create room: ${roomCreationResponse.statusText}`);
      }
      const createData = await roomCreationResponse.json();
      console.log("Room creation job started:", createData);

      const jobId = createData.job_id;

      // Step 2: Wait for completion (short polling with retry)
      let waitData;
      while (true) {
        const waitRes = await fetch(`${BACKEND_URL}/api/rooms/wait/${jobId}?timeout=5`, {
          method: 'GET',
        });

        console.log('Wait response status:', waitRes.status);
        waitData = await waitRes.json();
        console.log('Wait response data:', waitData);

        // Update progress display
        if (waitData.progress) {
          setProgress(waitData.progress);
        }

        if (!waitRes.ok) {
          throw new Error(waitData.error || waitData.message || `Wait request failed: ${waitRes.statusText}`);
        }

        if (waitData.status === 'failed') {
          throw new Error(waitData.error || 'Room creation failed');
        }

        if (waitData.status === 'completed') {
          break; // Success - exit loop
        }

        // Status is 'in_progress' or 'pending' - continue polling
        console.log(`Room creation in progress (${waitData.status}), progress: ${waitData.progress}, retrying...`);
      }

      const roomData = waitData.result;
      console.log("Room created:", roomData);
      const createdRoomName = roomData.room_name;
      console.log(`Connecting to room: ${createdRoomName}`);

      // Send voice_id to livekit-backend BEFORE setting mode (for text mode)
      // This ensures voice_id is available when mode switch triggers metadata send
      // Always send voice_id (even if empty) to add timing buffer before WebSocket connects
      if (mode === 'text') {
        await sendVoiceIdToBackend(createdRoomName, voiceId);
      }

      // Set mode for the room (after voice_id is set)
      await setModeForRoom(createdRoomName, mode);

      // Small delay to ensure mode config reaches backend before WebSocket connection
      // This prevents race condition where agent connects before HTTP mode request is processed
      await new Promise(resolve => setTimeout(resolve, 100));

      const token = await getParticipantToken(createdRoomName);
      console.log("Connecting to LiveKit with token...");
      await room.connect(LIVEKIT_SERVER_URL, token);
      console.log("Successfully connected to LiveKit!");
      setIsConnected(true);
    } catch (error) {
      console.error("LiveKit connection failed:", error);
      setError(error instanceof Error ? error.message : 'Connection failed');
    } finally {
      setIsConnecting(false);
      isConnectingRef.current = false;
    }
  };

  const joinExistingRoom = async () => {
    if (isConnectingRef.current || !roomName.trim() || !userName.trim()) {
      return;
    }

    setIsConnecting(true);
    setError(null);
    isConnectingRef.current = true;

    try {
      console.log(`Joining existing room: ${roomName.trim()}`);
      const token = await getParticipantToken(roomName.trim());
      console.log("Connecting to LiveKit with token...");
      await room.connect(LIVEKIT_SERVER_URL, token);
      console.log("Successfully connected to LiveKit!");
      setIsConnected(true);
    } catch (error) {
      console.error("LiveKit connection failed:", error);
      setError(error instanceof Error ? error.message : 'Connection failed');
    } finally {
      setIsConnecting(false);
      isConnectingRef.current = false;
    }
  };

  if (!isConnected) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        minHeight: '100vh',
        width: '100vw',
        padding: '40px 20px',
        fontFamily: 'Arial, sans-serif',
        overflowY: 'auto',
        boxSizing: 'border-box'
      }}>
        <h1 style={{ marginBottom: '30px', color: '#fff' }}>LiveKit Demo</h1>

        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '15px',
          width: '100%',
          maxWidth: '400px'
        }}>
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            padding: '20px',
            border: '2px solid #e0e0e0',
            borderRadius: '8px',
            backgroundColor: '#f9f9f9'
          }}>
            <h3 style={{ margin: '0 0 10px 0', color: '#333', fontSize: '18px' }}>Create New Room</h3>

            {/* User Name Input */}
            <div>
              <label htmlFor="userName" style={{
                display: 'block',
                marginBottom: '5px',
                fontWeight: 'bold',
                color: '#555'
              }}>
                User Name:
              </label>
              <input
                id="userName"
                type="text"
                value={userName}
                onChange={(e) => setUserName(e.target.value)}
                placeholder="Enter your user name"
                style={{
                  width: '100%',
                  padding: '12px',
                  border: '2px solid #ddd',
                  borderRadius: '6px',
                  fontSize: '16px',
                  boxSizing: 'border-box',
                  marginBottom: '10px',
                  backgroundColor: 'white',
                  color: 'black'
                }}
                disabled={isConnecting}
              />
            </div>

            {/* Mode Selector */}
            <div style={{ marginBottom: '15px' }}>
              <label style={{
                display: 'block',
                marginBottom: '10px',
                fontWeight: 'bold',
                color: '#555'
              }}>
                Stream Mode:
              </label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <label style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  cursor: 'pointer',
                  padding: '10px',
                  backgroundColor: mode === 'text' ? '#e3f2fd' : 'white',
                  border: `2px solid ${mode === 'text' ? '#2196f3' : '#ddd'}`,
                  borderRadius: '6px',
                  transition: 'all 0.2s'
                }}>
                  <input
                    type="radio"
                    name="mode"
                    value="text"
                    checked={mode === 'text'}
                    onChange={(e) => setMode(e.target.value as 'text' | 'audio' | 'file')}
                    disabled={isConnecting}
                    style={{ cursor: 'pointer' }}
                  />
                  <div>
                    <div style={{ fontWeight: 'bold', color: '#333' }}>Text Mode</div>
                    <div style={{ fontSize: '12px', color: '#666' }}>Google Gemini Live API (16kHz)</div>
                  </div>
                </label>
                <label style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  cursor: 'pointer',
                  padding: '10px',
                  backgroundColor: mode === 'audio' ? '#e3f2fd' : 'white',
                  border: `2px solid ${mode === 'audio' ? '#2196f3' : '#ddd'}`,
                  borderRadius: '6px',
                  transition: 'all 0.2s'
                }}>
                  <input
                    type="radio"
                    name="mode"
                    value="audio"
                    checked={mode === 'audio'}
                    onChange={(e) => setMode(e.target.value as 'text' | 'audio' | 'file')}
                    disabled={isConnecting}
                    style={{ cursor: 'pointer' }}
                  />
                  <div>
                    <div style={{ fontWeight: 'bold', color: '#333' }}>Audio Mode</div>
                    <div style={{ fontSize: '12px', color: '#666' }}>OpenAI Realtime API (24kHz)</div>
                  </div>
                </label>
                <label style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  cursor: 'pointer',
                  padding: '10px',
                  backgroundColor: mode === 'file' ? '#e3f2fd' : 'white',
                  border: `2px solid ${mode === 'file' ? '#2196f3' : '#ddd'}`,
                  borderRadius: '6px',
                  transition: 'all 0.2s'
                }}>
                  <input
                    type="radio"
                    name="mode"
                    value="file"
                    checked={mode === 'file'}
                    onChange={(e) => setMode(e.target.value as 'text' | 'audio' | 'file')}
                    disabled={isConnecting}
                    style={{ cursor: 'pointer' }}
                  />
                  <div>
                    <div style={{ fontWeight: 'bold', color: '#333' }}>File Mode</div>
                    <div style={{ fontSize: '12px', color: '#666' }}>Pre-recorded audio from URL</div>
                  </div>
                </label>
              </div>
            </div>

            <div>
              <label htmlFor="avatarId" style={{
                display: 'block',
                marginBottom: '5px',
                fontWeight: 'bold',
                color: '#555'
              }}>
                Avatar ID:
              </label>
              <input
                id="avatarId"
                type="text"
                value={avatarId}
                onChange={(e) => setAvatarId(e.target.value)}
                placeholder="Enter avatar ID"
                style={{
                  width: '100%',
                  padding: '12px',
                  border: '2px solid #ddd',
                  borderRadius: '6px',
                  fontSize: '16px',
                  boxSizing: 'border-box',
                  marginBottom: '10px',
                  backgroundColor: 'white',
                  color: 'black'
                }}
                disabled={isConnecting}
              />
            </div>
            <div>
              <label htmlFor="avatarName" style={{
                display: 'block',
                marginBottom: '5px',
                fontWeight: 'bold',
                color: '#555'
              }}>
                Avatar Name:
              </label>
              <input
                id="avatarName"
                type="text"
                value={avatarName}
                onChange={(e) => setAvatarName(e.target.value)}
                placeholder="Enter avatar name"
                style={{
                  width: '100%',
                  padding: '12px',
                  border: '2px solid #ddd',
                  borderRadius: '6px',
                  fontSize: '16px',
                  boxSizing: 'border-box',
                  marginBottom: '10px',
                  backgroundColor: 'white',
                  color: 'black'
                }}
                disabled={isConnecting}
              />
            </div>
            <div>
              <label htmlFor="outputUrl" style={{
                display: 'block',
                marginBottom: '5px',
                fontWeight: 'bold',
                color: '#555'
              }}>
                Output URL:
              </label>
              <input
                id="outputUrl"
                type="text"
                value={outputUrl}
                onChange={(e) => setOutputUrl(e.target.value)}
                style={{
                  width: '100%',
                  padding: '12px',
                  border: '2px solid #ddd',
                  borderRadius: '6px',
                  fontSize: '16px',
                  boxSizing: 'border-box',
                  marginBottom: '10px',
                  backgroundColor: 'white',
                  color: 'black'
                }}
                disabled={isConnecting}
              />
            </div>

            {/* Voice ID field - only for text mode */}
            {mode === 'text' && (
              <div>
                <label htmlFor="voiceId" style={{
                  display: 'block',
                  marginBottom: '5px',
                  fontWeight: 'bold',
                  color: '#555'
                }}>
                  Voice ID (Optional):
                </label>
                <input
                  id="voiceId"
                  type="text"
                  value={voiceId}
                  onChange={(e) => setVoiceId(e.target.value)}
                  placeholder="Enter voice ID for text mode"
                  style={{
                    width: '100%',
                    padding: '12px',
                    border: '2px solid #ddd',
                    borderRadius: '6px',
                    fontSize: '16px',
                    boxSizing: 'border-box',
                    marginBottom: '10px',
                    backgroundColor: 'white',
                    color: 'black'
                  }}
                  disabled={isConnecting}
                />
              </div>
            )}

            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              marginBottom: '10px'
            }}>
              <label htmlFor="interruptSpeech" style={{
                fontWeight: 'bold',
                color: '#555',
                cursor: 'pointer'
              }}>
                Interrupt Speech:
              </label>
              <button
                id="interruptSpeech"
                type="button"
                onClick={() => setInterruptSpeech(!interruptSpeech)}
                disabled={isConnecting}
                style={{
                  width: '50px',
                  height: '26px',
                  borderRadius: '13px',
                  border: 'none',
                  backgroundColor: interruptSpeech ? '#28a745' : '#ccc',
                  position: 'relative',
                  cursor: isConnecting ? 'not-allowed' : 'pointer',
                  transition: 'background-color 0.2s'
                }}
              >
                <span style={{
                  position: 'absolute',
                  top: '3px',
                  left: interruptSpeech ? '27px' : '3px',
                  width: '20px',
                  height: '20px',
                  borderRadius: '50%',
                  backgroundColor: 'white',
                  transition: 'left 0.2s'
                }} />
              </button>
              <span style={{ color: '#666', fontSize: '14px' }}>
                {interruptSpeech ? 'ON' : 'OFF'}
              </span>
            </div>
            <button
              onClick={createAndJoinRoom}
              disabled={isConnecting || !userName.trim()}
              style={{
                padding: '12px 24px',
                backgroundColor: isConnecting || !userName.trim() ? '#ccc' : '#28a745',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                fontSize: '16px',
                cursor: isConnecting || !userName.trim() ? 'not-allowed' : 'pointer',
                transition: 'background-color 0.2s'
              }}
            >
              {isConnecting ? getProgressLabel(progress) : 'Create & Join Room'}
            </button>
          </div>

          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            padding: '20px',
            border: '2px solid #e0e0e0',
            borderRadius: '8px',
            backgroundColor: '#f9f9f9'
          }}>
            <h3 style={{ margin: '0 0 10px 0', color: '#333', fontSize: '18px' }}>Join Existing Room</h3>
            <div>
              <label htmlFor="roomName" style={{
                display: 'block',
                marginBottom: '5px',
                fontWeight: 'bold',
                color: '#555'
              }}>
                Room Name:
              </label>
              <input
                id="roomName"
                type="text"
                value={roomName}
                onChange={(e) => setRoomName(e.target.value)}
                placeholder="Enter room name"
                style={{
                  width: '100%',
                  padding: '12px',
                  border: '2px solid #ddd',
                  borderRadius: '6px',
                  fontSize: '16px',
                  boxSizing: 'border-box',
                  backgroundColor: 'white',
                  color: 'black'
                }}
                disabled={isConnecting}
              />
            </div>
            <button
              onClick={joinExistingRoom}
              disabled={isConnecting || !roomName.trim() || !userName.trim()}
              style={{
                padding: '12px 24px',
                backgroundColor: isConnecting || !roomName.trim() || !userName.trim() ? '#ccc' : '#007bff',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                fontSize: '16px',
                cursor: isConnecting || !roomName.trim() || !userName.trim() ? 'not-allowed' : 'pointer',
                transition: 'background-color 0.2s'
              }}
            >
              {isConnecting ? 'Joining...' : 'Join Existing Room'}
            </button>
          </div>

          {error && (
            <div style={{
              padding: '12px',
              backgroundColor: '#f8d7da',
              color: '#721c24',
              border: '1px solid #f5c6cb',
              borderRadius: '6px',
              fontSize: '14px'
            }}>
              Error: {error}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <RoomContext.Provider value={room}>
      <div data-lk-theme="default" style={{ height: '100vh' }}>
        <MyVideoConference />
        <RoomAudioRenderer />
        <ControlBar />
      </div>
    </RoomContext.Provider>
  );
}

function MyVideoConference() {
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );

  // Filter out tracks from LiveKit Agents (IDs starting with "agent")
  const filteredTracks = tracks.filter(
    (track) => !track.participant.identity.startsWith('agent')
  );

  return (
    <GridLayout tracks={filteredTracks} style={{ height: 'calc(100vh - var(--lk-control-bar-height))' }}>
      <ParticipantTile />
    </GridLayout>
  );
}
