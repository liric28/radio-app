import { promises as fs } from "node:fs";
import path from "node:path";
import type { RadioMemory } from "./types";
import { dataDir } from "./paths";
import { migrateStoredTrackLabels } from "./track-labels";

const memoryPath = path.join(dataDir, "memory.json");

const defaultMemory: RadioMemory = {
  recentTrackIds: [],
  recentProgramTitles: [],
  feedbackBias: {
    calmer: 0,
    familiar: 0,
    fresh: 0,
  },
  lastAction: "init",
  playbackMode: "continuous-random",
};

/**
 * 读取记忆层状态；如果文件还不存在，则初始化默认内容。
 */
export async function readMemory() {
  try {
    const content = await fs.readFile(memoryPath, "utf8");
    const memory = JSON.parse(content) as RadioMemory;
    const migrated = {
      ...memory,
      recentTrackIds: await migrateStoredTrackLabels(memory.recentTrackIds || []),
    };
    if (JSON.stringify(migrated) !== JSON.stringify(memory)) {
      await writeMemory(migrated);
    }
    return migrated;
  } catch {
    await writeMemory(defaultMemory);
    return defaultMemory;
  }
}

/**
 * 将最新记忆持久化到本地 JSON，方便首版直接观察变化。
 */
export async function writeMemory(memory: RadioMemory) {
  await fs.writeFile(memoryPath, `${JSON.stringify(memory, null, 2)}\n`, "utf8");
}
