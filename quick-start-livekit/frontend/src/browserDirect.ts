import { localStreamManager } from './localStream';

export interface BrowserDirectConfig {
  roomName: string;
  streamApiToken: string;
  streamApiUrl: string;
  backendUrl: string;
  onStatusChange?: (status: string) => void;
  onError?: (error: string) => void;
}

export class BrowserDirectConnection {
  private config: BrowserDirectConfig;
  private peerConnection: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private micTrack: MediaStreamTrack | null = null;
  private streamApiWs: WebSocket | null = null;
  private currentRequestId: string | null = null;
  private streamApiConfigAcked = false;
  private closed = false;

  constructor(config: BrowserDirectConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    // Step 1: Get OpenAI ephemeral token
    this.config.onStatusChange?.('Getting OpenAI token...');
    const ephemeralToken = await this.getOpenAIEphemeralToken();
    console.log('[BrowserDirect] OpenAI ephemeral token obtained');

    // Step 2: Get microphone stream
    this.config.onStatusChange?.('Accessing microphone...');
    const localStream = await localStreamManager.getStream();
    const audioTrack = localStream.getAudioTracks()[0];
    if (!audioTrack) {
      throw new Error('No microphone track available');
    }
    this.micTrack = audioTrack.clone();
    console.log('[BrowserDirect] Microphone stream obtained');

    // Step 3: Create PeerConnection and add mic track
    this.config.onStatusChange?.('Connecting to OpenAI...');
    this.peerConnection = new RTCPeerConnection();
    this.peerConnection.addTrack(this.micTrack, localStream);

    // Step 4: Set up data channel for events
    this.dataChannel = this.peerConnection.createDataChannel('oai-events');
    this.dataChannel.onmessage = (event) => this.handleOpenAIMessage(event);

    // Step 5: SDP negotiation
    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);

    const answerSdp = await this.negotiateSDP(offer.sdp!, ephemeralToken);
    await this.peerConnection.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    console.log('[BrowserDirect] WebRTC connection established');

    // Step 6: Connect to Stream API
    this.config.onStatusChange?.('Connecting to Stream API...');
    await this.connectStreamApi();
    console.log('[BrowserDirect] Stream API connected');

    // Step 7: Send config to Stream API (text mode)
    this.sendStreamApiConfig();

    // Step 8: Wait for config ack
    this.config.onStatusChange?.('Waiting for config ack...');
    await this.waitForStreamApiAck();
    console.log('[BrowserDirect] Stream API config acknowledged');

