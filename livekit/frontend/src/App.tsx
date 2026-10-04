import {
  ControlBar,
  GridLayout,
  ParticipantTile,
  RoomAudioRenderer,
  useTracks,
  RoomContext,
} from '@livekit/components-react';
import { Room, RoomEvent, Track } from 'livekit-client';
import '@livekit/components-styles';
import { useState, useRef, useEffect } from 'react';
import { BrowserDirectConnection } from './browserDirect';

const LIVEKIT_SERVER_URL = 'wss://digiself-production-uit7o53m.livekit.cloud';
const STREAM_API_URL = 'wss://stream-api.digiself.tech';
// Only needed when Browser Direct is off (the DigiSelf agent sends room audio to this URL)
const OUTPUT_WEBSOCKET_URL = import.meta.env.VITE_OUTPUT_WEBSOCKET_URL || '';
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000';

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
  const [interruptSpeech, setInterruptSpeech] = useState(false);
  const [browserDirect, setBrowserDirect] = useState(false);
  const [audioFileUrl, setAudioFileUrl] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [progress, setProgress] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [browserDirectSession, setBrowserDirectSession] = useState(false);
  const [audioPrewarm, setAudioPrewarm] = useState(false);
  const [micEnabled, setMicEnabled] = useState(true);
  const isConnectingRef = useRef(false);
  const browserDirectRef = useRef<BrowserDirectConnection | null>(null);

  // Return to the start screen whenever the room disconnects (leave button or room closed)
  useEffect(() => {
    const handleDisconnected = () => {
      browserDirectRef.current?.close();
      browserDirectRef.current = null;
      setBrowserDirectSession(false);
      setIsConnected(false);
    };
    room.on(RoomEvent.Disconnected, handleDisconnected);
    return () => {
      room.off(RoomEvent.Disconnected, handleDisconnected);
    };
  }, [room]);

  const toggleMic = async () => {
    const enabled = !micEnabled;
    setMicEnabled(enabled);
    await browserDirectRef.current?.setMicEnabled(enabled);
  };

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
    if (!browserDirect && !outputUrl.trim()) {
      setError('Output URL is required when Browser Direct is off.');
      return;
    }
    if (browserDirect && mode === 'file' && !audioFileUrl.trim()) {
      setError('Audio File URL is required for File Mode with Browser Direct.');
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
          // Browser Direct does not use the backend WebSocket, so no output_url is sent
          output_url: browserDirect ? undefined : outputUrl.trim(),
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

      if (browserDirect) {
        // Browser Direct: the browser talks to OpenAI and the Stream API itself
        if (!roomData.token) {
          throw new Error('No temporary token in the room creation result.');
        }
        const token = await getParticipantToken(createdRoomName);
        await room.connect(LIVEKIT_SERVER_URL, token);

        // Start playing the avatar audio before the setup below (see HiddenRoomAudioPrewarm)
        setAudioPrewarm(true);
        await waitForNextPaint();

        const conn = new BrowserDirectConnection({
          room,
          roomName: createdRoomName,
          mode,
          streamApiToken: roomData.token,
          streamApiUrl: STREAM_API_URL,
          backendUrl: BACKEND_URL,
          voiceId: voiceId.trim(),
          audioFileUrl: audioFileUrl.trim(),
          interruptSpeech,
          onStatusChange: (status) => console.log('[BrowserDirect]', status),
          onError: setError,
        });
        browserDirectRef.current = conn;
        await conn.connect();

        setMicEnabled(true);
        setBrowserDirectSession(true);
        setIsConnected(true);
        return;
      }

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
      // Release whatever was set up before the failure
      browserDirectRef.current?.close();
      browserDirectRef.current = null;
      await room.disconnect();
    } finally {
      // The in-room view has its own RoomAudioRenderer
      setAudioPrewarm(false);
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
                    <div style={{ fontSize: '12px', color: '#666' }}>OpenAI gpt-realtime</div>
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
                    <div style={{ fontSize: '12px', color: '#666' }}>OpenAI gpt-realtime</div>
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
            {/* Output URL - the backend WebSocket is only used when Browser Direct is off */}
            {!browserDirect && (
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
            )}

            {/* Audio File URL - sent to the Stream API by the browser in File Mode */}
            {browserDirect && mode === 'file' && (
              <div>
                <label htmlFor="audioFileUrl" style={{
                  display: 'block',
                  marginBottom: '5px',
                  fontWeight: 'bold',
                  color: '#555'
                }}>
                  Audio File URL:
                </label>
                <input
                  id="audioFileUrl"
                  type="text"
                  value={audioFileUrl}
                  onChange={(e) => setAudioFileUrl(e.target.value)}
                  placeholder="https://example.com/audio.wav"
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

            <ToggleSwitch
              id="browserDirect"
              label="Browser Direct:"
              description="The browser talks to OpenAI and the DigiSelf Stream API directly. No backend WebSocket (ngrok) is needed."
              value={browserDirect}
              onChange={setBrowserDirect}
              disabled={isConnecting}
            />
            <ToggleSwitch
              id="interruptSpeech"
              label="Interrupt Speech:"
              value={interruptSpeech}
              onChange={setInterruptSpeech}
              disabled={isConnecting}
            />
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

        {audioPrewarm && <HiddenRoomAudioPrewarm room={room} />}
      </div>
    );
  }

  return (
    <RoomContext.Provider value={room}>
      <div data-lk-theme="default" style={{ height: '100vh' }}>
        <MyVideoConference excludeLocal={browserDirectSession} />
        <RoomAudioRenderer />
        {browserDirectSession ? (
          <BrowserDirectControls
            micEnabled={micEnabled}
            onToggleMic={toggleMic}
            onLeave={() => room.disconnect()}
          />
        ) : (
          <ControlBar />
        )}
      </div>
    </RoomContext.Provider>
  );
}

