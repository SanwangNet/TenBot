const formatters = new Map<string, Intl.DateTimeFormat>();

export const DEFAULT_BOT_TIME_ZONE = "Asia/Shanghai";

function formatterFor(timeZone: string): Intl.DateTimeFormat {
    let formatter = formatters.get(timeZone);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat("en-US", {
            timeZone,
            calendar: "gregory",
            numberingSystem: "latn",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hourCycle: "h23",
        });
        formatters.set(timeZone, formatter);
    }
    return formatter;
}

export function validateBotTimeZone(value: string | undefined): string {
    const timeZone = value?.trim() || DEFAULT_BOT_TIME_ZONE;
    try {
        const formatter = formatterFor(timeZone);
        formatter.format(new Date(0));
        const canonicalTimeZone = formatter.resolvedOptions().timeZone;
        if (timeZone.toUpperCase() !== "UTC" && !timeZone.includes("/") && canonicalTimeZone !== timeZone) {
            throw new RangeError("Ambiguous time zone abbreviation");
        }
        return canonicalTimeZone;
    } catch {
        throw new Error("BOT_TIME_ZONE must be a valid IANA time zone recognized by Intl.DateTimeFormat");
    }
}

export function formatModelTimestamp(value: Date | number | string, timeZone: string): string {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new RangeError("Invalid model timestamp");
    const parts = Object.fromEntries(formatterFor(timeZone).formatToParts(date).map(({ type, value: part }) => [type, part]));
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export function buildTemporalContext(now: Date, timeZone: string): string {
    return [
        "<temporal_context>",
        `current_time=${formatModelTimestamp(now, timeZone)}`,
        `timezone=${timeZone}`,
        "</temporal_context>",
    ].join("\n");
}
