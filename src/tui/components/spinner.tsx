import React from "react";
import { Text } from "ink";

function SpinnerBase({ active }: { active: boolean }): React.ReactElement | null {
  if (!active) {
    return null;
  }

  return <Text color="yellow">thinking...</Text>;
}

export const Spinner = React.memo(SpinnerBase);
