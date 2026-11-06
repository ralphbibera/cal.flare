import type { PrismaClient } from "@calcom/prisma";
import { prisma } from "@calcom/prisma";
import { Prisma } from "@calcom/prisma/client";
import type { TaskTypes } from "./tasker";

const whereSucceeded: Prisma.TaskWhereInput = {
  succeededAt: { not: null },
};

const whereMaxAttemptsReached: Prisma.TaskWhereInput = {
  attempts: {
    equals: {
      // @ts-expect-error prisma is tripping: '_ref' does not exist in type 'FieldRef<"Task", "Int">'
      _ref: "maxAttempts",
      _container: "Task",
    },
  },
};

/** This is a function to ensure new Date is always fresh */
const makeWhereUpcomingTasks = (): Prisma.TaskWhereInput => ({
  // Get only tasks that have not succeeded yet
  succeededAt: null,
  // Get only tasks that are scheduled to run now or in the past
  scheduledAt: {
    lt: new Date(),
  },
  // Get only tasks where maxAttemps has not been reached
  attempts: {
    lt: {
      // @ts-expect-error prisma is tripping: '_ref' does not exist in type 'FieldRef<"Task", "Int">'
      _ref: "maxAttempts",
      _container: "Task",
    },
  },
});

type Dependencies = {
  prismaClient: PrismaClient;
};

export class TaskRepository {
  constructor(private readonly deps: Dependencies) {}

  async create(
    type: string,
    payload: string,
    options: { scheduledAt?: Date; maxAttempts?: number; referenceUid?: string } = {}
  ) {
    const { scheduledAt, maxAttempts, referenceUid } = options;
    console.info("Creating task", { type, payload, scheduledAt, maxAttempts });
    const newTask = await this.deps.prismaClient.task.create({
      data: {
        payload,
        type,
        scheduledAt,
        maxAttempts,
        referenceUid,
      },
    });
    return newTask.id;
  }

  async getNextBatch(types: string[]) {
    console.info("Getting next batch of tasks", makeWhereUpcomingTasks());
    return this.deps.prismaClient.task.findMany({
      where: { ...makeWhereUpcomingTasks(), type: { in: types } },
      orderBy: {
        scheduledAt: "asc",
      },
      take: 1000,
    });
  }

  async getFailed() {
    return this.deps.prismaClient.task.findMany({
      where: whereMaxAttemptsReached,
    });
  }

  async getSucceeded() {
    return this.deps.prismaClient.task.findMany({
      where: whereSucceeded,
    });
  }

  async count() {
    return this.deps.prismaClient.task.count();
  }

  async countUpcoming() {
    return this.deps.prismaClient.task.count({
      where: makeWhereUpcomingTasks(),
    });
  }

  async countFailed() {
    return this.deps.prismaClient.task.count({
      where: whereMaxAttemptsReached,
    });
  }

  async countSucceeded() {
    return this.deps.prismaClient.task.count({
      where: whereSucceeded,
    });
  }

  async retry({
    taskId,
    lastError,
    minRetryIntervalMins,
  }: {
    taskId: string;
    lastError?: string;
    minRetryIntervalMins?: number | null;
  }) {
    const failedAttemptTime = new Date();
    const updatedScheduledAt = minRetryIntervalMins
      ? new Date(failedAttemptTime.getTime() + 1000 * 60 * minRetryIntervalMins)
      : undefined;

    return this.deps.prismaClient.task.update({
      where: {
        id: taskId,
      },
      data: {
        attempts: { increment: 1 },
        lastError,
        lastFailedAttemptAt: failedAttemptTime,
        ...(updatedScheduledAt && {
          scheduledAt: updatedScheduledAt,
        }),
      },
    });
  }

  async succeed(taskId: string) {
    return this.deps.prismaClient.task.update({
      where: {
        id: taskId,
      },
      data: {
        attempts: { increment: 1 },
        succeededAt: new Date(),
      },
    });
  }

  async findById(id: string) {
    return this.deps.prismaClient.task.findUnique({
      where: { id },
      select: {
        id: true,
        type: true,
        payload: true,
        attempts: true,
        maxAttempts: true,
        scheduledAt: true,
        succeededAt: true,
      },
    });
  }

  async claim({
    id,
    attempts,
    now,
    leaseUntil,
  }: {
    id: string;
    attempts: number;
    now: Date;
    leaseUntil: Date;
  }) {
    const { count } = await this.deps.prismaClient.task.updateMany({
      where: { id, attempts, succeededAt: null, scheduledAt: { lte: now } },
      data: { scheduledAt: leaseUntil },
    });
    return count === 1;
  }

  async succeedAttempt({ id, attempts, now }: { id: string; attempts: number; now: Date }) {
    await this.deps.prismaClient.task.updateMany({
      where: { id, attempts, succeededAt: null },
      data: { attempts: attempts + 1, succeededAt: now },
    });
  }

  async failAttempt({
    id,
    attempts,
    nextAttempts,
    lastError,
    now,
    scheduledAt,
  }: {
    id: string;
    attempts: number;
    nextAttempts: number;
    lastError: string;
    now: Date;
    scheduledAt?: Date;
  }) {
    await this.deps.prismaClient.task.updateMany({
      where: { id, attempts, succeededAt: null },
      data: {
        attempts: nextAttempts,
        lastError,
        lastFailedAttemptAt: now,
        ...(scheduledAt && { scheduledAt }),
      },
    });
  }

  /**
   * Update the payload of a task
   *
   * @param taskId - The ID of the task to update
   * @param newPayload - The new payload string
   */
  async updatePayload(taskId: string, newPayload: string) {
    return this.deps.prismaClient.task.update({
      where: {
        id: taskId,
      },
      data: {
        payload: newPayload,
      },
    });
  }

  async cancel(taskId: string) {
    return this.deps.prismaClient.task.delete({
      where: {
        id: taskId,
      },
    });
  }

  async cancelWithReference(referenceUid: string, type: TaskTypes): Promise<{ id: string } | null> {
    // prismaClient.task.delete throws an error if the task does not exist, so we catch it and return null
    try {
      return await this.deps.prismaClient.task.delete({
        where: {
          referenceUid_type: {
            referenceUid,
            type,
          },
        },
        select: {
          id: true,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
        // P2025 is the error code for "Record to delete does not exist"
        console.warn(`Task with reference ${referenceUid} and type ${type} does not exist. No action taken.`);
        return null;
      }
      throw error;
    }
  }

  async cleanup() {
    // TODO: Uncomment this later
    // return this.deps.prismaClient.task.deleteMany({
    //   where: {
    //     OR: [
    //       // Get tasks that have succeeded
    //       whereSucceeded,
    //       // Get tasks where maxAttemps has been reached
    //       whereMaxAttemptsReached,
    //     ],
    //   },
    // });
  }
}

// Export singleton instance for backward compatibility
// This allows existing code using Task.create(), Task.succeed(), etc. to continue working
export const Task = new TaskRepository({ prismaClient: prisma });
