import { ensureDailySchedule } from "@/lib/daily-schedule";
import { buildRadioProgram } from "@/lib/radio-engine";
import { PlayerShell } from "@/components/player-shell";

/**
 * 首页在服务端预取首屏节目，避免客户端首屏再走一次请求。
 */
export default async function Home() {
  const [program, schedule] = await Promise.all([
    buildRadioProgram(),
    ensureDailySchedule(),
  ]);
  return <PlayerShell initialProgram={program} initialSchedule={schedule} />;
}
