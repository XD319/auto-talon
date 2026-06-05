import type {
  CreateScheduleInput,
  UpdateScheduleInput
} from "../scheduler/index.js";
import type {
  ScheduleListQuery,
  ScheduleRecord,
  ScheduleRunListQuery,
  ScheduleRunRecord
} from "../../types/index.js";
import type { AgentApplicationServiceDependencies } from "../application-service.js";

export class ScheduleFacade {
  public constructor(private readonly dependencies: AgentApplicationServiceDependencies) {}

  public startScheduler(): void {
    this.dependencies.schedulerService.start();
  }

  public stopScheduler(): void {
    this.dependencies.schedulerService.stop();
  }

  public createSchedule(input: CreateScheduleInput): ScheduleRecord {
    return this.dependencies.schedulerService.createSchedule(input);
  }

  public updateSchedule(scheduleId: string, input: UpdateScheduleInput): ScheduleRecord {
    return this.dependencies.schedulerService.updateSchedule(scheduleId, input);
  }

  public listSchedules(query?: ScheduleListQuery): ScheduleRecord[] {
    return this.dependencies.schedulerService.listSchedules(query);
  }

  public showSchedule(scheduleId: string): ScheduleRecord | null {
    return this.dependencies.schedulerService.showSchedule(scheduleId);
  }

  public listScheduleRuns(scheduleId: string, query?: ScheduleRunListQuery): ScheduleRunRecord[] {
    return this.dependencies.schedulerService.listScheduleRuns(scheduleId, query);
  }

  public scheduleStatus() {
    return this.dependencies.schedulerService.status();
  }

  public async tickScheduleOnce(): Promise<void> {
    await this.dependencies.schedulerService.tickOnce();
  }

  public archiveSchedule(scheduleId: string): ScheduleRecord {
    return this.dependencies.schedulerService.archiveSchedule(scheduleId);
  }

  public pauseSchedule(scheduleId: string): ScheduleRecord {
    return this.dependencies.schedulerService.pauseSchedule(scheduleId);
  }

  public resumeSchedule(scheduleId: string): ScheduleRecord {
    return this.dependencies.schedulerService.resumeSchedule(scheduleId);
  }

  public runScheduleNow(scheduleId: string): ScheduleRunRecord {
    return this.dependencies.schedulerService.runNow(scheduleId);
  }
}
