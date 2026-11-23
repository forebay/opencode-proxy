const EN_US = "en-US";
const EN_GB = "en-GB";
const MINUTE_MILLISECONDS = 60_000;

export interface Zone {
  readonly offset_minutes: number;
  readonly zone_en_us: string;
  readonly zone_en_gb: string;
}

function partsOf(locale: string, timeZone: string, instant: number): Intl.DateTimeFormatPart[] {
  const format = new Intl.DateTimeFormat(locale, {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    timeZoneName: "short",
  });
  return format.formatToParts(instant);
}

function partValue(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((part) => part.type === type)?.value ?? "";
}

function zoneName(locale: string, timeZone: string, instant: number): string {
  return partValue(partsOf(locale, timeZone, instant), "timeZoneName");
}

function offsetMinutes(timeZone: string, instant: number): number {
  const parts = partsOf(EN_US, timeZone, instant);
  const number = (type: Intl.DateTimeFormatPartTypes): number => Number(partValue(parts, type));
  const local = Date.UTC(number("year"), number("month") - 1, number("day"), number("hour"), number("minute"), number("second"));
  const whole = instant - (instant % 1000);
  return Math.round((local - whole) / MINUTE_MILLISECONDS);
}

/** The machine's zone at `instant`: its offset from UTC and its short names in en-US and en-GB, of which C chooses one. */
export function zoneAt(instant: number): Zone {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return { offset_minutes: offsetMinutes(timeZone, instant), zone_en_us: zoneName(EN_US, timeZone, instant), zone_en_gb: zoneName(EN_GB, timeZone, instant) };
}
