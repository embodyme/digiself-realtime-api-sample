export const LocalStreamErrorType = {
  NOT_ALLOWED: "NOT_ALLOWED",
  NOT_FOUND: "NOT_FOUND",
  NOT_READABLE: "NOT_READABLE",
  UNKNOWN: "UNKNOWN",
} as const;

export type LocalStreamErrorType = (typeof LocalStreamErrorType)[keyof typeof LocalStreamErrorType];

export class LocalStreamError extends Error {
  readonly type: LocalStreamErrorType;
  readonly originalError: unknown;

  constructor(type: LocalStreamErrorType, originalError: unknown, message: string) {
    super(message);
    this.name = "LocalStreamError";
    this.type = type;
    this.originalError = originalError;
  }
}

const ERROR_MESSAGES: Record<LocalStreamErrorType, string> = {
  [LocalStreamErrorType.NOT_ALLOWED]: "Microphone access was not allowed.",
  [LocalStreamErrorType.NOT_FOUND]: "Microphone device not found.",
  [LocalStreamErrorType.NOT_READABLE]: "Microphone is being used by another application.",
  [LocalStreamErrorType.UNKNOWN]: "Failed to access microphone.",
};

const mapDOMExceptionToErrorType = (error: unknown): LocalStreamErrorType => {
  const name =
    error instanceof DOMException
      ? error.name
      : typeof error === "object" && error !== null && "name" in error
        ? String((error as { name?: unknown }).name)
        : null;

  switch (name) {
    case "NotAllowedError":
      return LocalStreamErrorType.NOT_ALLOWED;
    case "NotFoundError":
      return LocalStreamErrorType.NOT_FOUND;
    case "NotReadableError":
    case "AbortError":
      return LocalStreamErrorType.NOT_READABLE;
    default:
      return LocalStreamErrorType.UNKNOWN;
  }
};

export interface LocalStreamManager {
  getStream: () => Promise<MediaStream>;
  stopMic: () => void;
  muteMic: () => void;
  unmuteMic: () => void;
  isMuted: () => boolean;
  getError: () => string | null;
}

const createLocalStreamManager = (): LocalStreamManager => {
  let localStream: MediaStream | null = null;
  let error: string | null = null;
  let pending: Promise<MediaStream> | null = null;

  const startMic = async (): Promise<MediaStream> => {
    try {
      error = null;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStream = stream;
      return stream;
    } catch (e: unknown) {
      const errorType = mapDOMExceptionToErrorType(e);
      const errorMessage = ERROR_MESSAGES[errorType];
      error = errorMessage;
      throw new LocalStreamError(errorType, e, errorMessage);
    }
  };

  const getStream = async (): Promise<MediaStream> => {
    const hasLiveAudio =
      localStream?.getAudioTracks().some((track) => track.readyState === "live") ?? false;

    if (hasLiveAudio) return localStream!;

    if (!pending) {
      pending = startMic().finally(() => {
        pending = null;
      });
    }

    return pending;
  };

  const stopMic = (): void => {
    localStream?.getTracks().forEach((track) => track.stop());
    localStream = null;
  };

  const muteMic = (): void => {
    localStream?.getAudioTracks().forEach((track) => {
      track.enabled = false;
    });
  };

  const unmuteMic = (): void => {
    localStream?.getAudioTracks().forEach((track) => {
      track.enabled = true;
    });
  };

  const isMuted = (): boolean => {
    const track = localStream?.getAudioTracks()[0];
    if (!track) return true;
    return !track.enabled;
  };

  const getError = (): string | null => error;

  return {
    getStream,
    stopMic,
    muteMic,
    unmuteMic,
    isMuted,
    getError,
  };
};

export const localStreamManager = createLocalStreamManager();
