#!/bin/bash
# radio-banner.sh — Claudio FM 启动横幅（参考 IMG_0340 风格）
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCHEDULE_FILE="${SCRIPT_DIR}/../data/daily-schedule.json"

# ─── 颜色（ANSI）────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
YELLOW='\033[0;33m'
WHITE='\033[0;37m'
NC='\033[0m'

# ─── 天气 ─────────────────────────────────────────
fetch_weather() {
  local raw
  raw=$(curl -s "wttr.in/Shenzhen?format=%l:%C+%t+%h+%w" \
    -H "Accept-Language: zh-CN" 2>/dev/null) || raw=""
  [[ -z "$raw" ]] && return

  IFS='+' read -r PART TEMP_HUMID_WIND <<< "$raw"
  COND=$(echo "$PART" | sed 's/^[^+]*://' | xargs)
  set -- $TEMP_HUMID_WIND
  TEMP="$1"; HUMID="$2"; WIND="$3"
  WEATHER="${CYAN}${COND}${NC}  ${YELLOW}${TEMP}${NC}  湿度 ${HUMID}  风 ${WIND}"
}

# ─── 歌单打印 ─────────────────────────────────────
print_schedule() {
  local json=$(cat "$SCHEDULE_FILE")

  local blocks_json=$(echo "$json" | python3 -c "
import json,sys
d=json.load(sys.stdin)
out=[]
for b in d.get('blocks',[]):
    p=b.get('period','')
    tracks=[]
    for tr in b.get('tracks',[])[:3]:
        tracks.append({'title':tr.get('title',''),'artist':tr.get('artist','')})
    out.append({'period':p,'tracks':tracks})
print(json.dumps(out))
" 2>/dev/null)

  echo "$blocks_json" | python3 -c '
import json,sys
emoji_map={"morning":"☀","daytime":"☽","evening":"❄","late-night":"🌙"}
time_map={"morning":"06:00 - 12:00","daytime":"12:00 - 18:00","evening":"18:00 - 24:00","late-night":"00:00 - 06:00"}
name_map={"morning":"Morning","daytime":"Afternoon","evening":"Evening","late-night":"Late Night"}
blocks=json.load(sys.stdin)
for b in blocks:
    p=b["period"]
    emoji=emoji_map.get(p,"♪")
    name=name_map.get(p,p)
    trange=time_map.get(p,"")
    label="{0} {1} ({2})".format(emoji,name,trange)
    print("  \u2502  " + label)
    print("  \u2502  " + chr(9472)*55)
    for i,t in enumerate(b["tracks"],1):
        num="%02d" % i
        print("  \u2502   {0}. {1} - {2}".format(num,t["title"],t["artist"]))
    print("")
' 2>/dev/null
}

# ─── 主程序 ─────────────────────────────────────
main() {
  fetch_weather

  # 顶边
  echo ""
  echo -e "  \033[0;37m┌─────────────────────────────────────────────────────────┐\033[0m"
  echo -e "  \033[0;37m│\033[0m"
  echo -e "  \033[0;37m│\033[0m                       \033[0;31m♫ Claudio FM ♫\033[0m                     \033[0;37m│\033[0m"
  echo -e "  \033[0;37m│\033[0m"

  # 天气
  if [[ -n "$WEATHER" ]]; then
    echo -e "  \033[0;37m│\033[0m  $WEATHER\033[0;37m│\033[0m"
  fi

  # 歌单
  print_schedule

  # 底部双线分隔
  echo -e "  \033[0;37m│\033[0m"
  echo -e "  \033[0;37m│\033[0m  \033[0;33m═══════════════════════════════════════════════════════════\033[0m\033[0;37m│\033[0m"
  echo -e "  \033[0;37m│\033[0m  \033[0;32m▶ Now Playing\033[0m: 傍晚归家 · 从旧歌单里捞出最像你的缓慢主旋律          \033[0;37m│\033[0m"
  echo -e "  \033[0;37m│\033[0m  \033[0;33m═══════════════════════════════════════════════════════════\033[0m\033[0;37m│\033[0m"
  echo ""
  echo -e "  \033[0;37m└─────────────────────────────────────────────────────────┘\033[0m"
}

main "$@"