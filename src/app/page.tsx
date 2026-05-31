import { ensureDailySchedule } from "@/lib/daily-schedule";
import { ensureOnlineRadioProgram } from "@/lib/online-radio";
import { isOnlineRadioMode } from "@/lib/radio-mode";
import { buildRadioProgram } from "@/lib/radio-engine";
import { readWeatherSnapshot } from "@/lib/weather";
import { PlayerShell } from "@/components/player-shell";

/**
 * 首页在服务端预取首屏节目，避免客户端首屏再走一次请求。
 */
export default async function Home() {
  const [{ program, schedule }, weather] = await Promise.all([
    isOnlineRadioMode()
      ? ensureOnlineRadioProgram()
      : Promise.all([buildRadioProgram(), ensureDailySchedule()]).then(([nextProgram, nextSchedule]) => ({
          program: nextProgram,
          schedule: nextSchedule,
        })),
    readWeatherSnapshot().catch(() => null),
  ]);
  return (
    <PlayerShell
      initialProgram={program}
      initialSchedule={schedule}
      initialWeather={weather}
    />
  );
}