    this.config.onStatusChange?.('Connection complete');
  }

  private async getOpenAIEphemeralToken(): Promise<string> {
    const response = await fetch(`${this.config.backendUrl}/api/openai/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`Failed to get OpenAI session: ${response.statusText}`);
    }

    const data = await response.json();
    const token = data.value || data.client_secret?.value;
    if (!token) {
      throw new Error('No client_secret in OpenAI session response');
    }
    return token;
  }

  private async negotiateSDP(offerSdp: string, ephemeralToken: string): Promise<string> {
    const response = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      body: offerSdp,
      headers: {
        Authorization: `Bearer ${ephemeralToken}`,
        'Content-Type': 'application/sdp',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`SDP negotiation failed: ${response.status} ${errorText}`);
    }

    return response.text();
  }

  private connectStreamApi(): Promise<void> {
    return new Promise((resolve, reject) => {
      const { streamApiUrl, roomName, streamApiToken } = this.config;
      const url = `${streamApiUrl}/api/rooms/${encodeURIComponent(roomName)}/speak?token=${encodeURIComponent(streamApiToken)}`;

      this.streamApiWs = new WebSocket(url);

      this.streamApiWs.onopen = () => {
        console.log('[BrowserDirect] Stream API WebSocket connected');
        resolve();
      };

      this.streamApiWs.onmessage = (event) => {
        this.handleStreamApiMessage(event);
      };

      this.streamApiWs.onerror = (event) => {
        console.error('[BrowserDirect] Stream API WebSocket error:', event);
        this.config.onError?.('Stream API WebSocket error');
        reject(new Error('Stream API WebSocket connection failed'));
      };

      this.streamApiWs.onclose = () => {
        console.log('[BrowserDirect] Stream API WebSocket closed');
      };
    });
  }

  private sendStreamApiConfig(): void {
    this.streamApiWs!.send(JSON.stringify({
      type: 'config',
      payload: {
        config_type: 'text_stream',
        config: {},
      },
    }));
    console.log('[BrowserDirect] Sent text_stream config');
  }

  private waitForStreamApiAck(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.streamApiConfigAcked) {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('Stream API config ack timeout'));
      }, 10000);

      const checkAck = setInterval(() => {
        if (this.streamApiConfigAcked) {
          clearInterval(checkAck);
          clearTimeout(timeout);
          resolve();
        }
      }, 100);
    });
  }

  private handleOpenAIMessage(event: MessageEvent): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(event.data as string);
    } catch {
      console.error('[BrowserDirect] Failed to parse OpenAI message');
      return;
    }

    const type = message.type as string;

    switch (type) {
      case 'session.created':
        console.log('[BrowserDirect] OpenAI session created');
        break;

      case 'session.updated':
        console.log('[BrowserDirect] OpenAI session updated');
        break;

      case 'input_audio_buffer.speech_started':
        console.log('[BrowserDirect] Speech started');
        break;

      case 'input_audio_buffer.speech_stopped':
        console.log('[BrowserDirect] Speech stopped');
        break;

      case 'response.created':
        this.currentRequestId = `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        console.log('[BrowserDirect] Response created, request_id:', this.currentRequestId);
        break;

      case 'response.output_audio_transcript.delta': {
        // Forward text to Stream API (text mode only)
        if (this.streamApiConfigAcked) {
          const delta = message.delta as string;
          if (delta && this.streamApiWs?.readyState === WebSocket.OPEN) {
            if (!this.currentRequestId) {
              this.currentRequestId = `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
            }
            this.streamApiWs.send(JSON.stringify({
              type: 'text_stream',
              payload: {
                text: delta,
                request_id: this.currentRequestId,
              },
            }));
          }
        }
        break;
      }

      case 'response.output_audio_transcript.done':
        console.log('[BrowserDirect] Text response completed');
        break;

      case 'response.done':
        console.log('[BrowserDirect] Response completed');
        this.currentRequestId = null;
        break;

      case 'error':
        console.error('[BrowserDirect] OpenAI error:', message.error);
        this.config.onError?.(`OpenAI error: ${JSON.stringify(message.error)}`);
        break;
    }
  }

  private handleStreamApiMessage(event: MessageEvent): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(event.data as string);
    } catch {
      console.log('[BrowserDirect] Stream API raw message:', event.data);
      return;
    }

    console.log('[BrowserDirect] Stream API message:', message);

    if (message.type === 'ack') {
      const payload = message.payload as Record<string, unknown>;
      if (payload && payload.config_type === 'text_stream') {
        this.streamApiConfigAcked = true;
        console.log('[BrowserDirect] Stream API text_stream config acknowledged');
      }
    }
  }

  /**
   * Enable or disable the microphone track sent to OpenAI.
   */
  setMicEnabled(enabled: boolean): void {
    if (this.micTrack) {
      this.micTrack.enabled = enabled;
      console.log(`[BrowserDirect] Mic track ${enabled ? 'enabled' : 'disabled'}`);
    }
  }

  close(): void {
    this.closed = true;

    // Stop mic track
    if (this.micTrack) {
      this.micTrack.stop();
      this.micTrack = null;
    }
    localStreamManager.stopMic();

    // Close PeerConnection
    if (this.dataChannel) {
      this.dataChannel.close();
      this.dataChannel = null;
    }
    if (this.peerConnection) {
      this.peerConnection.getSenders().forEach((sender) => sender.track?.stop());
      this.peerConnection.close();
      this.peerConnection = null;
    }

    // Close Stream API WebSocket
    if (this.streamApiWs) {
      this.streamApiWs.close();
      this.streamApiWs = null;
    }

    console.log('[BrowserDirect] All connections closed');
  }
}
