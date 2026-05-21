import type { SongImportItem } from "@/lib/types";

/**
 * 尝试把文本解析为歌曲导入项；支持 JSON 数组和简单 CSV。
 */
export function parseSongImportText(rawText: string) {
  const text = rawText.trim();

  if (!text) {
    throw new Error("导入内容为空");
  }

  if (text.startsWith("[")) {
    const parsed = JSON.parse(text) as SongImportItem[];
    if (!Array.isArray(parsed)) {
      throw new Error("JSON 导入内容必须是数组");
    }
    return parsed;
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    throw new Error("CSV 至少需要表头和一行数据");
  }

  const headers = lines[0].split(",").map((item) => item.trim());

  return lines.slice(1).map((line) => {
    const values = line.split(",").map((item) => item.trim());
    const entry = Object.fromEntries(
      headers.map((header, index) => [header, values[index] ?? ""]),
    );
    return entry as SongImportItem;
  });
}
