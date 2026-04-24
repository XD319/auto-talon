import type { RecallPlanner } from "../retrieval/index.js";
import type { RecallPlanResult, RecallPlanningInput } from "../retrieval/recall-planner.js";

export interface RetrievalWorkerDependencies {
  recallPlanner: RecallPlanner;
}

export class RetrievalWorker {
  public constructor(private readonly dependencies: RetrievalWorkerDependencies) {}

  public execute(input: RecallPlanningInput): Promise<RecallPlanResult> {
    return Promise.resolve(this.dependencies.recallPlanner.plan(input));
  }
}

