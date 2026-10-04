/**
 * Minimal OpenAI Realtime API client over WebSocket.
 * Sends the session configuration on connect and passes server events to a callback.
 */

import WebSocket from 'ws';

/** Base URL for the OpenAI Realtime API WebSocket connection */
const openaiRealtimeUrlBase = 'wss://api.openai.com/v1/realtime';

/** Time to wait for OpenAI to acknowledge the session configuration */
const setupTimeoutMs = 15_000;

export class OpenAIRealtimeSession {
  /**
   * @param {object} options
   * @param {string} options.apiKey - OpenAI API key
   * @param {object} options.session - Session configuration sent with session.update
   * @param {(event: object) => void} options.onEvent - Called for each server event once the session is configured
   * @param {(error: Error) => void} [options.onError] - Called when the connection fails after setup
   */
  constructor({ apiKey, session, onEvent, onError = () => {} }) {
    this.apiKey = apiKey;
    this.session = session;
    this.onEvent = onEvent;
    this.onError = onError;
    this.ws = null;
    this.ready = false;
    this.closed = false;
  }

  /**
   * Opens the WebSocket and resolves once OpenAI acknowledges the session configuration.
   *
   * @returns {Promise<void>}
   */
  connect() {
    return new Promise((resolve, reject) => {
      const url = `${openaiRealtimeUrlBase}?model=${encodeURIComponent(this.session.model)}`;
      this.ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${this.apiKey}` }
      });

      const fail = (error) => {
        clearTimeout(setupTimer);
        if (this.closed) return;
        if (this.ready) {
          this.onError(error);
        } else {
          reject(error);
        }
        this.close();
      };
      const setupTimer = setTimeout(() => fail(new Error('OpenAI session setup timed out')), setupTimeoutMs);

      this.ws.on('open', () => {
        this.send({ type: 'session.update', session: this.session });
      });

      this.ws.on('message', (data) => {
        let event;
        try {
          event = JSON.parse(data.toString());
        } catch {
          return;
        }

        if (event.type === 'error') {
          // Server VAD requests a response whenever the user stops speaking. While an
          // answer is still being generated, OpenAI rejects that request and keeps the answer.
          if (event.error?.code === 'conversation_already_has_active_response') return;
          if (!this.ready) {
            fail(new Error(event.error?.message || 'OpenAI session error'));
            return;
          }
          console.error('[OpenAI Realtime] Error:', event.error);
          return;
        }

        if (event.type === 'session.updated' && !this.ready) {
          this.ready = true;
          clearTimeout(setupTimer);
          resolve();
        }

        if (this.ready) {
          this.onEvent(event);
        }
      });

      this.ws.on('error', (error) => fail(error));

      this.ws.on('close', () => fail(new Error('OpenAI connection closed')));
    });
  }

  /**
   * Appends PCM16 audio (24kHz mono) to the input audio buffer.
   *
   * @param {Buffer | ArrayBuffer | Uint8Array} audio - PCM16 audio chunk
   */
  sendAudio(audio) {
    if (!this.ready) return;
    this.send({
      type: 'input_audio_buffer.append',
      audio: Buffer.from(audio).toString('base64')
    });
  }

  /**
   * Sends a client event to OpenAI.
   *
   * @param {object} message - Client event
   */
  send(message) {
    if (this.closed || this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(message));
  }

  /**
   * Closes the connection. Safe to call more than once.
   */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.ws?.close();
  }
}
