// Classification phase: decide from a walked file's path whether it is a movie
// or a TV episode, and derive the title/year (or show identity) the upsert
// phase keys on. Pure function over a WalkedVideo — no I/O, no shared state.

import path from "path";
import { parseMovieName } from "../namingMovies";
import { matchEpisodePath, parseShowFolderName, type EpisodeMatch } from "../namingShows";
import { stripExtension } from "../namingCommon";
import type { WalkedVideo } from "./walk";

interface ClassifiedMovie {
  kind: "movie";
  folder: string;
  title: string;
  year: number | null;
}
interface ClassifiedEpisode {
  kind: "episode";
  match: EpisodeMatch;
  showTitle: string;
  showYear: number | null;
}
type Classified = ClassifiedMovie | ClassifiedEpisode;

export function classify(video: WalkedVideo): Classified {
  const match = matchEpisodePath(video.dirParts, video.filename);
  if (match) {
    const showBase = match.showFolder ? path.posix.basename(match.showFolder) : video.filename;
    const { title, year } = parseShowFolderName(showBase);
    return { kind: "episode", match, showTitle: title, showYear: year };
  }

  // Movies grouped by their containing folder (multi-version releases share a
  // row); a loose file with no dedicated folder gets its own pseudo-folder
  // (its own path minus extension) so unrelated root-level movies never collide.
  const folder = video.dirParts.length ? video.dirParts.join("/") : stripExtension(video.rel);
  const folderBase = video.dirParts.length ? video.dirParts[video.dirParts.length - 1] : null;

  const fromFile = parseMovieName(video.filename);
  if (!folderBase) return { kind: "movie", folder, title: fromFile.title, year: fromFile.year };

  const fromFolder = parseMovieName(folderBase);
  if (fromFolder.year) return { kind: "movie", folder, title: fromFolder.title, year: fromFolder.year };
  if (fromFile.year) return { kind: "movie", folder, title: fromFile.title, year: fromFile.year };
  return { kind: "movie", folder, title: fromFolder.title || fromFile.title, year: null };
}
