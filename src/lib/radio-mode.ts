export function isOnlineRadioMode() {
  return (process.env.RADIO_PROGRAM_MODE || "online") === "online";
}
