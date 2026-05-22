import type { WeatherSnapshot } from "@/lib/types";

function resolveWeatherCity(city?: string) {
  const raw = city || process.env.WEATHER_CITY || "Shenzhen";
  return raw.trim() || "Shenzhen";
}

function normalizeCityForUrl(city: string) {
  return city.replace(/\s+/g, "+");
}

function parseTemperature(raw: string) {
  const matched = raw.match(/-?\d+/);
  return matched ? Number.parseInt(matched[0], 10) : 0;
}

function stripEmojiPrefix(raw: string) {
  return raw.replace(/^[^\p{L}\p{N}]+/u, "").trim();
}

const conditionTranslations: Array<[RegExp, string]> = [
  [/patchy light rain/iu, "零星小雨"],
  [/light rain/iu, "小雨"],
  [/moderate rain/iu, "中雨"],
  [/heavy rain/iu, "大雨"],
  [/patchy rain nearby/iu, "附近有阵雨"],
  [/thundery outbreaks nearby/iu, "附近有雷雨"],
  [/partly cloudy/iu, "多云间晴"],
  [/cloudy/iu, "多云"],
  [/overcast/iu, "阴"],
  [/clear/iu, "晴"],
  [/sunny/iu, "晴"],
  [/mist/iu, "薄雾"],
  [/fog/iu, "有雾"],
];

function toChineseCondition(raw: string) {
  for (const [pattern, text] of conditionTranslations) {
    if (pattern.test(raw)) {
      return text;
    }
  }

  return raw;
}

export function isWeatherQuestion(message: string) {
  const normalized = message.trim().toLowerCase();
  return ["天气", "下雨", "多少度", "冷不冷", "热不热", "weather", "temperature"].some(
    (item) => normalized.includes(item),
  );
}

export function weatherReplyFromSnapshot(snapshot: WeatherSnapshot) {
  const range =
    typeof snapshot.daytimeHighC === "number" && typeof snapshot.daytimeLowC === "number"
      ? `，白天大概 ${snapshot.daytimeLowC} 到 ${snapshot.daytimeHighC} 度`
      : "";
  return `今天 ${snapshot.locationLabel} ${snapshot.conditionText}，现在差不多 ${snapshot.temperatureC} 度${range}。`;
}

export async function readWeatherSnapshot(city?: string): Promise<WeatherSnapshot | null> {
  const targetCity = resolveWeatherCity(city);
  const encodedCity = normalizeCityForUrl(targetCity);
  const response = await fetch(
    `https://wttr.in/${encodedCity}?format=%l:%C+%t`,
    {
      headers: {
        "Accept-Language": "zh-CN",
      },
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new Error(`天气查询失败: ${response.status}`);
  }

  const text = (await response.text()).trim();
  const [locationRaw, rest] = text.split(":");

  if (!rest) {
    return null;
  }

  const [conditionRaw = "", temperatureRaw = ""] = rest.split("+");
  const locationLabel = locationRaw.trim() || targetCity;
  const conditionText = toChineseCondition(stripEmojiPrefix(conditionRaw)) || "天气一般";

  return {
    locationLabel,
    conditionText,
    temperatureC: parseTemperature(temperatureRaw),
  };
}
