# Architecture

```mermaid
flowchart LR
  CLI[CLIEntry] --> Bootstrap[createApplication]
  Bootstrap --> Kernel[ExecutionKernel]
  Kernel --> Tools[ToolOrchestrator]
  Tools --> Policy[PolicyEngine]
  Kernel --> Trace[TraceService]
  Kernel --> Memory[MemoryPlane]
  Kernel --> Experience[ExperiencePlane]
  Bootstrap --> Storage[SQLiteStorage]
```

Core data path:

1. CLI parses command and resolves app config.
2. Kernel creates task/run metadata.
3. Provider loop executes with policy + tool orchestration.
4. Trace/audit/memory/experience are persisted in SQLite.
