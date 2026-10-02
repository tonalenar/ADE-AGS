import { describe, expect, it } from "vitest";

import { describeSchedule } from "../RoutinesPanel";

// Tiene que decir lo mismo que `routines::describe` en Rust: es lo que ve quien usa la
// pantalla y lo que lee el agente en `ccode routines`.
describe("describeSchedule", () => {
  it("cada intervalo", () => {
    expect(describeSchedule({ kind: "every", secs: 1800 })).toBe("a cada 30 min");
    expect(describeSchedule({ kind: "every", secs: 7200 })).toBe("a cada 2 h");
    expect(describeSchedule({ kind: "every", secs: 90 })).toBe("a cada 90 s");
  });

  it("diaria, con y sin días", () => {
    expect(describeSchedule({ kind: "daily", hour: 9, minute: 5, days: [] })).toBe("todo dia às 09:05");
    expect(describeSchedule({ kind: "daily", hour: 9, minute: 0, days: [0, 4] })).toBe("às 09:00 (seg, sex)");
  });

  it("una vez", () => {
    expect(describeSchedule({ kind: "once", at: 1 })).toBe("uma vez");
  });
});
