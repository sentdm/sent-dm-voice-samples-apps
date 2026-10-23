import { formatTime } from "@/lib/client/format";
import type { VoiceRecordingResponse } from "@/lib/shared/types";

/** The download links `GET /v3/voice/calls/{id}/recordings` issued, oldest first. */
export function RecordingLinks({
  recordings,
}: {
  recordings: VoiceRecordingResponse[];
}) {
  return (
    <ol className="list-decimal pl-5 text-xs">
      {recordings.map((recording, index) => (
        <li key={recording.recording_id}>
          <a
            href={recording.download_url}
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            Recording {index + 1}
          </a>
          <span className="text-muted-foreground">
            {" "}
            {recording.recording_id}, link valid until{" "}
            {formatTime(recording.url_expires_at)}
          </span>
        </li>
      ))}
    </ol>
  );
}
