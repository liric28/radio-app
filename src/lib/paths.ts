import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * 统一计算项目内的数据目录，避免运行时 cwd 漂移导致读写错位。
 */
export const dataDir = path.resolve(currentDir, "../../data");
