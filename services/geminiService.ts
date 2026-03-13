import Groq from "groq-sdk";
import { SimulationResult, ZoneParams, ACUnit } from "../types";
import { computeFloorArea } from "./geometry";

export const generateAuditReport = async (
  results: SimulationResult,
  zone: ZoneParams,
  acList: ACUnit[],
  locationName: string
): Promise<string> => {
  const apiKey = import.meta.env.VITE_GROQ_API_KEY;
  if (!apiKey) {
    return "API Key not found. Please set VITE_GROQ_API_KEY in your .env file.";
  }

  try {
    const groq = new Groq({ apiKey, dangerouslyAllowBrowser: true });

    const peakLoadKw = (results.peakLoadWatts / 1000).toFixed(2);
    const totalAcKw = (acList.reduce((sum, ac) => sum + ac.ratedCapacityWatts, 0) / 1000).toFixed(2);
    const acDesc = acList.map(ac => `${ac.name} (${ac.ratedCapacityWatts}W)`).join(', ');

    const walls = zone.walls || [];
    const windows = zone.windows || [];
    const wallSummary = walls.map(w => {
      const wallWindows = windows.filter(win => win.wallId === w.id);
      const winArea = wallWindows.reduce((sum, win) => sum + win.areaM2, 0);
      return `${w.direction} (${w.azimuth}°): Length ${w.lengthM}m, Total Win Area ${winArea}m²`;
    }).join('; ');

    const areaM2 = computeFloorArea(walls);

    const prompt = `
      Act as a senior HVAC engineer. Analyze the following office zone heat load calculation:

      **Context:** ${locationName}.
      **Zone:** ${zone.name}, Floor Area ${areaM2.toFixed(1)}m², Ceiling ${zone.ceilingHeightM}m.
      **Top Floor:** ${zone.isTopFloor ? 'Yes' : 'No'}.
      **Wall-wise Area Summary:** ${wallSummary}.
      **AC Units:** [${acDesc}]. Total Rated: ${totalAcKw} kW.

      **Simulation Results:**
      - Peak Heat Load: ${peakLoadKw} kW
      - Peak Time: ${results.peakLoadTime}
      - Max Indoor Temp Reached: ${results.maxTemp.toFixed(1)}°C
      - AC Sufficient: ${results.isSufficient ? 'YES' : 'NO'}

      **Task:**
      1. Evaluate if the equipment scheduling creates specific heat spikes.
      2. Analyze the impact of being on the top floor if applicable.
      3. Is the current AC setup efficient for this load profile?
      4. Suggest improvements for thermal efficiency.

      Keep it professional, concise, and engineering-focused. Return Markdown.
    `;

    const completion = await groq.chat.completions.create({
      model: 'llama3-70b-8192',
      messages: [{ role: 'user', content: prompt }],
    });

    return completion.choices[0]?.message?.content || "No analysis generated.";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Groq API Error:", error);
    return `Failed to generate AI analysis: ${message}`;
  }
};
