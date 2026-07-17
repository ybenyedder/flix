// The injectable *arr client: the interface the request lifecycle calls through
// (client.radarrAddMovie(...)) plus the default implementation wired to the real
// Radarr/Sonarr HTTP client. requests.ts owns the mutable `client` binding and
// the __setArrClient test hook that swaps this default for a stub — see
// test/arr-requests.test.ts.

import {
  radarrLookupByTmdbId,
  sonarrLookup,
  radarrQualityProfiles,
  radarrRootFolders,
  sonarrQualityProfiles,
  sonarrRootFolders,
  radarrAddMovie,
  sonarrAddSeries,
  radarrGetMovie,
  radarrDeleteMovie,
  sonarrGetSeries,
  radarrGetMovieByTmdbId,
  sonarrGetSeriesByTvdbId,
  radarrQueue,
  sonarrQueue,
  radarrRemoveQueueItem,
  sonarrRemoveQueueItem,
  radarrSearchMovie,
  sonarrSearchSeries,
  radarrReleaseSearch,
  radarrGrabRelease,
} from "./client";
import { applyBalancedProfile } from "./quality";

export interface ArrClientApi {
  radarrLookupByTmdbId: typeof radarrLookupByTmdbId;
  sonarrLookup: typeof sonarrLookup;
  radarrQualityProfiles: typeof radarrQualityProfiles;
  radarrRootFolders: typeof radarrRootFolders;
  sonarrQualityProfiles: typeof sonarrQualityProfiles;
  sonarrRootFolders: typeof sonarrRootFolders;
  radarrAddMovie: typeof radarrAddMovie;
  sonarrAddSeries: typeof sonarrAddSeries;
  radarrGetMovie: typeof radarrGetMovie;
  radarrDeleteMovie: typeof radarrDeleteMovie;
  sonarrGetSeries: typeof sonarrGetSeries;
  radarrGetMovieByTmdbId: typeof radarrGetMovieByTmdbId;
  sonarrGetSeriesByTvdbId: typeof sonarrGetSeriesByTvdbId;
  radarrQueue: typeof radarrQueue;
  sonarrQueue: typeof sonarrQueue;
  radarrRemoveQueueItem: typeof radarrRemoveQueueItem;
  sonarrRemoveQueueItem: typeof sonarrRemoveQueueItem;
  radarrSearchMovie: typeof radarrSearchMovie;
  sonarrSearchSeries: typeof sonarrSearchSeries;
  radarrReleaseSearch: typeof radarrReleaseSearch;
  radarrGrabRelease: typeof radarrGrabRelease;
  applyBalancedProfile: typeof applyBalancedProfile;
}

export const defaultClient: ArrClientApi = {
  radarrLookupByTmdbId,
  sonarrLookup,
  radarrQualityProfiles,
  radarrRootFolders,
  sonarrQualityProfiles,
  sonarrRootFolders,
  radarrAddMovie,
  sonarrAddSeries,
  radarrGetMovie,
  radarrDeleteMovie,
  sonarrGetSeries,
  radarrGetMovieByTmdbId,
  sonarrGetSeriesByTvdbId,
  radarrQueue,
  sonarrQueue,
  radarrRemoveQueueItem,
  sonarrRemoveQueueItem,
  radarrSearchMovie,
  sonarrSearchSeries,
  radarrReleaseSearch,
  radarrGrabRelease,
  applyBalancedProfile,
};
