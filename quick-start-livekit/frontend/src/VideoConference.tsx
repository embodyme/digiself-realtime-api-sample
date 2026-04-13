import {
  GridLayout,
  ParticipantTile,
  useLocalParticipant,
  useTracks,
} from '@livekit/components-react';
import { Track } from 'livekit-client';

export function VideoConference({ excludeSelf = false }: { excludeSelf?: boolean }) {
  const { localParticipant } = useLocalParticipant();
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );

  // Filter out tracks from LiveKit Agents and own tracks.
  const filteredTracks = tracks.filter(
    (track) =>
      !track.participant.identity.startsWith('agent') &&
      (!excludeSelf || track.participant.identity !== localParticipant.identity)
  );

  return (
    <GridLayout tracks={filteredTracks} style={{ height: 'calc(100vh - var(--lk-control-bar-height))' }}>
      <ParticipantTile />
    </GridLayout>
  );
}
