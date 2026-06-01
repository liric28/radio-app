import { promises as fs } from "node:fs";
import path from "node:path";
import { dataDir } from "@/lib/paths";

const audioRootsPath = path.join(dataDir, "audio-roots.json");

// .env AUDIO_ROOTS 优先，支持逗号分隔多个路径
function getDefaultAudioRoots(): string[] {
  const envRoots = process.env.AUDIO_ROOTS;
  if (envRoots) {
    return envRoots.split(",").map((r) => r.trim()).filter(Boolean);
  }
  return ["/Users/lipan/Music/Music/Media/Music"];
}

function normalizeRoot(rootPath: string) {
  return path.isAbsolute(rootPath) ? rootPath : path.resolve(/* turbopackIgnore: true */ rootPath);
}

export async function readAllowedAudioRoots() {
  try {
    const content = await fs.readFile(audioRootsPath, "utf8");
    const roots = JSON.parse(content) as string[];

    if (!Array.isArray(roots) || roots.length === 0) {
      return getDefaultAudioRoots().map(normalizeRoot);
    }

    return roots.map(normalizeRoot);
  } catch {
    const defaults = getDefaultAudioRoots().map(normalizeRoot);
    await writeAllowedAudioRoots(defaults);
    return defaults;
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
