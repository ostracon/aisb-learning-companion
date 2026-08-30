const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

function wallParts(instant: Date, timeZone: string): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
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
    })
      .formatToParts(instant)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

export function toProgrammeDateTimeLocal(instant: string, timeZone = "Europe/London"): string {
  const parts = wallParts(new Date(instant), timeZone);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** Convert an HTML datetime-local value into an unambiguous instant in the programme zone. */
export function fromProgrammeDateTimeLocal(local: string, timeZone = "Europe/London"): string {
  const match = LOCAL_DATE_TIME.exec(local);
  if (!match) throw new Error("Enter a complete date and time");
  const [, year, month, day, hour, minute] = match;
  const desiredWallTime = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
  );
  let candidate = desiredWallTime;

  // Iterating resolves the zone offset without relying on the host computer's zone.
  for (let index = 0; index < 4; index += 1) {
    const parts = wallParts(new Date(candidate), timeZone);
    const representedWallTime = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
    );
    const corrected = desiredWallTime - (representedWallTime - candidate);
    if (corrected === candidate) break;
    candidate = corrected;
  }

  const result = new Date(candidate);
  if (!Number.isFinite(result.getTime()) || toProgrammeDateTimeLocal(result.toISOString(), timeZone) !== local) {
    throw new Error("That local time does not exist in Europe/London");
  }
  return result.toISOString();
}
