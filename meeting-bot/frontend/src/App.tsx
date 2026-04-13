import React, { useState, useRef } from 'react';
import './App.css';

const OUTPUT_WEBSOCKET_URL = import.meta.env.VITE_OUTPUT_WEBSOCKET_URL;
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:4000';

if (!OUTPUT_WEBSOCKET_URL) {
  throw new Error("Environment variable VITE_OUTPUT_WEBSOCKET_URL must be set.");
}

interface BotResponse {
  bot_id?: string;
  bot_name?: string;
  meeting_url?: string;
  message?: string;
  error?: string;
}

export default function App() {
  const [meetingUrl, setMeetingUrl] = useState('');
  const [botName, setBotName] = useState('Avatar');
  const [avatarId, setAvatarId] = useState('');
  const [outputUrl, setOutputUrl] = useState(OUTPUT_WEBSOCKET_URL);
  const [mode, setMode] = useState<'text' | 'audio' | 'file'>('text');
  const [voiceId, setVoiceId] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState<string>('');
  const [response, setResponse] = useState<BotResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isSubmittingRef = useRef(false);

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

  const handleStartBot = async () => {
    if (isSubmittingRef.current || !meetingUrl.trim()) {
      return;
    }

    setIsLoading(true);
    setProgress('');
    setError(null);
    setResponse(null);
    isSubmittingRef.current = true;

    try {
      // Step 1: Create bot (returns job_id immediately)
      console.log('Sending request to:', `${BACKEND_URL}/api/bots`);
      const requestBody = {
        bot_name: botName.trim(),
        meeting_url: meetingUrl.trim(),
        output_url: outputUrl.trim(),
        avatar_id: avatarId.trim(),
      };
      console.log('Request body:', requestBody);

      const createRes = await fetch(`${BACKEND_URL}/api/bots`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      console.log('Create response status:', createRes.status);
      const createData = await createRes.json();
      console.log('Create response data:', createData);

      if (!createRes.ok) {
        throw new Error(createData.error || createData.message || `Request failed: ${createRes.statusText}`);
      }

      const jobId = createData.job_id;
      console.log('Bot creation job started:', jobId);

      // Step 2: Wait for completion (short polling with retry)
      let waitData;
      while (true) {
        const waitRes = await fetch(`${BACKEND_URL}/api/bots/wait/${jobId}?timeout=5`, {
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
          throw new Error(waitData.error || 'Bot creation failed');
        }

        if (waitData.status === 'completed') {
          break; // Success - exit loop
        }

        // Status is 'in_progress' or 'pending' - continue polling
        console.log(`Bot creation in progress (${waitData.status}), progress: ${waitData.progress}, retrying...`);
      }

      const data = waitData.result;
      console.log('Bot created:', data);
      setResponse(data);

      // Send mode and voice_id to meeting bot backend after bot creation
      if (data.bot_id) {
        try {
          // Send voice_id first if provided (for text mode) - before mode to avoid race condition
          if (mode === 'text' && voiceId.trim()) {
            await fetch(`${BACKEND_URL}/api/bots/${data.bot_id}/voice`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ voice_id: voiceId.trim() }),
            });
            console.log(`Voice ID sent to backend for bot: ${data.bot_id}`);
          }

          // Send mode configuration
          await fetch(`${BACKEND_URL}/api/bots/${data.bot_id}/mode`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ mode }),
          });
          console.log(`Mode "${mode}" sent to backend for bot: ${data.bot_id}`);
        } catch (configErr) {
          console.error('Failed to send configuration to backend:', configErr);
          // Don't fail the whole operation if config fails
        }
      }
    } catch (err) {
      console.error('Bot start failed:', err);
      setError(err instanceof Error ? err.message : 'Failed to start bot');
    } finally {
      setIsLoading(false);
      isSubmittingRef.current = false;
    }
  };

  return (
    <div className="app-container">
      <div className="card">
        <h1 className="title">Meeting Bot</h1>
        <p className="subtitle">Enter the meeting URL to start the bot</p>

        <div className="form">
          <div className="form-group">
            <label htmlFor="botName" className="label">
              Bot Name
            </label>
            <input
              id="botName"
              type="text"
              value={botName}
              onChange={(e) => setBotName(e.target.value)}
              placeholder="e.g. Avatar"
              className="input"
              disabled={isLoading}
            />
          </div>

          <div className="form-group">
            <label htmlFor="meetingUrl" className="label">
              Meeting URL <span className="required">*</span>
            </label>
            <input
              id="meetingUrl"
              type="url"
              value={meetingUrl}
              onChange={(e) => setMeetingUrl(e.target.value)}
              placeholder="e.g. https://meet.google.com/xxx-yyyy-zzz"
              className="input"
              disabled={isLoading}
            />
          </div>

          <div className="form-group">
            <label htmlFor="avatarId" className="label">
              Avatar ID <span className="required">*</span>
            </label>
            <input
              id="avatarId"
              type="text"
              value={avatarId}
              onChange={(e) => setAvatarId(e.target.value)}
              className="input"
              disabled={isLoading}
            />
          </div>

          <div className="form-group">
            <label htmlFor="mode" className="label">
              Mode <span className="required">*</span>
            </label>
            <select
              id="mode"
              value={mode}
              onChange={(e) => setMode(e.target.value as 'text' | 'audio' | 'file')}
              className="input"
              disabled={isLoading}
            >
              <option value="text">Text (OpenAI)</option>
              <option value="audio">Audio (OpenAI)</option>
              <option value="file">File (Audio URL)</option>
            </select>
          </div>

          {mode === 'text' && (
            <div className="form-group">
              <label htmlFor="voiceId" className="label">
                Voice ID (Optional)
              </label>
              <input
                id="voiceId"
                type="text"
                value={voiceId}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setVoiceId(e.target.value)}
                className="input"
                disabled={isLoading}
              />
            </div>
          )}

          <button
            onClick={handleStartBot}
            disabled={isLoading || !meetingUrl.trim() || !avatarId.trim()}
            className={`button ${isLoading || !meetingUrl.trim() || !avatarId.trim() ? 'button-disabled' : 'button-primary'}`}
          >
            {isLoading ? (
              <>
                <span className="spinner"></span>
                {getProgressLabel(progress)}
              </>
            ) : (
              'Start Bot'
            )}
          </button>
        </div>

        {error && (
          <div className="alert alert-error">
            <div className="alert-title">Error</div>
            <div className="alert-message">{error}</div>
          </div>
        )}

        {response && (
          <div className="alert alert-success">
            <div className="alert-title">Success</div>
            <div className="response-details">
              {response.bot_id && (
                <div className="response-item">
                  <span className="response-label">Bot ID:</span>
                  <span className="response-value">{response.bot_id}</span>
                </div>
              )}
              {response.bot_name && (
                <div className="response-item">
                  <span className="response-label">Bot Name:</span>
                  <span className="response-value">{response.bot_name}</span>
                </div>
              )}
              {response.meeting_url && (
                <div className="response-item">
                  <span className="response-label">Meeting URL:</span>
                  <span className="response-value">{response.meeting_url}</span>
                </div>
              )}
              {response.message && (
                <div className="response-item">
                  <span className="response-label">Message:</span>
                  <span className="response-value">{response.message}</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
