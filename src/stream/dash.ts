import type { DashManifest, DashRepresentation } from "./types.js";
import { resolveUrl } from "./hls.js";

function attr(block: string, name: string): string | null {
  const found = new RegExp(`(?:^|\\s)${name}="([^"]+)"`).exec(block);
  return found ? found[1]! : null;
}

function parseDuration(text: string | null): number | null {
  if (!text) return null;
  // ISO 8601 durations: PT1H2M3.5S, PT90S, etc.
  const match = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/.exec(text);
  if (!match) return null;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const seconds = Number(match[4] ?? 0);
  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

function expandTemplate(
  template: string,
  values: Record<string, string | number>,
): string {
  return template.replace(/\$([A-Za-z]+)(?:%0(\d+)d)?\$/g, (_m, name, width) => {
    const value = String(values[name] ?? "");
    if (width) return value.padStart(Number(width), "0");
    return value;
  });
}

/** Parse a DASH MPD (SegmentTemplate and SegmentList; live MPDs rejected by the caller). */
export function parseDash(xml: string, baseUrl: string): DashManifest {
  const durationSeconds = parseDuration(attr(xml, "mediaPresentationDuration"));
  const isDynamic = attr(xml, "type") === "dynamic";

  const representations: DashRepresentation[] = [];
  // Walk AdaptationSets, then Representations inside each.
  const adaptationRe = /<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/g;
  let adaptation: RegExpExecArray | null;
  while ((adaptation = adaptationRe.exec(xml)) !== null) {
    const adaptationAttrs = adaptation[1]!;
    const adaptationBody = adaptation[2]!;
    const adaptationMime = attr(adaptationAttrs, "mimeType");
    const repRe = /<Representation\b([^>]*)>([\s\S]*?)<\/Representation>/g;
    let rep: RegExpExecArray | null;
    while ((rep = repRe.exec(adaptationBody)) !== null) {
      const repAttrs = rep[1]!;
      const repBody = rep[2]!;
      const id = attr(repAttrs, "id");
      const bandwidth = attr(repAttrs, "bandwidth") ? Number(attr(repAttrs, "bandwidth")) : null;
      const width = attr(repAttrs, "width") ? Number(attr(repAttrs, "width")) : null;
      const height = attr(repAttrs, "height") ? Number(attr(repAttrs, "height")) : null;
      const mimeType = attr(repAttrs, "mimeType") ?? adaptationMime;
      const codecs = attr(repAttrs, "codecs");

      let initUrl: string | null = null;
      const initMatch = /<Initialization[^>]*sourceURL="([^"]+)"[^>]*\/>/.exec(repBody)
        ?? /<Initialization[^>]*>([^<]+)<\/Initialization>/.exec(repBody);
      if (initMatch) initUrl = resolveUrl(initMatch[1]!.trim(), baseUrl);

      const baseUrlMatch = /<BaseURL[^>]*>([^<]+)<\/BaseURL>/.exec(repBody);
      const repBase = baseUrlMatch ? resolveUrl(baseUrlMatch[1]!.trim(), baseUrl) : baseUrl;

      const segmentUrls: string[] = [];
      const templateMatch = /<SegmentTemplate\b([^>]*?)(?:\/>|>([\s\S]*?)<\/SegmentTemplate>)/.exec(repBody);
      if (templateMatch) {
        const templateAttrs = templateMatch[1]!;
        const templateBody = templateMatch[2] ?? "";
        const media = attr(templateAttrs, "media");
        const initialization = attr(templateAttrs, "initialization");
        if (initialization && !initUrl) {
          initUrl = resolveUrl(
            expandTemplate(initialization, { RepresentationID: id ?? "", Bandwidth: bandwidth ?? 0 }),
            repBase,
          );
        }
        if (media) {
          const timescale = Number(attr(templateAttrs, "timescale") ?? 1) || 1;
          const duration = Number(attr(templateAttrs, "duration") ?? 0);
          const startNumber = Number(attr(templateAttrs, "startNumber") ?? 1) || 1;
          // SegmentTimeline overrides the simple duration/count math.
          const timelineMatch = /<SegmentTimeline>([\s\S]*?)<\/SegmentTimeline>/.exec(templateBody);
          if (timelineMatch) {
            const sRe = /<S\b([^>]*?)\/>/g;
            let s: RegExpExecArray | null;
            let number = startNumber;
            let time = 0;
            while ((s = sRe.exec(timelineMatch[1]!)) !== null) {
              const sAttrs = s[1]!;
              const t = attr(sAttrs, "t");
              if (t !== null) time = Number(t);
              const d = Number(attr(sAttrs, "d") ?? 0);
              const r = Number(attr(sAttrs, "r") ?? 0);
              for (let k = 0; k <= r; k++) {
                segmentUrls.push(
                  resolveUrl(
                    expandTemplate(media, {
                      Number: number,
                      Time: time,
                      Bandwidth: bandwidth ?? 0,
                      RepresentationID: id ?? "",
                    }),
                    repBase,
                  ),
                );
                number++;
                time += d;
              }
            }
          } else if (duration > 0 && durationSeconds !== null) {
            const segmentSeconds = duration / timescale;
            const count = Math.ceil(durationSeconds / segmentSeconds);
            for (let k = 0; k < count; k++) {
              segmentUrls.push(
                resolveUrl(
                  expandTemplate(media, {
                    Number: startNumber + k,
                    Time: Math.round(k * duration),
                    Bandwidth: bandwidth ?? 0,
                    RepresentationID: id ?? "",
                  }),
                  repBase,
                ),
              );
            }
          }
        }
      } else {
        // SegmentList
        const listMatch = /<SegmentList>([\s\S]*?)<\/SegmentList>/.exec(repBody);
        if (listMatch) {
          const urlRe = /<SegmentURL[^>]*media="([^"]+)"[^>]*\/>/g;
          let urlMatch: RegExpExecArray | null;
          while ((urlMatch = urlRe.exec(listMatch[1]!)) !== null) {
            segmentUrls.push(resolveUrl(urlMatch[1]!, repBase));
          }
        } else if (baseUrlMatch) {
          // Single-file representation.
          segmentUrls.push(repBase);
        }
      }

      representations.push({
        id,
        bandwidth: Number.isFinite(bandwidth) ? bandwidth : null,
        width: Number.isFinite(width) ? width : null,
        height: Number.isFinite(height) ? height : null,
        mimeType,
        codecs,
        segmentUrls,
        initUrl,
      });
    }
  }

  const video = representations
    .filter((r) => (r.mimeType ?? "").startsWith("video") || (r.width !== null && r.height !== null))
    .sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0));
  const audio = representations
    .filter((r) => (r.mimeType ?? "").startsWith("audio"))
    .sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0));

  if (isDynamic) {
    // Live DASH is out of scope for Phase 6; the downloader rejects it.
    return { kind: "dash", durationSeconds, video, audio };
  }
  return { kind: "dash", durationSeconds, video, audio };
}
