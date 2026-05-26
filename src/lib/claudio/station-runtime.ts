import type {
  ClaudioJob,
  ClaudioProgramEvent,
  ClaudioStationState,
} from "@/lib/claudio/types";

type Subscriber = (event: ClaudioProgramEvent) => void;

const stationState: ClaudioStationState = {
  programId: null,
  sessionTitle: "",
  tracks: [],
  generationJobs: [],
  jobKeys: new Set<string>(),
  workerRunning: false,
  history: [],
};

const subscribers = new Set<Subscriber>();

export function getClaudioStationState() {
  return stationState;
}

export function subscribeClaudioEvents(subscriber: Subscriber) {
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

export function broadcastClaudioEvent(event: ClaudioProgramEvent) {
  stationState.history.push(event);
  if (stationState.history.length > 100) {
    stationState.history.splice(0, stationState.history.length - 100);
  }
  for (const subscriber of subscribers) subscriber(event);
}

export function enqueueClaudioJob(job: ClaudioJob) {
  if (stationState.jobKeys.has(job.key)) return false;
  stationState.jobKeys.add(job.key);
  stationState.generationJobs.push(job);
  broadcastClaudioEvent({
    type: "job-status",
    key: job.key,
    jobType: job.type,
    status: "queued",
  });
  return true;
}

export function dequeueClaudioJob() {
  const job = stationState.generationJobs.shift() || null;
  if (job) {
    broadcastClaudioEvent({
      type: "job-status",
      key: job.key,
      jobType: job.type,
      status: "running",
    });
  }
  return job;
}

export function finishClaudioJob(job: ClaudioJob) {
  stationState.jobKeys.delete(job.key);
  broadcastClaudioEvent({
    type: "job-status",
    key: job.key,
    jobType: job.type,
    status: "completed",
  });
}

export function failClaudioJob(job: ClaudioJob, error: string) {
  stationState.jobKeys.delete(job.key);
  broadcastClaudioEvent({
    type: "job-status",
    key: job.key,
    jobType: job.type,
    status: "failed",
    error,
  });
}

export function setClaudioProgramContext(input: {
  programId?: string | null;
  sessionTitle?: string;
  tracks?: ClaudioStationState["tracks"];
}) {
  if (input.programId !== undefined) stationState.programId = input.programId;
  if (input.sessionTitle !== undefined) stationState.sessionTitle = input.sessionTitle;
  if (input.tracks !== undefined) stationState.tracks = input.tracks;
}
