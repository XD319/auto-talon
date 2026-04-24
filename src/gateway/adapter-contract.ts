import type { AdapterCapabilityName, InboundMessageAdapter } from "../types/index.js";

export const SUPPORTED_ADAPTER_CONTRACT_VERSION = 1;

const ALL_CAPABILITIES: AdapterCapabilityName[] = [
  "textInteraction",
  "approvalInteraction",
  "fileCapability",
  "attachmentCapability",
  "streamingCapability",
  "structuredCardCapability"
];

export interface AdapterContractViolation {
  code:
    | "capability_missing"
    | "contract_version_invalid"
    | "contract_version_unsupported"
    | "text_interaction_required";
  message: string;
}

export function validateAdapterContract(adapter: InboundMessageAdapter): AdapterContractViolation[] {
  const violations: AdapterContractViolation[] = [];

  if (!Number.isInteger(adapter.descriptor.contractVersion) || adapter.descriptor.contractVersion <= 0) {
    violations.push({
      code: "contract_version_invalid",
      message: `Adapter ${adapter.descriptor.adapterId} must declare a valid positive integer contractVersion.`
    });
  } else if (adapter.descriptor.contractVersion > SUPPORTED_ADAPTER_CONTRACT_VERSION) {
    violations.push({
      code: "contract_version_unsupported",
      message:
        `Adapter ${adapter.descriptor.adapterId} requires contract version ` +
        `${adapter.descriptor.contractVersion}, but this runtime only supports ` +
        `${SUPPORTED_ADAPTER_CONTRACT_VERSION}. Please upgrade auto-talon.`
    });
  }

  for (const capabilityName of ALL_CAPABILITIES) {
    const declared = adapter.descriptor.capabilities[capabilityName];
    if (declared === undefined || typeof declared.supported !== "boolean") {
      violations.push({
        code: "capability_missing",
        message: `Adapter ${adapter.descriptor.adapterId} must declare ${capabilityName} capability explicitly.`
      });
    }
  }

  if (!adapter.descriptor.capabilities.textInteraction.supported) {
    violations.push({
      code: "text_interaction_required",
      message: `Adapter ${adapter.descriptor.adapterId} cannot start without textInteraction support.`
    });
  }

  return violations;
}
