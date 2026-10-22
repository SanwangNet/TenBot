const BUSINESS_TIME_ZONE = "Asia/Shanghai";

export function imageQuotaDayKey(at: number): string {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: BUSINESS_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(at);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
}
