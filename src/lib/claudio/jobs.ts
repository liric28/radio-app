import {
  dequeueClaudioJob,
  failClaudioJob,
  finishClaudioJob,
  getClaudioStationState,
  subscribeClaudioEvents,
} from "@/lib/claudio/station-runtime";
import {
  runClaudioBridgeGenerationJob,
  runClaudioMusicRefillJob,
  runClaudioProgramStartJob,
} from "@/lib/claudio/program-adapter";
import type { ClaudioJob } from "@/lib/claudio/types";

/**
 * Claudio 的 job worker 先单线程跑，保持和原项目一致：
 * - program_start / music_refill / bridge_generation 都串行
 * - 避免同时打爆本地 LLM / TTS / 音乐源
 *
 * 当前阶段先把 worker 骨架接起来，具体 job 处理函数后续逐个迁入。
 */
type DrainClaudioJobsOptions = {
  stopAfterKey?: string;
  timeoutMs?: number;
};

export async function drainClaudioJobs(options: DrainClaudioJobsOptions = {}) {
  const state = getClaudioStationState();
  if (state.workerRunning) {
    if (!options.stopAfterKey) return false;
    const status = await waitForClaudioJob(options.stopAfterKey, options.timeoutMs);
    return status === "completed";
  }

  state.workerRunning = true;
  try {
    while (true) {
      const job = dequeueClaudioJob();
      if (!job) break;
      const shouldStopAfterJob = job.key === options.stopAfterKey;
      try {
        await runClaudioJob(job);
        finishClaudioJob(job);
      } catch (error) {
        failClaudioJob(job, error instanceof Error ? error.message : String(error));
      }
      if (shouldStopAfterJob) return true;
    }
    return false;
  } finally {
    state.workerRunning = false;
  }
}

function waitForClaudioJob(key: string, timeoutMs = 180_000) {
  const state = getClaudioStationState();
  const existing = state.history.findLast(
    (event) => event.type === "job-status" && event.key === key &&
      (event.status === "completed" || event.status === "failed"),
  );
  if (existing?.type === "job-status") return Promise.resolve(existing.status);

  return new Promise<"completed" | "failed" | "timeout">((resolve) => {
    const timeoutId = setTimeout(() => {
      unsubscribe();
      resolve("timeout");
    }, timeoutMs);
    const unsubscribe = subscribeClaudioEvents((event) => {
      if (event.type !== "job-status" || event.key !== key) return;
      if (event.status !== "completed" && event.status !== "failed") return;
      clearTimeout(timeoutId);
      unsubscribe();
      resolve(event.status);
    });
  });
}

async function runClaudioJob(job: ClaudioJob) {
  if (job.type === "program_start") {
    return runClaudioProgramStartJob(job);
  }
  if (job.type === "music_refill") {
    return runClaudioMusicRefillJob(job);
  }
  if (job.type === "bridge_generation") {
    return runClaudioBridgeGenerationJob(job);
  }
}
