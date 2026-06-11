import { z } from "zod";

export const statusLineStyleSchema = z.enum(["minimal", "standard", "detailed", "hidden"]);
export const statusLineTypeSchema = z.enum(["builtin", "command"]);

export const statusLineConfigSchema = z.object({
  command: z.string().min(1).nullable().optional(),
  padding: z.number().int().nonnegative().optional(),
  showBranch: z.boolean().optional(),
  showCost: z.boolean().optional(),
  showMode: z.boolean().optional(),
  showModel: z.boolean().optional(),
  showTokens: z.boolean().optional(),
  style: statusLineStyleSchema.optional(),
  timeoutMs: z.number().int().positive().optional(),
  type: statusLineTypeSchema.optional(),
  updateIntervalMs: z.number().int().positive().optional()
});

export type StatusLineStyle = z.infer<typeof statusLineStyleSchema>;
export type StatusLineType = z.infer<typeof statusLineTypeSchema>;
export type StatusLineConfigInput = z.infer<typeof statusLineConfigSchema>;

export interface TuiStatusLineConfig {
  command: string | null;
  padding: number;
  showBranch: boolean;
  showCost: boolean;
  showMode: boolean;
  showModel: boolean;
  showTokens: boolean;
  style: StatusLineStyle;
  timeoutMs: number;
  type: StatusLineType;
  updateIntervalMs: number;
}

export interface ResolvedStatusLineFields {
  showBranch: boolean;
  showCost: boolean;
  showMode: boolean;
  showModel: boolean;
  showTokens: boolean;
}

const STYLE_PRESETS: Record<StatusLineStyle, ResolvedStatusLineFields> = {
  detailed: {
    showBranch: true,
    showCost: true,
    showMode: true,
    showModel: true,
    showTokens: true
  },
  hidden: {
    showBranch: false,
    showCost: false,
    showMode: false,
    showModel: false,
    showTokens: false
  },
  minimal: {
    showBranch: false,
    showCost: false,
    showMode: false,
    showModel: true,
    showTokens: false
  },
  standard: {
    showBranch: true,
    showCost: false,
    showMode: true,
    showModel: true,
    showTokens: true
  }
};

export const DEFAULT_TUI_STATUS_LINE_CONFIG: TuiStatusLineConfig = {
  command: null,
  padding: 0,
  showBranch: true,
  showCost: false,
  showMode: true,
  showModel: true,
  showTokens: true,
  style: "standard",
  timeoutMs: 2_000,
  type: "builtin",
  updateIntervalMs: 300
};

export function resolveTuiStatusLineConfig(
  file?: StatusLineConfigInput | null,
  env?: StatusLineConfigInput | null
): TuiStatusLineConfig {
  const style = env?.style ?? file?.style ?? DEFAULT_TUI_STATUS_LINE_CONFIG.style;
  const preset = STYLE_PRESETS[style];

  return {
    command: env?.command ?? file?.command ?? DEFAULT_TUI_STATUS_LINE_CONFIG.command,
    padding: env?.padding ?? file?.padding ?? DEFAULT_TUI_STATUS_LINE_CONFIG.padding,
    showBranch: env?.showBranch ?? file?.showBranch ?? preset.showBranch,
    showCost: env?.showCost ?? file?.showCost ?? preset.showCost,
    showMode: env?.showMode ?? file?.showMode ?? preset.showMode,
    showModel: env?.showModel ?? file?.showModel ?? preset.showModel,
    showTokens: env?.showTokens ?? file?.showTokens ?? preset.showTokens,
    style,
    timeoutMs: env?.timeoutMs ?? file?.timeoutMs ?? DEFAULT_TUI_STATUS_LINE_CONFIG.timeoutMs,
    type: env?.type ?? file?.type ?? DEFAULT_TUI_STATUS_LINE_CONFIG.type,
    updateIntervalMs: Math.max(
      300,
      env?.updateIntervalMs ?? file?.updateIntervalMs ?? DEFAULT_TUI_STATUS_LINE_CONFIG.updateIntervalMs
    )
  };
}

export function resolveStatusLineFields(config: TuiStatusLineConfig): ResolvedStatusLineFields {
  return {
    showBranch: config.showBranch,
    showCost: config.showCost,
    showMode: config.showMode,
    showModel: config.showModel,
    showTokens: config.showTokens
  };
}
