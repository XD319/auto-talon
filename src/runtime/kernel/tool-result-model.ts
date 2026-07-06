import type { ToolExecutionResult } from "../../types/index.js";

export function toolResultOutputForModel(result: ToolExecutionResult): unknown {
  if (result.success) {
    return result.output;
  }
  return {
    error: result.errorMessage,
    errorCode: result.errorCode,
    recoverable: true,
    ...(result.details === undefined ? {} : { details: result.details })
  };
}
