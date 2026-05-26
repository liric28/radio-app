import {
  dequeueClaudioJob,
  failClaudioJob,
  finishClaudioJob,
  getClaudioStationState,
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
export async function drainClaudioJobs() {
  const state = getClaudioStationState();
  if (state.workerRunning) return;

  state.workerRunning = true;
  try {
    while (true) {
      const job = dequeueClaudioJob();
      if (!job) break;
      try {
        await runClaudioJob(job);
        finishClaudioJob(job);
      } catch (error) {
        failClaudioJob(job, error instanceof Error ? error.message : String(error));
      }
    }
  } finally {
    state.workerRunning = false;
  }
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
