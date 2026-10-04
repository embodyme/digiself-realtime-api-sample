import { ConnectionState, Room, Track, type LocalTrackPublication } from 'livekit-client';

export type StreamMode = 'text' | 'audio' | 'file';

export interface BrowserDirectConfig {
  /** Connected LiveKit room. The microphone is published here for interruption detection. */
  room: Room;
  roomName: string;
  mode: StreamMode;
  /** Temporary token returned with the created room, used to connect to the Stream API */
  streamApiToken: string;
  streamApiUrl: string;
  backendUrl: string;
  voiceId?: string;
  audioFileUrl?: string;
  interruptSpeech: boolean;
  onStatusChange?: (status: string) => void;
  onError?: (error: string) => void;
}

/**
 * Browser Direct: the browser sends the microphone to OpenAI over WebRTC and forwards
 * OpenAI's output straight to the DigiSelf Stream API. The backend only issues tokens.
 */
export class BrowserDirectConnection {
  private config: BrowserDirectConfig;
  private micSource: MediaStreamTrack | null = null;
  private openaiMicTrack: MediaStreamTrack | null = null;
  private livekitMicTrack: MediaStreamTrack | null = null;
  private livekitMicPublication: LocalTrackPublication | null = null;
  private peerConnection: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private streamApiWs: WebSocket | null = null;
  private streamApiConfigAcked = false;
  private audioContext: AudioContext | null = null;
  private audioProcessor: ScriptProcessorNode | null = null;
  private remoteAudioElement: HTMLAudioElement | null = null;
  private currentResponseId: string | null = null;
  private currentRequestId: string | null = null;
  // Response whose audio is sent with currentRequestId (audio mode)
  private requestResponseId: string | null = null;
  private closed = false;

  constructor(config: BrowserDirectConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    try {
      // Capture the microphone once. One copy goes to LiveKit so DigiSelf can detect
      // the user speaking and interrupt the avatar, the other goes to OpenAI.
      this.config.onStatusChange?.('Accessing microphone...');
      this.micSource = await getMicrophoneTrack();
      this.livekitMicTrack = this.micSource.clone();
      this.livekitMicPublication = await this.config.room.localParticipant.publishTrack(
        this.livekitMicTrack,
        { source: Track.Source.Microphone }
      );

      // Configure the avatar before OpenAI starts answering so no output is lost
      this.config.onStatusChange?.('Connecting to Stream API...');
      await this.connectStreamApi();
      if (this.config.mode === 'file') {
        this.sendAudioFile();
      } else {
        this.sendStreamApiConfig();
        await this.waitForStreamApiAck();
        this.config.onStatusChange?.('Connecting to OpenAI...');
        await this.connectOpenAI();
      }
      if (this.closed) throw new Error('Connection was closed');
      this.config.onStatusChange?.('Connected');
    } catch (error) {
      this.close();
      throw error;
    }
  }

  /* ---------- OpenAI Realtime (WebRTC) ---------- */

