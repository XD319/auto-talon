import React from "react";
import { Text } from "ink";

import { transcriptRoleLabels } from "../message-style.js";
import { sanitizeTerminalText } from "../text-sanitize.js";
import { theme } from "../theme.js";

export function UserMessage({ text }: { text: string }): React.ReactElement {
  const safeText = sanitizeTerminalText(text);
  return (
    <Text color={theme.selection} wrap="wrap">
      {transcriptRoleLabels.input} {safeText}
    </Text>
  );
}
