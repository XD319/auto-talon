import React from "react";

import type { RuntimeOutputEvent } from "../../types/index.js";
import { TranscriptViewer } from "../components/transcript-viewer.js";

export function TranscriptPanel({ events }: { events: RuntimeOutputEvent[] }): React.ReactElement {
  return <TranscriptViewer events={events} mode="detail" title="Output Transcript" />;
}
