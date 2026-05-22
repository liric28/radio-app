import { promises as fs } from "node:fs";
import path from "node:path";
import { dataDir } from "@/lib/paths";

const audioRootsPath = path.join(dataDir, "audio-roots.json");

const defaultAudioRoots = ["/Users/lipan/Music/Music/Media/Music"];

function normalizeRoot(rootPath: string) {
  return path.resolve(rootPath);
}

export async function readAllowedAudioRoots() {
  try {
    const content = await fs.readFile(audioRootsPath, "utf8");
    const roots = JSON.parse(content) as string[];

    if (!Array.isArray(roots) || roots.length === 0) {
      return defaultAudioRoots;
    }

    return roots.map(normalizeRoot);
  } catch {
    await writeAllowedAudioRoots(defaultAudioRoots);
    return defaultAudioRoots;
  }
}

export async function writeAllowedAudioRoots(roots: string[]) {
  const normalizedRoots = [...new Set(roots.map(normalizeRoot))];
  await fs.writeFile(audioRootsPath, `${JSON.stringify(normalizedRoots, null, 2)}\n`, "utf8");
}

export async function addAllowedAudioRoot(rootPath: string) {
  const roots = await readAllowedAudioRoots();
  const normalizedRoot = normalizeRoot(rootPath);

  if (roots.includes(normalizedRoot)) {
    return roots;
  }

  const nextRoots = [...roots, normalizedRoot];
  await writeAllowedAudioRoots(nextRoots);
  return nextRoots;
}
