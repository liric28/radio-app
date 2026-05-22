import { promises as fs } from "node:fs";
import path from "node:path";
import { dataDir } from "@/lib/paths";

type ChatJobRecord = {
  id: string;
  status: "pending" | "completed" | "failed";
  content?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

const chatJobsPath = path.join(dataDir, "chat-jobs.json");

async function readChatJobs() {
  try {
    const content = await fs.readFile(chatJobsPath, "utf8");
    return JSON.parse(content) as Record<string, ChatJobRecord>;
  } catch {
    return {};
  }
}

async function writeChatJobs(jobs: Record<string, ChatJobRecord>) {
  await fs.writeFile(chatJobsPath, `${JSON.stringify(jobs, null, 2)}\n`, "utf8");
}

export async function createChatJob() {
  const jobs = await readChatJobs();
  const id = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();

  jobs[id] = {
    id,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };

  await writeChatJobs(jobs);
  return jobs[id];
}

export async function completeChatJob(id: string, content: string) {
  const jobs = await readChatJobs();
  const current = jobs[id];
  if (!current) return;

  jobs[id] = {
    ...current,
    status: "completed",
    content,
    updatedAt: Date.now(),
  };

  await writeChatJobs(jobs);
}

export async function failChatJob(id: string, error: string) {
  const jobs = await readChatJobs();
  const current = jobs[id];
  if (!current) return;

  jobs[id] = {
    ...current,
    status: "failed",
    error,
    updatedAt: Date.now(),
  };

  await writeChatJobs(jobs);
}

export async function getChatJob(id: string) {
  const jobs = await readChatJobs();
  return jobs[id] ?? null;
}