  private async connectOpenAI(): Promise<void> {
    const ephemeralToken = await this.getOpenAIEphemeralToken();

    this.peerConnection = new RTCPeerConnection();
    this.openaiMicTrack = this.micSource!.clone();
    this.peerConnection.addTrack(this.openaiMicTrack);

    // OpenAI sends its speech as a WebRTC track. Only audio mode forwards it to DigiSelf,
    // and it is never played here because the avatar speaks it.
    this.peerConnection.ontrack = (event) => {
      if (this.config.mode === 'audio') {
        this.forwardRemoteAudio(event.streams[0] ?? new MediaStream([event.track]));
      }
    };

    this.dataChannel = this.peerConnection.createDataChannel('oai-events');
    this.dataChannel.onmessage = (event) => this.handleOpenAIMessage(event);

    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);
    const response = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      body: offer.sdp,
      headers: {
        Authorization: `Bearer ${ephemeralToken}`,
        'Content-Type': 'application/sdp',
      },
    });
    if (!response.ok) {
      throw new Error(`OpenAI WebRTC negotiation failed: ${response.status} ${await response.text()}`);
    }
    await this.peerConnection.setRemoteDescription({ type: 'answer', sdp: await response.text() });
  }

  private async getOpenAIEphemeralToken(): Promise<string> {
    const response = await fetch(`${this.config.backendUrl}/api/openai/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: this.config.mode }),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `Failed to get OpenAI session: ${response.statusText}`);
    }
    const data = await response.json();
    const token = data.value || data.client_secret?.value;
    if (!token) {
      throw new Error('No client secret in OpenAI session response');
    }
    return token;
  }

  private handleOpenAIMessage(event: MessageEvent): void {
    if (this.closed) return;

    let message: Record<string, unknown>;
    try {
      message = JSON.parse(event.data as string);
    } catch {
      return;
    }
    const type = message.type as string;

    // Ignore the rest of responses that already finished or were interrupted
    const response = message.response as { id?: string } | undefined;
    const responseId = typeof message.response_id === 'string' ? message.response_id : response?.id;
    if (type.startsWith('response.') && type !== 'response.created' && responseId !== this.currentResponseId) {
      return;
    }

    switch (type) {
      case 'input_audio_buffer.speech_started':
        // Server VAD cancels the current response when the user starts speaking,
        // so stop forwarding what is left of it.
        if (this.config.interruptSpeech) {
          this.currentResponseId = null;
          this.currentRequestId = null;
        }
        break;

      case 'response.created':
        this.currentResponseId = response?.id ?? null;
        this.requestResponseId = this.currentResponseId;
        this.currentRequestId = `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        break;

      case 'response.output_text.delta': {
        const delta = message.delta as string;
        if (delta && this.config.mode === 'text' && this.currentRequestId) {
          this.sendToStreamApi({
            type: 'text_stream',
            payload: { text: delta, request_id: this.currentRequestId },
          });
        }
        break;
      }

      case 'response.output_text.done':
        console.log('[BrowserDirect] Response:', message.text);
        break;

      case 'response.output_audio_transcript.done':
        console.log('[BrowserDirect] Response:', message.transcript);
        break;

      case 'response.done':
        this.currentResponseId = null;
        // Over WebRTC the answer's audio keeps playing for a while after the response is
        // generated. A new request_id would make DigiSelf drop what it has queued, so audio
        // mode keeps it until output_audio_buffer.stopped or .cleared.
        if (this.config.mode !== 'audio') {
          this.currentRequestId = null;
        }
        break;

      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared':
        if (this.config.mode === 'audio' && responseId === this.requestResponseId) {
          this.currentRequestId = null;
        }
        break;

      case 'error': {
        // Server VAD requests a response whenever the user stops speaking. While an answer
        // is still being generated, OpenAI rejects that request and keeps the answer.
        const error = message.error as { code?: string; message?: string } | undefined;
        if (error?.code === 'conversation_already_has_active_response') break;
        console.error('[BrowserDirect] OpenAI error:', error);
        this.config.onError?.(`OpenAI error: ${error?.message ?? JSON.stringify(error)}`);
        break;
      }
    }
  }

  /**
   * Streams OpenAI's speech to the Stream API as 24kHz PCM16 (audio mode).
   */
  private forwardRemoteAudio(stream: MediaStream): void {
    if (this.audioContext) return;

    // Chrome only feeds remote WebRTC audio into Web Audio while a media element plays it
    this.remoteAudioElement = new Audio();
    this.remoteAudioElement.muted = true;
    this.remoteAudioElement.srcObject = stream;
    void this.remoteAudioElement.play().catch(() => {});

    this.audioContext = new AudioContext({ sampleRate: 24000 });
    const source = this.audioContext.createMediaStreamSource(stream);
    this.audioProcessor = this.audioContext.createScriptProcessor(4096, 1, 1);
    this.audioProcessor.onaudioprocess = (event) => {
      if (!this.streamApiConfigAcked) return;
      if (!this.currentRequestId) {
        this.currentRequestId = `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      }
      this.sendToStreamApi({
        type: 'audio_stream',
        payload: {
          audio_data: float32ToPcm16Base64(event.inputBuffer.getChannelData(0)),
          request_id: this.currentRequestId,
        },
      });
    };
    source.connect(this.audioProcessor);
    // The processor only runs while connected to the destination; it outputs silence
    this.audioProcessor.connect(this.audioContext.destination);
  }

  /* ---------- DigiSelf Stream API ---------- */

  private connectStreamApi(): Promise<void> {
    return new Promise((resolve, reject) => {
      const { streamApiUrl, roomName, streamApiToken } = this.config;
      const url = `${streamApiUrl}/api/rooms/${encodeURIComponent(roomName)}/speak?token=${encodeURIComponent(streamApiToken)}`;
      let opened = false;

      this.streamApiWs = new WebSocket(url);
      this.streamApiWs.onopen = () => {
        opened = true;
        resolve();
      };
      this.streamApiWs.onmessage = (event) => this.handleStreamApiMessage(event);
      this.streamApiWs.onerror = () => {
        if (!opened) reject(new Error('Stream API WebSocket connection failed'));
      };
      this.streamApiWs.onclose = () => {
        if (opened && !this.closed) this.config.onError?.('Stream API connection closed');
      };
    });
  }

  private sendStreamApiConfig(): void {
    if (this.config.mode === 'text') {
      this.sendToStreamApi({
        type: 'config',
        payload: { config_type: 'text_stream', config: { voice_id: this.config.voiceId || '' } },
      });
    } else {
      this.sendToStreamApi({
        type: 'config',
        payload: {
          config_type: 'audio_stream',
          config: { format: 'audio/pcm', channels: 1, sample_rate: 24000, encoding: 'linear16' },
        },
      });
    }
  }

  private sendAudioFile(): void {
    if (!this.config.audioFileUrl) {
      throw new Error('Audio File URL is required for file mode');
    }
    this.sendToStreamApi({ type: 'audio_file', payload: { url: this.config.audioFileUrl } });
  }

  private waitForStreamApiAck(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        clearInterval(check);
        reject(new Error('Stream API config ack timeout'));
      }, 10000);
      const check = setInterval(() => {
        if (this.streamApiConfigAcked) {
          clearInterval(check);
          clearTimeout(timeout);
          resolve();
        }
      }, 50);
    });
  }

  private handleStreamApiMessage(event: MessageEvent): void {
    let message: { type?: string; payload?: { config_type?: string } };
    try {
      message = JSON.parse(event.data as string);
    } catch {
      return;
    }
    const expected = this.config.mode === 'text' ? 'text_stream' : 'audio_stream';
    if (message.type === 'ack' && message.payload?.config_type === expected) {
      this.streamApiConfigAcked = true;
    } else if (message.type === 'error') {
      console.error('[BrowserDirect] Stream API error:', message);
    }
  }

  private sendToStreamApi(message: object): void {
    if (this.streamApiWs?.readyState === WebSocket.OPEN) {
      this.streamApiWs.send(JSON.stringify(message));
    }
  }

  /* ---------- Controls ---------- */

  /**
   * Mutes or unmutes the microphone for both OpenAI and LiveKit.
   */
  async setMicEnabled(enabled: boolean): Promise<void> {
    if (this.openaiMicTrack) this.openaiMicTrack.enabled = enabled;
    if (enabled) {
      await this.livekitMicPublication?.unmute();
    } else {
      await this.livekitMicPublication?.mute();
    }
  }

  /**
   * Releases the microphone, OpenAI and Stream API connections. Safe to call more than once.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;

    this.audioProcessor?.disconnect();
    this.audioContext?.close().catch(() => {});
    if (this.remoteAudioElement) this.remoteAudioElement.srcObject = null;

    this.dataChannel?.close();
    this.peerConnection?.close();
    this.streamApiWs?.close();

    if (this.livekitMicTrack && this.config.room.state === ConnectionState.Connected) {
      this.config.room.localParticipant.unpublishTrack(this.livekitMicTrack).catch(() => {});
    }
    for (const track of [this.openaiMicTrack, this.livekitMicTrack, this.micSource]) {
      track?.stop();
    }
  }
}

async function getMicrophoneTrack(): Promise<MediaStreamTrack> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    return stream.getAudioTracks()[0];
  } catch (error) {
    const name = error instanceof DOMException ? error.name : '';
    if (name === 'NotAllowedError') throw new Error('Microphone access was not allowed.');
    if (name === 'NotFoundError') throw new Error('Microphone device not found.');
    if (name === 'NotReadableError') throw new Error('Microphone is being used by another application.');
    throw new Error('Failed to access microphone.');
  }
}

function float32ToPcm16Base64(samples: Float32Array): string {
  const pcm16 = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = new Uint8Array(pcm16.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
