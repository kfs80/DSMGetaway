/**
 * Deterministic offline mock provider for local testing without external API calls.
 */
import crypto from "node:crypto";
import { BaseProvider, makeFare } from "./base.js";

function md5Int(input) {
  const hex = crypto.createHash("md5").update(input).digest("hex").slice(0, 12);
  return parseInt(hex, 16);
}

export class MockProvider extends BaseProvider {
  constructor() {
    super();
    this.name = "mock";
    this.label = "Mock (Offline Test)";
    this.tier = 0;
    this.role = "Offline Test";
    this.isPaid = false;
    this.isEstimate = true;
    this.supportsRoundTrip = true;
  }

  async cheapestNonstop(origin, dest, dateIso, airlines) {
    const h = md5Int(`${origin}${dest}${dateIso}`);
    const route = origin === "DSM" ? dest : origin;
    const g4Only = airlines.length === 1 && airlines[0] === "G4";
    const [y, m, d] = dateIso.split("-").map(Number);
    const pyWd = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;

    if (g4Only && ![0, 3, 4, 6].includes(pyWd)) {
      return makeFare({ price: null, source: this.name, estimate: true });
    }
    if (h % 17 === 0) {
      return makeFare({ price: null, source: this.name, estimate: true });
    }

    const base = g4Only ? 39 : 79;
    const price = base + (h % 160) + (md5Int(route) % 60);
    const airline = airlines[h % airlines.length] || "G4";
    const hour = 6 + (h % 14);
    const min = ["00", "15", "30", "45"][h % 4];
    return makeFare({
      price,
      airline,
      flight: `${airline} ${100 + (h % 900)}`,
      depart_time: `${String(hour).padStart(2, "0")}:${min}`,
      source: this.name,
      estimate: true,
    });
  }

  async cheapestRoundTrip(origin, dest, depIso, retIso, airlines) {
    const h = md5Int(`RT|${origin}|${dest}|${depIso}|${retIso}`);
    if (h % 10 === 0) return null;
    const legacy = airlines.filter((a) => ["UA", "AA", "DL", "AS"].includes(a));
    const airline = legacy[h % legacy.length] || "UA";
    const hour = 6 + (h % 14);
    const min = ["00", "15", "30", "45"][h % 4];
    return makeFare({
      price: 140 + (h % 260),
      airline,
      depart_time: `${String(hour).padStart(2, "0")}:${min}`,
      source: this.name,
      estimate: true,
    });
  }
}
