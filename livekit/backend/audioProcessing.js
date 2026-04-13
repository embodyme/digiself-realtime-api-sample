/**
 * Audio processing module.
 * Contains functions for resampling audio between different sample rates.
 */

/**
 * Downsamples audio from 48kHz to 24kHz using weighted averaging.
 * Used for preparing audio input for OpenAI Realtime API.
 *
 * @param {Buffer} input - PCM16 audio buffer at 48kHz sample rate
 * @returns {Buffer} PCM16 audio buffer at 24kHz sample rate
 */
export function downsampleAudio48to24(input) {
  const x = new Int16Array(input.buffer, input.byteOffset, input.byteLength / 2);
  const N = x.length;
  const outLen = Math.floor(N / 2);
  const y = new Int16Array(outLen);

  let m = 0;
  for (let n = 2; m < outLen && n + 2 < N; n += 2, m++) {
    // Weighted average: 25% previous, 50% current, 25% next sample
    const acc = 0.25 * x[n - 2] + 0.5 * x[n] + 0.25 * x[n + 2];
    let s = Math.round(acc);
    // Clamp to 16-bit signed integer range
    if (s > 32767) s = 32767;
    else if (s < -32768) s = -32768;
    y[m] = s;
  }
  // Fill remaining samples with the last input sample
  while (m < outLen) y[m++] = x[N - 1];

  return Buffer.from(y.buffer, y.byteOffset, y.byteLength);
}

/**
 * Downsamples audio from 48kHz to 16kHz with IIR low-pass filter.
 * Used for preparing audio for APIs that require 16kHz input.
 *
 * The low-pass filter prevents aliasing by attenuating frequencies
 * above the Nyquist frequency of the target sample rate.
 *
 * @param {Buffer} inputBuf - PCM16 audio buffer at 48kHz sample rate
 * @returns {Buffer} PCM16 audio buffer at 16kHz sample rate
 */
export function downsample48kTo16kPCM16(inputBuf) {
  const inSamples = new Int16Array(
    inputBuf.buffer,
    inputBuf.byteOffset,
    Math.floor(inputBuf.byteLength / 2)
  );
  const N = inSamples.length;
  if (N === 0) return Buffer.alloc(0);

  // 1st order IIR low-pass filter
  // Cutoff frequency ~7kHz to preserve speech frequencies below 8kHz
  const fs = 48000;  // Input sample rate
  const fc = 7000;   // Cutoff frequency in Hz
  const dt = 1 / fs;
  const RC = 1 / (2 * Math.PI * fc);
  const alpha = dt / (RC + dt);  // Filter coefficient (0 < alpha < 1)

  // Apply filter in float and normalize to [-1, 1] range
  const filtered = new Float32Array(N);
  let y = 0;
  for (let i = 0; i < N; i++) {
    const x = inSamples[i] / 32768;  // Normalize to [-1, 1]
    y = y + alpha * (x - y);         // IIR filter: y[n] = y[n-1] + α(x - y[n-1])
    filtered[i] = y;
  }

  // Decimate by factor of 3 (48kHz / 3 = 16kHz)
  const outLen = Math.floor(N / 3);
  const out = new Int16Array(outLen);
  for (let m = 0; m < outLen; m++) {
    const v = filtered[m * 3];  // Take every 3rd sample
    // Convert back to Int16 with clamping
    let s = Math.round(v * 32767);
    if (s > 32767) s = 32767;
    else if (s < -32768) s = -32768;
    out[m] = s;
  }

  return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}

/**
 * Upsamples audio from 24kHz to 32kHz using linear interpolation.
 * Used for converting OpenAI Realtime API output to higher sample rates.
 *
 * @param {Buffer} input - PCM16 audio buffer at 24kHz sample rate
 * @returns {Buffer} PCM16 audio buffer at 32kHz sample rate
 */
export function resampleAudio24to32(input) {
  const x = new Int16Array(input.buffer, input.byteOffset, input.byteLength / 2);
  const N = x.length;

  // Calculate output length based on ratio: 24000 / 32000 = 0.75
  const outLen = Math.floor(N * 32000 / 24000);
  const y = new Int16Array(outLen);

  for (let m = 0; m < outLen; m++) {
    // Calculate the corresponding input sample position
    const inputPos = m * 24000 / 32000;
    const index = Math.floor(inputPos);
    const fraction = inputPos - index;

    if (index + 1 < N) {
      // Linear interpolation between adjacent samples
      const sample1 = x[index];
      const sample2 = x[index + 1];
      const interpolated = sample1 + fraction * (sample2 - sample1);
      let s = Math.round(interpolated);
      // Clamp to 16-bit signed integer range
      if (s > 32767) s = 32767;
      else if (s < -32768) s = -32768;
      y[m] = s;
    } else if (index < N) {
      y[m] = x[index];
    } else {
      // Use last sample for padding
      y[m] = x[N - 1];
    }
  }

  return Buffer.from(y.buffer, y.byteOffset, y.byteLength);
}
