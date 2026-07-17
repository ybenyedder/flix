// ffprobe pass: probe every media_file still stamped probed_at = 0, storing
// container/duration/bitrate/chapters, the full stream list, and embedded
// subtitle rows. Runs a small fixed pool of concurrent probes and reports
// progress through the emit callback the orchestrator threads in.

import path from "path";
import type { Database as DB } from "better-sqlite3";
import { probeFile, ffprobeWasMissing, resetFfprobeMissing, subtitleFormatFor, isBitmapSubtitleCodec, type ProbeResult } from "../ffprobe";
import { createLogger } from "../../logger";
import type { ScanProgress } from "../scanner";

const log = createLogger("scanner");

const PROBE_CONCURRENCY = 4;

function looksSdh(title: string | null): boolean {
  return !!title && /\b(sdh|hearing impaired|cc)\b/i.test(title);
}

function applyProbeResult(db: DB, fileId: number, result: ProbeResult | null): void {
  if (!result) {
    db.prepare("UPDATE media_files SET probed_at = -1 WHERE id = ?").run(fileId);
    return;
  }
  const tx = db.transaction(() => {
    db.prepare("UPDATE media_files SET container = ?, duration = ?, bitrate = ?, chapters = ?, probed_at = ? WHERE id = ?").run(
      result.container,
      result.duration,
      result.bitrate,
      result.chapters.length ? JSON.stringify(result.chapters) : null,
      Date.now(),
      fileId,
    );

    db.prepare("DELETE FROM streams WHERE media_file_id = ?").run(fileId);
    const insStream = db.prepare(
      `INSERT INTO streams (media_file_id, stream_index, type, codec, profile, level, width, height, bit_depth, frame_rate,
        pixel_format, color_transfer, color_primaries, hdr_format, channels, channel_layout, sample_rate, language, title,
        bitrate, is_default, is_forced, attached_pic)
       VALUES (@media_file_id, @stream_index, @type, @codec, @profile, @level, @width, @height, @bit_depth, @frame_rate,
        @pixel_format, @color_transfer, @color_primaries, @hdr_format, @channels, @channel_layout, @sample_rate, @language, @title,
        @bitrate, @is_default, @is_forced, @attached_pic)`,
    );
    for (const s of result.streams) {
      insStream.run({
        media_file_id: fileId,
        stream_index: s.index,
        type: s.type,
        codec: s.codec,
        profile: s.profile,
        level: s.level,
        width: s.width,
        height: s.height,
        bit_depth: s.bitDepth,
        frame_rate: s.frameRate,
        pixel_format: s.pixelFormat,
        color_transfer: s.colorTransfer,
        color_primaries: s.colorPrimaries,
        hdr_format: s.hdrFormat,
        channels: s.channels,
        channel_layout: s.channelLayout,
        sample_rate: s.sampleRate,
        language: s.language,
        title: s.title,
        bitrate: s.bitrate,
        is_default: s.isDefault ? 1 : 0,
        is_forced: s.isForced ? 1 : 0,
        attached_pic: s.attachedPic ? 1 : 0,
      });
    }

    db.prepare("DELETE FROM subtitles WHERE media_file_id = ? AND source = 'embedded'").run(fileId);
    const insSub = db.prepare(
      "INSERT INTO subtitles (media_file_id, stream_index, source, language, title, is_forced, is_sdh, format, is_text) VALUES (?, ?, 'embedded', ?, ?, ?, ?, ?, ?)",
    );
    for (const s of result.streams) {
      if (s.type !== "subtitle") continue;
      insSub.run(fileId, s.index, s.language, s.title, s.isForced ? 1 : 0, looksSdh(s.title) ? 1 : 0, subtitleFormatFor(s.codec), isBitmapSubtitleCodec(s.codec) ? 0 : 1);
    }

    const owner = db.prepare("SELECT movie_id, episode_id FROM media_files WHERE id = ?").get(fileId) as
      | { movie_id: number | null; episode_id: number | null }
      | undefined;
    if (owner?.movie_id) db.prepare("UPDATE movies SET duration = ? WHERE id = ?").run(result.duration, owner.movie_id);
    if (owner?.episode_id) db.prepare("UPDATE episodes SET duration = ? WHERE id = ?").run(result.duration, owner.episode_id);
  });
  tx();
}

export async function runProbePass(db: DB, mediaDir: string, emit: (patch: Partial<ScanProgress>) => void): Promise<void> {
  const pending = db.prepare("SELECT id, filepath FROM media_files WHERE probed_at = 0").all() as { id: number; filepath: string }[];
  const total = pending.length;
  if (!total) return;
  emit({ phase: "probing", probeTotal: total, probed: 0 });

  resetFfprobeMissing(); // a fixed FFPROBE_PATH since the last pass must clear the latch
  let warnedMissingFfprobe = false;
  let cursor = 0;
  let done = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      const row = pending[cursor++];
      const abs = path.join(mediaDir, ...row.filepath.split("/"));
      let result: ProbeResult | null = null;
      try {
        result = await probeFile(abs);
      } catch {
        result = null;
      }
      if (result === null && ffprobeWasMissing()) {
        // The ffprobe BINARY is missing (spawn ENOENT) — a deployment problem,
        // not a broken file: leave probed_at = 0 so the file is retried on the
        // next scan instead of being stamped unprobeable (-1) forever.
        if (!warnedMissingFfprobe) {
          warnedMissingFfprobe = true;
          log.warn("ffprobe binary not found — files left unprobed, will retry on the next scan", { filepath: row.filepath });
        }
      } else {
        try {
          applyProbeResult(db, row.id, result);
        } catch (error) {
          log.warn("failed to store probe result", { filepath: row.filepath, message: error instanceof Error ? error.message : String(error) });
        }
      }
      done++;
      if (done % 5 === 0 || done === total) emit({ probed: done });
    }
  };
  await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, pending.length) }, () => worker()));
  log.info("probe pass complete", { total, probed: done });
}
