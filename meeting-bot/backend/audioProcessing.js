/**
 * Audio processing module for meeting bot backend.
 * Contains functions for resampling audio between different sample rates.
 */

/**
 * Upsamples audio from 16kHz to 24kHz using linear interpolation.
 * The meeting bot sends audio at 16kHz, but OpenAI Realtime API requires 24kHz.
 *
 * @param {Buffer} audioBuffer - PCM16 audio buffer at 16kHz sample rate
 * @returns {Buffer} PCM16 audio buffer at 24kHz sample rate
 */
export function upsampleAudio16to24(audioBuffer) {
  const bytesPerSample = 2;  // 16-bit PCM = 2 bytes per sample
  const inputSampleRate = 16000;
  const outputSampleRate = 24000;
  const upsampleFactor = outputSampleRate / inputSampleRate;  // 1.5

  const inputSamples = audioBuffer.length / bytesPerSample;
  const outputSamples = Math.floor(inputSamples * upsampleFactor);
  const outputBuffer = Buffer.alloc(outputSamples * bytesPerSample);

  // Create typed arrays for efficient sample access
  const inputInt16 = new Int16Array(audioBuffer.buffer, audioBuffer.byteOffset, inputSamples);
  const outputInt16 = new Int16Array(outputBuffer.buffer, outputBuffer.byteOffset, outputSamples);

  // Linear interpolation between input samples
  for (let i = 0; i < outputSamples; i++) {
    const inputIndex = i / upsampleFactor;
    const lowerIndex = Math.floor(inputIndex);
    const upperIndex = Math.min(lowerIndex + 1, inputSamples - 1);
    const fraction = inputIndex - lowerIndex;

    if (lowerIndex < inputSamples) {
      const lowerSample = inputInt16[lowerIndex];
      const upperSample = inputInt16[upperIndex];
      // Interpolate between adjacent samples
      outputInt16[i] = Math.round(lowerSample + (upperSample - lowerSample) * fraction);
    }
  }

  return outputBuffer;
}