// Plays the avatar audio while Browser Direct is still starting. Chrome keeps receiving
// remote audio that no element plays and buffers it, so a renderer mounted seconds later
// would start that far behind the avatar video and only slowly catch up.
function HiddenRoomAudioPrewarm({ room }: { room: Room }) {
  return (
    <RoomContext.Provider value={room}>
      <div
        aria-hidden="true"
        style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', opacity: 0, pointerEvents: 'none' }}
      >
        <RoomAudioRenderer />
      </div>
    </RoomContext.Provider>
  );
}

// Resolves once the next frame has been painted. requestAnimationFrame does not run in
// background tabs, so a timer resolves it there.
function waitForNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 200);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      clearTimeout(timer);
      resolve();
    }));
  });
}

function ToggleSwitch({ id, label, description, value, onChange, disabled }: {
  id: string;
  label: string;
  description?: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled: boolean;
}) {
  return (
    <div style={{ marginBottom: '10px' }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px'
      }}>
        <label htmlFor={id} style={{
          fontWeight: 'bold',
          color: '#555',
          cursor: 'pointer'
        }}>
          {label}
        </label>
        <button
          id={id}
          type="button"
          onClick={() => onChange(!value)}
          disabled={disabled}
          style={{
            width: '50px',
            height: '26px',
            borderRadius: '13px',
            border: 'none',
            backgroundColor: value ? '#28a745' : '#ccc',
            position: 'relative',
            cursor: disabled ? 'not-allowed' : 'pointer',
            transition: 'background-color 0.2s'
          }}
        >
          <span style={{
            position: 'absolute',
            top: '3px',
            left: value ? '27px' : '3px',
            width: '20px',
            height: '20px',
            borderRadius: '50%',
            backgroundColor: 'white',
            transition: 'left 0.2s'
          }} />
        </button>
        <span style={{ color: '#666', fontSize: '14px' }}>
          {value ? 'ON' : 'OFF'}
        </span>
      </div>
      {description && (
        <div style={{ fontSize: '12px', color: '#666', marginTop: '4px' }}>{description}</div>
      )}
    </div>
  );
}

// In Browser Direct the browser microphone goes to both OpenAI and LiveKit, so the
// LiveKit ControlBar is replaced with a button that mutes both at once.
function BrowserDirectControls({ micEnabled, onToggleMic, onLeave }: {
  micEnabled: boolean;
  onToggleMic: () => void;
  onLeave: () => void;
}) {
  return (
    <div className="lk-control-bar">
      <button className="lk-button" onClick={onToggleMic} aria-pressed={micEnabled}>
        {micEnabled ? 'Mute Microphone' : 'Unmute Microphone'}
      </button>
      <button className="lk-button lk-disconnect-button" onClick={onLeave}>
        Leave
      </button>
    </div>
  );
}

function MyVideoConference({ excludeLocal }: { excludeLocal: boolean }) {
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );

  // Filter out tracks from LiveKit Agents (IDs starting with "agent"), and in Browser
  // Direct also the user's own tile so that only the avatar is shown
  const filteredTracks = tracks.filter(
    (track) => !track.participant.identity.startsWith('agent') &&
      !(excludeLocal && track.participant.isLocal)
  );

  return (
    <GridLayout tracks={filteredTracks} style={{ height: 'calc(100vh - var(--lk-control-bar-height))' }}>
      <ParticipantTile />
    </GridLayout>
  );
}
